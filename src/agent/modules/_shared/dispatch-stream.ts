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
import { narrateFinalizeError } from "@/agent/action-narration";
import { runModule } from "@/agent/modules/runner";
import type {
  IntentSurface,
  MatchResult,
} from "@/agent/modules/types";
import { isBookableAction } from "@/agent/modules/_shared/bookable";

const DEFAULT_HISTORY_LIMIT = 10;

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
  emitStatus: (stage: "thinking" | "executing" | "finalizing") => void;
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
  /** Log prefix for failures. Defaults to `intent`. */
  errorTag?: string;
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

    const result = await runModule({
      surface,
      intent,
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
      if (hasBookable) (additions as Record<string, unknown>).linkKind = "bookable";
    }
    (additions as Record<string, unknown>).moduleGuard = result.moduleGuard;

    // Append linkUrl from successful actions so the host sees shareable URLs.
    const linkUrls = result.actionResults
      .filter((r) => r.success && typeof r.data?.linkUrl === "string")
      .map((r) => r.data!.linkUrl as string);
    let finalText = result.text || "Done.";
    if (linkUrls.length > 0) {
      const trimmed = (result.text || "").trim();
      finalText = trimmed
        ? `${trimmed}\n\n${linkUrls.join("\n\n")}`
        : linkUrls.join("\n\n");
    }

    await prisma.channelMessage.create({
      data: {
        channelId,
        role: "envoy",
        content: finalText,
        metadata: mergeChannelMetadata(null, additions) as Prisma.InputJsonValue,
      },
    });

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
