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
import { readFileSync } from "fs";
import { join } from "path";

// Small cache so we load each playbook at most once per process.
const playbookCache = new Map<string, string>();

function loadPlaybook(relativePath: string): string {
  const cached = playbookCache.get(relativePath);
  if (cached !== undefined) return cached;
  try {
    const text = readFileSync(join(process.cwd(), relativePath), "utf-8");
    playbookCache.set(relativePath, text);
    return text;
  } catch (e) {
    console.error(`[dispatch-handler] Failed to load playbook ${relativePath}:`, e);
    playbookCache.set(relativePath, "");
    return "";
  }
}

let personaPlaybookLoaded = "";
try {
  personaPlaybookLoaded = readFileSync(
    join(process.cwd(), "src", "agent", "playbooks", "persona.md"),
    "utf-8",
  );
} catch (e) {
  console.error("[dispatch-handler] Failed to load persona.md:", e);
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
  const systemBase = `${personaPlaybookLoaded ? personaPlaybookLoaded + "\n\n---\n\n" : ""}${tierPlaybook}`;
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
  const actions = parseActions(fullText);

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
