/**
 * Module dispatch + stream helper.
 *
 * Centralizes the per-turn lifecycle around `runModule` for the chat route's
 * dashboard-host branches:
 *   - load conversation history (last N channel messages, sanitized)
 *   - call runModule
 *   - persist envoy turn with moduleGuard + actions + linkKind metadata
 *   - stream the text frame
 *   - on error: narrate fallback + persist + stream
 *
 * Replaces the inline rule-branch wiring (chat/route.ts:456-573 pre-PR2) so
 * the four host-side runModule branches (profile, rule, create_bookable_link,
 * edit_preference→profile|rule, create_link bookable-fallback) share the same
 * lifecycle without copy-paste.
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { sanitizeHistory } from "@/lib/conversation";
import {
  mergeChannelMetadata,
  type ChannelMessageMetadata,
} from "@/lib/channel/metadata-schema";
import {
  narrateFailures,
  narrateFinalizeError,
  narrateTimeout,
} from "@/agent/action-narration";
import { runModule } from "@/agent/modules/runner";
import type {
  IntentSurface,
  MatchResult,
} from "@/agent/modules/types";
import { intentToCluster } from "@/lib/intent";
import { isBookableAction } from "@/agent/modules/_shared/bookable";
import { scopeHistory } from "@/agent/modules/_shared/history-scope";

const DEFAULT_HISTORY_LIMIT = 10;

/**
 * Action-result shape relevant to link-URL resolution. Mirrors the subset of
 * fields `result.actionResults[i]` carries that this helper consumes; kept
 * structural so this file isn't coupled to the runner's full result type.
 */
export interface LinkUrlResolverActionResult {
  success: boolean;
  data?: {
    url?: unknown;
    linkUrl?: unknown;
  } | null;
}

export interface LinkUrlResolution {
  /** Display text after the legacy URL append (only for `data.linkUrl`). */
  displayText: string;
  /**
   * URL to persist to `ChannelMessage.metadata.linkUrl`. Set when ANY
   * successful action result carries a `data.url` or `data.linkUrl`. The
   * feed reads this first to render the link card; the content-regex
   * fallback covers legacy rows persisted before this metadata key existed.
   */
  linkUrl: string | undefined;
}

/**
 * Pure helper extracted from `dispatchModuleAndStream` so the link-URL
 * resolution policy is unit-testable in isolation. See 2026-05-06
 * link-url-via-metadata rework for the why.
 *
 * Policy:
 * - `data.url` (only field `handleCreateLink` returns): persisted to
 *   metadata only. NOT appended to displayText — the feed's link card
 *   already renders it from metadata, so appending duplicates the URL.
 * - `data.linkUrl` (e.g. `handleUpdateAvailabilityRule` bookable case):
 *   persisted to metadata AND appended to displayText, preserving the
 *   legacy text-share behavior for that flow.
 */
export function resolveLinkUrlsForTurn(
  actionResults: ReadonlyArray<LinkUrlResolverActionResult>,
  displayText: string,
): LinkUrlResolution {
  let firstUrl: string | undefined;
  const linkUrlsForDisplay: string[] = [];
  for (const r of actionResults) {
    if (!r.success || !r.data) continue;
    const linkUrl = typeof r.data.linkUrl === "string" ? r.data.linkUrl : undefined;
    const dataUrl = typeof r.data.url === "string" ? r.data.url : undefined;
    const candidate = linkUrl ?? dataUrl;
    if (candidate && firstUrl === undefined) firstUrl = candidate;
    if (linkUrl) linkUrlsForDisplay.push(linkUrl);
  }
  let finalText = displayText;
  if (linkUrlsForDisplay.length > 0) {
    const trimmed = displayText.trim();
    finalText = trimmed
      ? `${trimmed}\n\n${linkUrlsForDisplay.join("\n\n")}`
      : linkUrlsForDisplay.join("\n\n");
  }
  return { displayText: finalText, linkUrl: firstUrl };
}

