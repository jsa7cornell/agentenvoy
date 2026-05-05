/**
 * Shared dispatch handler for intent tiers that don't need the full
 * channel.md scheduling context — profile and rule. Factored here
 * (Proposal 3, N2 fold) so the two tiers share streaming + persistence
 * + controller lifecycle and only differ in the playbook they load.
 *
 * Each tier runs against a NARROWER playbook (profile.md / rule.md)
 * with access to a small allowed-action set and emits a shorter
 * progress taxonomy: `thinking → executing → finalizing`. No
 * `scanning-calendar` or `scoring` frame — the LLM doesn't reason
 * about slots here.
 *
 * Buffer-mode invariant preserved: the final `text` frame is emitted
 * in one shot after all actions resolve.
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { generateText } from "ai";
import { envoyModel } from "@/lib/model";
import { sanitizeHistory } from "@/lib/conversation";
import { mergeChannelMetadata } from "@/lib/channel/metadata-schema";
import type { ChannelMessageMetadata } from "@/lib/channel/metadata-schema";
import {
  parseActions,
  executeActions,
  stripActionBlocks,
  type ActionRequest,
  type ActionResult,
} from "@/agent/actions";
import { narrateFailures, narrateTimeout, narrateFinalizeError } from "@/agent/action-narration";
import { loadPlaybook, voicePlaybook } from "./runtime-prompts/index";

/**
 * Detect the Bookable Link **create** intent inside an LLM-emitted action.
 *
 * Shape produced by `rule.md`'s ladder (see runtime-prompts/composers/calendar-rule-composer.md, examples
 * "Create a Bookable Link" / "Create a bookable link for 30-min
 * video calls on Tuesdays"):
 *
 *   { action: "update_availability_rule",
 *     params: { operation: "add", rule: { action: "bookable", ... } } }
 *
 * We intercept ONLY the `add` case for `bookable` — `update` /
 * `remove` / `rename_general` and non-Bookable rule actions
 * (`block` / `allow` / `buffer` / `prefer` / `limit` / `location` /
 * `no_in_person`) still flow through `actions.ts` unchanged. The
 * `action.params.rule.action === "bookable"` discriminator is
 * sufficient — see the brief §7.3.
 *
 * Vocabulary discipline: `r.action === "bookable"` is the snake-case
 * **wire keyword** for the **Bookable Link** feature (capitalized in copy).
 * It is unrelated to `User.preferences.explicit.businessHoursStart` /
 * `businessHoursEnd` (the host's daily window — "Business hours") which
 * is touched only by `handleUpdateBusinessHours` and is NOT in scope here.
 */
export function isBookableAction(action: ActionRequest): boolean {
  if (action.action !== "update_availability_rule") return false;
  const params = action.params as Record<string, unknown>;
  if (params.operation !== "add") return false;
  const rule = params.rule as Record<string, unknown> | undefined;
  if (!rule) return false;
  return rule.action === "bookable";
}

/**
 * Project an LLM-emitted bookable rule onto the `BookableLinkProposalPayload`
 * shape consumed by the confirmation card/sheet. Defensive against partial
 * LLM payloads — fields the LLM omitted are filled with sensible defaults.
 */
export interface BookableLinkProposalPayload {
  originalText: string;
  title: string;
  format: "video" | "phone" | "in-person";
  durationMinutes: number;
  daysOfWeek: number[];
  timeStart: string;
  timeEnd: string;
  effectiveDate?: string;
  expiryDate?: string;
}

/** @deprecated use BookableLinkProposalPayload. Alias kept for import compatibility. */
export type OfficeHoursProposalPayload = BookableLinkProposalPayload;

