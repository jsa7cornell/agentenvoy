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
import { loadPlaybook, voicePlaybook } from "./playbooks/index";

/**
 * Detect the Office Hours **create** intent inside an LLM-emitted action.
 *
 * Shape produced by `rule.md`'s ladder (see playbooks/rule.md, examples
 * "Create an Office Hours link" / "Create an office hours link for 30-min
 * video calls on Tuesdays"):
 *
 *   { action: "update_availability_rule",
 *     params: { operation: "add", rule: { action: "office_hours", ... } } }
 *
 * We intercept ONLY the `add` case for `office_hours` — `update` /
 * `remove` / `rename_general` and non-Office-Hours rule actions
 * (`block` / `allow` / `buffer` / `prefer` / `limit` / `location` /
 * `no_in_person`) still flow through `actions.ts` unchanged. The
 * `action.params.rule.action === "office_hours"` discriminator is
 * sufficient — see the brief §7.3.
 *
 * Vocabulary discipline: `r.action === "office_hours"` is the snake-case
 * **wire keyword** for the **Office Hours** feature (capitalized in copy).
 * It is unrelated to `User.preferences.explicit.businessHoursStart` /
 * `businessHoursEnd` (the host's daily window — "Business hours") which
 * is touched only by `handleUpdateBusinessHours` and is NOT in scope here.
 */
export function isOfficeHoursAddAction(action: ActionRequest): boolean {
  if (action.action !== "update_availability_rule") return false;
  const params = action.params as Record<string, unknown>;
  if (params.operation !== "add") return false;
  const rule = params.rule as Record<string, unknown> | undefined;
  if (!rule) return false;
  return rule.action === "office_hours";
}

/**
 * Project an LLM-emitted office_hours rule onto the `OfficeHoursProposal`
 * shape consumed by the confirmation card/sheet. Defensive against partial
 * LLM payloads — fields the LLM omitted are filled with sensible defaults.
 */
export interface OfficeHoursProposalPayload {
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

export function projectProposal(action: ActionRequest): OfficeHoursProposalPayload {
  const params = action.params as Record<string, unknown>;
  const rule = (params.rule as Record<string, unknown> | undefined) ?? {};
  const officeHours = (rule.officeHours as Record<string, unknown> | undefined) ?? {};

  const titleRaw =
    (typeof officeHours.name === "string" && officeHours.name.trim()) ||
    (typeof officeHours.title === "string" && officeHours.title.trim()) ||
    "Office Hours";
  const formatRaw = officeHours.format;
  const format: OfficeHoursProposalPayload["format"] =
    formatRaw === "phone" || formatRaw === "in-person" ? formatRaw : "video";
  const durRaw = officeHours.durationMinutes;
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
    take: 10,
  });
  history.reverse();
  const { messages, warnings } = sanitizeHistory(
    history.map((m) => ({ role: m.role, content: m.content })),
    ["envoy", "assistant"],
  );
  if (warnings.length > 0) {
    console.warn(`[dispatch-handler:${tier}] history sanitized | userId=${userId} | ${warnings.join("; ")}`);
  }
  // Ensure the latest message is represented — sanitizeHistory drops items
  // that don't meet the alternating rule. Defensive: if somehow nothing
  // ended up in `messages`, fall back to a single user entry.
  const finalMessages = messages.length > 0
    ? messages
    : [{ role: "user" as const, content: userMessage }];

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

  // ── Office Hours create-flow interception (Phase 1 PR 5) ────────────────
  // When the LLM emits `update_availability_rule` with operation:"add" and
  // rule.action:"office_hours", we DO NOT execute the rule write here.
  // Instead we persist a `system` ChannelMessage with `metadata.kind ===
  // "rule_proposal"` carrying the proposed payload; the feed renders that
  // as a desktop card or mobile bottom sheet, and the host commits via
  // POST /api/availability-rules/confirm. Mirrors the existing
  // gcal_update_proposal pattern (actions.ts:447 / feed.tsx:1293).
  //
  // Non-Office-Hours rule actions (block / allow / buffer / location /
  // remove / update / rename_general) and all other action kinds still
  // flow through executeActions unchanged. The `office_hours` keyword is
  // the snake-case wire identifier for the **Office Hours** feature; it
  // is unrelated to the host's "Business hours" window (`businessHoursStart`
  // / `businessHoursEnd`), which is touched only by `handleUpdateBusinessHours`.
  const interceptedProposals: Array<{ action: ActionRequest; payload: OfficeHoursProposalPayload }> = [];
  const actions: ActionRequest[] = [];
  for (const a of allActions) {
    if (isOfficeHoursAddAction(a)) {
      interceptedProposals.push({ action: a, payload: projectProposal(a) });
    } else {
      actions.push(a);
    }
  }

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

  // For each intercepted Office Hours proposal, persist a `system`
  // ChannelMessage that carries the parsed-but-not-yet-written rule. The
  // feed renders this as a confirmation card (desktop) or sheet (mobile).
  // We must persist the user message first (await `userMsgPersist`) so
  // the proposal row appears AFTER it in the channel timeline.
  if (interceptedProposals.length > 0) {
    await userMsgPersist;
    let channel = await prisma.channel.findUnique({ where: { userId } });
    if (!channel) channel = await prisma.channel.create({ data: { userId } });
    for (const { payload } of interceptedProposals) {
      await prisma.channelMessage.create({
        data: {
          channelId: channel.id,
          role: "system",
          content: `Envoy is proposing a new Office Hours link · ${payload.title}`,
          metadata: {
            kind: "rule_proposal",
            ruleAction: "office_hours",
            proposal: payload as unknown as Prisma.InputJsonValue,
          } as Prisma.InputJsonValue,
        },
      });
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

  // When an Office Hours `add` was intercepted, the LLM text is typically
  // "Your X link is ready — I'll share the URL once it saves." which is
  // misleading at the proposal stage (the rule hasn't been written yet).
  // Replace it with a proposal-stage prompt matching the mockup copy
  // (mobile-v2.html §2). Keep the original narration available on the
  // metadata for replay/observability.
  if (interceptedProposals.length > 0) {
    overriddenNarration = displayText || overriddenNarration;
    displayText =
      "Sounds great. Here's what I'm setting up — review and tap \"Looks good\" to create it:";
  }

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
  }
  // Record intercepted proposals on the envoy turn's metadata for
  // observability + replay. The actual rule write happens later when the
  // host taps "Looks good" on the card/sheet.
  if (interceptedProposals.length > 0) {
    const existingActions = additions.actions ?? [];
    const existingResults = additions.actionResults ?? [];
    additions.actions = [
      ...existingActions,
      ...interceptedProposals.map(({ action }) => ({
        action: action.action,
        params: (action.params ?? {}) as Record<string, unknown>,
      })),
    ];
    additions.actionResults = [
      ...existingResults,
      ...interceptedProposals.map(({ action }) => ({
        action: action.action,
        success: true,
        message: "proposal_persisted_awaiting_host_confirmation",
        data: { intercepted: true, kind: "rule_proposal" },
      })),
    ];
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