export interface DispatchModuleAndStreamArgs {
  surface: IntentSurface;
  intent: string;
  channelId: string;
  userId: string;
  userName: string | null;
  userEmail: string;
  message: string;
  userMsgPersist: Promise<unknown>;
  controller: ReadableStreamDefaultController<Uint8Array>;
  encoder: TextEncoder;
  emitStatus: (stage: "thinking" | "executing" | "finalizing" | "retrying") => void;
  /** Matcher output. Defaults to fresh-create deterministic match. */
  matchResult?: MatchResult;
  /** Channel-message lookback for the composer's conversation history. */
  historyLimit?: number;
  /**
   * Pre-built conversation history. When provided, bypasses the internal
   * `prisma.channelMessage.findMany` + `sanitizeHistory`. The schedule path
   * (PR3b-i onward) builds history from a 3-day rolling window keyed off the
   * channel session's `startedAt`; passing the pre-built array preserves that
   * semantic without duplicating the lifecycle logic in this helper.
   */
  conversationHistory?: Array<{ role: string; content: string }>;
  /**
   * Per-turn action-execution timeout in ms (PR3b-iii). When set, the runner
   * races executeActions against this timeout. On timeout, displayText is
   * replaced with `narrateTimeout()` and the late completion is logged.
   * Legacy schedule path uses 15000.
   */
  actionTimeoutMs?: number;
  /**
   * Whether to override displayText with `narrateFailures()` when
   * actionResults contain failures (PR3b-iii). Default: true for event
   * intents that emit actions; harmless no-op when no actions emit.
   */
  narrateFailureResults?: boolean;
  /** Whether to emit the `executing` status frame between thinking and
   *  finalizing. Defaults to true when `actionTimeoutMs` is set (event
   *  intents emit actions and benefit from the frame); false otherwise. */
  emitExecutingStage?: boolean;
  /** Log prefix for failures. Defaults to `intent`. */
  errorTag?: string;
  /**
   * Called by the runner each time it triggers a guard-retry inside the
   * for-loop. Allows the route to emit a `retrying` status frame to the
   * client so the user sees progress during multi-attempt turns.
   * (parity-fix: legacy schedule path emitted `retrying` from the route;
   * the runner retried silently in PR1a.)
   */
  onRetry?: () => void;
}

/**
 * Runs a module via `runModule` and writes the resulting envoy turn to the
 * channel + stream. The caller is responsible for `controller.close()` after
 * this resolves (it does not close the controller on its own — callers
 * sometimes layer additional cleanup).
 */