export function projectProposal(action: ActionRequest): BookableLinkProposalPayload {
  const params = action.params as Record<string, unknown>;
  const rule = (params.rule as Record<string, unknown> | undefined) ?? {};
  const bookableData = (rule.bookable as Record<string, unknown> | undefined) ?? {};

  const titleRaw =
    (typeof bookableData.name === "string" && bookableData.name.trim()) ||
    (typeof bookableData.title === "string" && bookableData.title.trim()) ||
    "Drop-in Hours";
  const formatRaw = bookableData.format;
  const format: BookableLinkProposalPayload["format"] =
    formatRaw === "phone" || formatRaw === "in-person" ? formatRaw : "video";
  const durRaw = bookableData.durationMinutes;
  const durationMinutes =
    typeof durRaw === "number" && [15, 20, 30, 45, 60, 90].includes(durRaw) ? durRaw : 30;

  const days = Array.isArray(rule.daysOfWeek)
    ? (rule.daysOfWeek as unknown[]).filter(
        (d): d is number => typeof d === "number" && d >= 0 && d <= 6,
      )
    : [0, 1, 2, 3, 4, 5, 6];

  const timeStart =
    typeof rule.timeStart === "string" && /^\d{2}:\d{2}$/.test(rule.timeStart)
      ? rule.timeStart
      : "09:00";
  const timeEnd =
    typeof rule.timeEnd === "string" && /^\d{2}:\d{2}$/.test(rule.timeEnd)
      ? rule.timeEnd
      : "17:00";

  const today = new Date().toISOString().slice(0, 10);
  const effectiveDate =
    typeof rule.effectiveDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(rule.effectiveDate)
      ? rule.effectiveDate
      : today;
  const expiryDate =
    typeof rule.expiryDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(rule.expiryDate)
      ? rule.expiryDate
      : undefined;

  return {
    originalText: typeof rule.originalText === "string" ? rule.originalText : "",
    title: titleRaw,
    format,
    durationMinutes,
    daysOfWeek:
      days.length > 0 ? Array.from(new Set(days)).sort((a, b) => a - b) : [0, 1, 2, 3, 4, 5, 6],
    timeStart,
    timeEnd,
    effectiveDate,
    expiryDate,
  };
}


const ACTION_TIMEOUT_MS = 15_000;

export type DispatchTier = "profile" | "rule";

export interface DispatchArgs {
  tier: DispatchTier;
  playbookRelativePath: string;
  userId: string;
  userName: string | null;
  channelId: string;
  userMessage: string;
  /** Already-queued persist of the user message. Awaited before we write. */
  userMsgPersist: Promise<unknown>;
  /** Stream writer — the dispatch path emits a single `text` frame at end. */
  controller: ReadableStreamDefaultController<Uint8Array>;
  encoder: TextEncoder;
  /** Profile-gap hints to inject into the system prompt (profile tier only). */
  profileGapHints?: string[];
  /** Additional context lines (e.g., calibration status). */
  contextLines?: string[];
  /** Status-frame emitter. Callers wire this into their progress pipeline. */
  emitStatus: (stage: "thinking" | "executing" | "finalizing") => void;
  /** Model ID override. Defaults to Sonnet — same as schedule path. */
  modelId?: string;
  /** How many prior channel messages to load. Defaults to 10. Use a smaller
   *  value (e.g. 4) for fresh-creation intents where prior history is noise. */
  historyLimit?: number;
}

/**
 * Run a dispatch handler end-to-end: build context → LLM call → parse
 * actions → execute → finalize text → emit frame → persist.
 *
 * Returns the final text (useful for tests). Callers close the controller
 * themselves after this resolves so they can layer additional cleanup.
 */
export async function runDispatchHandler(args: DispatchArgs): Promise<string> {
  const {
    tier,
    playbookRelativePath,
    userId,
    userName,
    channelId,
    userMessage,
    userMsgPersist,
    controller,
    encoder,
    profileGapHints,
    contextLines,
    emitStatus,
    modelId = "claude-sonnet-4-6",
    historyLimit = 10,
  } = args;

  const tierPlaybook = loadPlaybook(playbookRelativePath);
  const personaText = voicePlaybook();
  const systemBase = `${personaText ? personaText + "\n\n---\n\n" : ""}${tierPlaybook}`;
  const contextParts: string[] = [];
  contextParts.push(`User: ${userName || "User"}`);
  if (contextLines && contextLines.length > 0) {
    contextParts.push(...contextLines);
  }
  if (tier === "profile" && profileGapHints && profileGapHints.length > 0) {
    contextParts.push(
      [
        "Profile gaps:",
        ...profileGapHints.map((h) => `- ${h}`),
        "",
        "These are opportunities, not blockers. Weave them into the turn only if they fit naturally; never lecture the user.",
        "Never save a value that the host mentions in passing — always require an explicit confirmation turn from the host before calling any profile-write action.",
        "Profile writes must reflect the host's confirmed intent, not a parsed mention.",
      ].join("\n"),
    );
  }

  // Load short chat history for the tier — just enough for the LLM to
  // handle follow-ups ("yes, save that"). 10 messages is plenty; we don't
  // need the 3-day rolling window the schedule path uses.
  const history = await prisma.channelMessage.findMany({
    where: { channelId },
    orderBy: { createdAt: "desc" },
    take: historyLimit,
  });
  history.reverse();
  const { messages, warnings } = sanitizeHistory(
    history.map((m) => ({ role: m.role, content: m.content })),
    ["envoy", "assistant"],
  );
  if (warnings.length > 0) {
    console.warn(`[dispatch-handler:${tier}] history sanitized | userId=${userId} | ${warnings.join("; ")}`);
  }
  // Ensure the current user message is always the last entry. Two failure
  // modes: (a) history is empty → use fallback; (b) userMsgPersist hasn't
  // resolved before findMany ran, so the current message isn't in DB yet and
  // the history ends with an envoy/assistant turn — the model would then
  // generate a continuation of that turn rather than responding to the user.
  const lastMsg = messages[messages.length - 1];
  const currentUserEntry = { role: "user" as const, content: userMessage };
  let finalMessages: typeof messages;
  if (messages.length === 0) {
    finalMessages = [currentUserEntry];
  } else if (lastMsg?.role === "user" && lastMsg?.content === userMessage) {
    finalMessages = messages; // already ends with the current message
  } else {
    finalMessages = [...messages, currentUserEntry];
  }

  const system = systemBase + "\n\nCONTEXT:\n" + contextParts.join("\n");

  emitStatus("thinking");
  let first;
  try {
    first = await generateText({
      model: envoyModel(modelId),
      maxOutputTokens: 800,
      system,
      messages: finalMessages,
    });
  } catch (e) {
    console.error(`[dispatch-handler:${tier}] generateText error:`, e);
    const fallback = narrateFinalizeError();
    await userMsgPersist;
    await prisma.channelMessage.create({
      data: { channelId, role: "envoy", content: fallback },
    });
    controller.enqueue(
      encoder.encode(JSON.stringify({ type: "text", content: fallback }) + "\n"),
    );
    return fallback;
  }

  const fullText = first.text;
  const allActions = parseActions(fullText);

  // Bookable Link create flow: as of the 2026-05-03 chat-driven narration
  // reshape (proposal `2026-05-03_recurring-and-office-hours-widgets` §3.8),
  // bookable actions now flow through executeActions like every other
  // rule action. The host iterates via natural-language chat
  // ("actually 45 min" / "also Thursdays") with the composer emitting
  // `update_availability_rule` patches per turn. The rule lives on the
  // Event Links page; the chat thread is pure prose narration.
  //
  // Pre-2026-05-03: a `bookable` (then `office_hours`) `add` action was
  // intercepted and persisted as a `kind: "rule_proposal"` system message
  // that mounted RuleConfirmCard (desktop) / RuleConfirmSheet (mobile). The
  // host confirmed via POST /api/availability-rules/confirm before the rule
  // was written. That propose-then-confirm flow is retired; the
  // confirm endpoint stays alive for any in-flight rule_proposal rows
  // that predate the deploy.
  const actions: ActionRequest[] = allActions;

  let actionResults: ActionResult[] = [];
  let timedOut = false;
  if (actions.length > 0) {
    emitStatus("executing");
    const execPromise = executeActions(actions, userId, {});
    const timeoutPromise = new Promise<"__TIMEOUT__">((resolve) =>
      setTimeout(() => resolve("__TIMEOUT__"), ACTION_TIMEOUT_MS),
    );
    const raced = await Promise.race([execPromise, timeoutPromise]);
    if (raced === "__TIMEOUT__") {
      timedOut = true;
      execPromise
        .then((r) =>
          console.warn(
            `[dispatch-handler:${tier}] late action completion user=${userId} results=${r
              .map((x) => (x.success ? "ok" : "fail"))
              .join(",")}`,
          ),
        )
        .catch((e) => console.error(`[dispatch-handler:${tier}] late action error user=${userId}:`, e));
    } else {
      actionResults = raced;
    }
  }

  emitStatus("finalizing");

  let displayText = stripActionBlocks(fullText);
  displayText = displayText.replace(/```agentenvoy-action\s*\n?[\s\S]*?\n?```/g, "").trim();

  let overriddenNarration: string | null = null;
  if (timedOut) {
    overriddenNarration = displayText || null;
    displayText = narrateTimeout();
  } else {
    const failed = actionResults.filter((r) => !r.success);
    if (failed.length > 0) {
      overriddenNarration = displayText || null;
      displayText = narrateFailures(actions, actionResults, displayText);
    }
  }

  // The 2026-05-03 chat-driven reshape removed the office-hours
  // proposal-stage narration override. The LLM's narration (per the
  // calendar-rule-composer narration discipline) IS the host-visible
  // response — no card, no "Sounds great. Here's what I'm setting up..."
  // intercept. The handler executes the rule write directly and the
  // composer's prose carries the full picture.

  const additions: Partial<ChannelMessageMetadata> = {};
  if (actions.length > 0) {
    additions.actions = actions.map((a) => ({
      action: a.action,
      params: (a.params ?? {}) as Record<string, unknown>,
    }));
    additions.actionResults = actions.map((a, i) => {
      const r = actionResults[i];
      if (!r) return { action: a.action, success: false, message: "timed_out" };
      return {
        action: a.action,
        success: r.success,
        message: r.message,
        ...(r.data ? { data: r.data } : {}),
      };
    });
    // Tag the link kind so the feed can annotate the card.
    const hasBookable = actions.some((a) => isBookableAction(a));
    if (hasBookable) (additions as Record<string, unknown>).linkKind = "bookable";
  }
  const envoyMetadata = mergeChannelMetadata(
    overriddenNarration ? { overriddenNarration } : null,
    additions,
  );

  await userMsgPersist;

  // Append any linkUrl returned from successful actions (e.g. office-hours
  // rule creation / rename_general) so the host sees the shareable URL in
  // the confirmation. Per reusable-links proposal §Gap 2.
  const linkUrls = actionResults
    .filter((r) => r.success && typeof r.data?.linkUrl === "string")
    .map((r) => r.data!.linkUrl as string);
  let textWithLinks = displayText || "Done.";
  if (linkUrls.length > 0) {
    const suffix = linkUrls.map((u) => `\n\n${u}`).join("");
    textWithLinks = (displayText || "") + suffix;
    textWithLinks = textWithLinks.trim() || linkUrls.join("\n\n");
  }
  const finalText = textWithLinks;
  await prisma.channelMessage.create({
    data: {
      channelId,
      role: "envoy",
      content: finalText,
      metadata: envoyMetadata as Prisma.InputJsonValue,
    },
  });

  controller.enqueue(
    encoder.encode(JSON.stringify({ type: "text", content: finalText }) + "\n"),
  );
  return finalText;
}

// Re-export so route.ts can import both the handler and the arg-types
// from one module.
export type { ActionRequest, ActionResult };