export async function dispatchModuleAndStream(
  args: DispatchModuleAndStreamArgs,
): Promise<void> {
  const {
    surface,
    intent,
    channelId,
    userId,
    userName,
    userEmail,
    message,
    userMsgPersist,
    controller,
    encoder,
    emitStatus,
    historyLimit = DEFAULT_HISTORY_LIMIT,
    errorTag,
  } = args;
  const tag = errorTag ?? intent;

  try {
    emitStatus("thinking");

    let sanitizedHistory: Array<{ role: string; content: string }> = [];
    if (args.conversationHistory) {
      sanitizedHistory = args.conversationHistory;
    } else if (historyLimit > 0) {
      const recentMessages = await prisma.channelMessage.findMany({
        where: { channelId },
        orderBy: { createdAt: "desc" },
        take: historyLimit,
      });
      recentMessages.reverse();
      const { messages } = sanitizeHistory(
        recentMessages.map((m) => ({ role: m.role, content: m.content })),
        ["envoy", "assistant"],
      );
      sanitizedHistory = messages;
    }

    // Phase-2 wiring of the conversation-history scope detector (proposal
    // 2026-05-05_conversation-history-scope, Rule 28). Runs AFTER the
    // pre-built / fresh-fetch branch resolves so both paths flow through
    // the detector (reviewer §3). On `pivot`, `scopeHistory` returns an
    // empty array — the composer sees no prior context for fresh-contact
    // / closed-task pivots, eliminating the prior-name bleed by construction.
    // On `continue` the array is unchanged.
    const scope = scopeHistory(sanitizedHistory, message);
    sanitizedHistory = scope.messages;

    if (args.emitExecutingStage ?? args.actionTimeoutMs != null) {
      emitStatus("executing");
    }

    // PR-B: Translate the originating intent to its cluster name before
    // calling runModule. The registry is keyed on cluster names post-PR-B.
    // `originatingIntent` carries the pre-cluster name for legacyBucket
    // dual-write in the runner (corpus-continuity, proposal §4.1.1).
    const clusterIntent = intentToCluster(intent);
    const result = await runModule({
      surface,
      intent: clusterIntent,
      // Only pass originatingIntent when it differs from the cluster name
      // (i.e., when an actual translation occurred).
      ...(clusterIntent !== intent ? { originatingIntent: intent } : {}),
      moduleContext: {
        user: { id: userId, name: userName, email: userEmail },
        channel: { id: channelId },
        surface,
      },
      matchResult:
        args.matchResult ?? {
          kind: "deterministic",
          resolved: { freshCreate: true },
        },
      userMessage: message,
      conversationHistory: sanitizedHistory,
      actionTimeoutMs: args.actionTimeoutMs,
      onRetry: args.onRetry
        ? () => {
            args.onRetry!();
            emitStatus("retrying");
          }
        : undefined,
    });

    if (result.kind !== "buffered") {
      throw new Error(`module ${intent} returned non-buffered result`);
    }

    emitStatus("finalizing");

    await userMsgPersist;

    const additions: Partial<ChannelMessageMetadata> = {};
    if (result.parsedActions.length > 0) {
      additions.actions = result.parsedActions.map((a) => ({
        action: a.action,
        params: (a.params ?? {}) as Record<string, unknown>,
      }));
      additions.actionResults = result.parsedActions.map((a, i) => {
        const r = result.actionResults[i];
        if (!r) return { action: a.action, success: false, message: "no_result" };
        return {
          action: a.action,
          success: r.success,
          message: r.message,
          ...(r.data ? { data: r.data } : {}),
        };
      });
      // Tag the link kind so the feed renders the bookable card. Same logic
      // as dispatch-handler.ts:359 pre-PR2.
      const hasBookable = result.parsedActions.some((a) => isBookableAction(a));
      if (hasBookable) {
        (additions as Record<string, unknown>).linkKind = "bookable";
        // B4: populate bookableMeta from the action result so BookableLinkCard
        // can render title + schedule summary. Correlate parsedActions[i] with
        // actionResults[i] (parallel arrays) — getActionData() does not exist;
        // the result data lives in result.actionResults[i].data.
        let bookableMeta: Record<string, unknown> | null = null;
        for (let i = 0; i < result.parsedActions.length; i++) {
          if (!isBookableAction(result.parsedActions[i])) continue;
          const r = result.actionResults[i];
          if (!r?.success || !r.data) continue;
          bookableMeta = {
            title: r.data.bookableName,
            linkUrl: r.data.linkUrl,
            daysOfWeek: r.data.daysOfWeek,
            timeStart: r.data.timeStart,
            timeEnd: r.data.timeEnd,
            durationMinutes: r.data.durationMinutes,
            format: r.data.format,
          };
          break;
        }
        if (bookableMeta) (additions as Record<string, unknown>).bookableMeta = bookableMeta;
      }
    }
    // Stash history-scope telemetry into moduleGuard for debug bundles +
    // post-mortem (proposal §4.2 / Rule 28).
    const moduleGuardWithScope = {
      ...result.moduleGuard,
      historyScope: {
        mode: scope.mode,
        prunedCount: scope.prunedCount,
        closedTasks: scope.closedTasks,
      },
    };
    (additions as Record<string, unknown>).moduleGuard = moduleGuardWithScope;

    // PR3b-iii: narrate failures + timeouts at presentation layer. The
    // runner returns the LLM's draft text; the helper replaces it with
    // a failure-aware narration when actions failed or timed out, mirroring
    // the legacy schedule path's behavior.
    let displayText = result.text || "Done.";
    let overriddenNarration: string | null = null;
    if (result.actionsTimedOut) {
      overriddenNarration = result.text || null;
      displayText = narrateTimeout();
    } else if ((args.narrateFailureResults ?? true) && result.actionResults.length > 0) {
      const failed = result.actionResults.filter((r) => !r.success);
      if (failed.length > 0) {
        overriddenNarration = result.text || null;
        displayText = narrateFailures(
          result.parsedActions,
          result.actionResults,
          result.text || "",
        );
      }
    }
    if (overriddenNarration) {
      (additions as Record<string, unknown>).overriddenNarration = overriddenNarration;
    }

    // Resolve link URL from successful action results for two consumers:
    //   (1) `metadata.linkUrl` — preferred channel for the feed's link card
    //       (read in `feed.tsx`'s MeetLinkCard / BookableLinkCard render path)
    //   (2) legacy `displayText` append — kept for `data.linkUrl` (e.g.
    //       `update_availability_rule`) where the URL is the visible payload of
    //       the turn. NOT done for `data.url` (e.g. `create_link`) — that path
    //       used to double-render the URL (in prose AND in the card graphic);
    //       see 2026-05-06 link-url-metadata-plumbing rework.
    const { displayText: finalText, linkUrl: persistedLinkUrl } =
      resolveLinkUrlsForTurn(result.actionResults, displayText);
    if (persistedLinkUrl) {
      (additions as Record<string, unknown>).linkUrl = persistedLinkUrl;
    }

    // Extract sessionId from the first successful action result that carries
    // one. Used to thread the envoy message to the correct session card and
    // (for multi-action turns) write a system-role summary row.
    const threadId = result.actionResults.find(
      (r) => r.success && typeof r.data?.sessionId === "string",
    )?.data?.sessionId as string | undefined;

    // Persist promptContext snapshot for incident-response / debug bundles.
    // Matches legacy-route.ts:1281-1287. Gated by PROMPT_SNAPSHOT_ENABLED env
    // var (defaults to enabled — set to "false" to suppress).
    if (process.env.PROMPT_SNAPSHOT_ENABLED !== "false") {
      (additions as Record<string, unknown>).promptContext = {
        systemPrompt: result.systemPrompt,
        modelId: "claude-sonnet-4-6",
      };
    }

    await prisma.channelMessage.create({
      data: {
        channelId,
        role: "envoy",
        content: finalText,
        ...(threadId ? { threadId } : {}),
        metadata: mergeChannelMetadata(null, additions) as Prisma.InputJsonValue,
      },
    });

    // System-role summary row for multi-action turns (modify/cancel/etc.).
    // Matches legacy-route.ts:1465-1483. Written after the envoy turn so the
    // feed renders the summary beneath the card.
    if (result.actionResults.length > 1) {
      const visibleSummary = result.actionResults
        .map((r, i) => {
          const action = result.parsedActions[i]?.action ?? "action";
          const symbol = r.success ? "✓" : "✗";
          return `${symbol} ${r.message ?? action}`;
        })
        .join("\n");
      if (visibleSummary) {
        await prisma.channelMessage.create({
          data: { channelId, role: "system", content: visibleSummary },
        });
      }
    }

    controller.enqueue(
      encoder.encode(JSON.stringify({ type: "text", content: finalText }) + "\n"),
    );
  } catch (e) {
    console.error(`[channel/chat] ${tag} module failed:`, e);
    const fallback = narrateFinalizeError();
    try {
      await userMsgPersist;
      await prisma.channelMessage.create({
        data: { channelId, role: "envoy", content: fallback },
      });
      controller.enqueue(
        encoder.encode(JSON.stringify({ type: "text", content: fallback }) + "\n"),
      );
    } catch (persistErr) {
      console.error(`[channel/chat] ${tag} fallback persist failed:`, persistErr);
    }
  }
}
