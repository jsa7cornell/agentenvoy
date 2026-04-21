/**
 * Chat-turn intent classifier.
 *
 * Split-pass architecture (proposal 2026-04-21, decided 2026-04-21 pm):
 * runs as a cheap Haiku call ahead of the main Sonnet scheduling pass,
 * so the 256-line channel.md stays untouched. See §1.3, §2.2 of the
 * proposal.
 *
 * Forced-schema via `generateObject` + zod: the model can't "forget" to
 * emit the classification. Failure mode collapses to network/provider
 * errors only, handled by the retry policy (§2.7).
 */

import { generateObject } from "ai";
import { z } from "zod";
import { readFileSync } from "fs";
import { join } from "path";
import { envoyModel } from "@/lib/model";
import {
  CHAT_INTENT_VALUES,
  validateChatIntent,
  type ChatIntent,
  type ChatIntentBlock,
} from "@/lib/intent";

let classifierPlaybook = "";
try {
  classifierPlaybook = readFileSync(
    join(process.cwd(), "src", "agent", "playbooks", "intent-classifier.md"),
    "utf-8",
  );
} catch (e) {
  console.error("Failed to load intent-classifier.md:", e);
}

const CLASSIFIER_MODEL = "claude-haiku-4-5-20251001";
const CLASSIFIER_MAX_TOKENS = 256;
const CLASSIFIER_TIMEOUT_MS = 5000;
const CLASSIFIER_RETRY_BACKOFF_MS = 250;

const chatIntentSchema = z.object({
  kind: z.enum(CHAT_INTENT_VALUES),
  clarifier: z.string().optional(),
  quickReplies: z
    .array(
      z.object({
        label: z.string(),
        intent: z.enum(["schedule", "inquire"]),
      }),
    )
    .max(3)
    .optional(),
});

export interface ClassifyContext {
  /** Current active sessions, formatted as lines for the classifier to see
   *  pronoun referents. Keep short — the classifier is cheap but not free. */
  activeSessionsSummary?: string;
  /** Host's recent prior turn, if any, for trailing-revision cases. */
  priorEnvoyTurn?: string;
}

export interface ClassifyResult {
  intent: ChatIntentBlock;
  latencyMs: number;
  retried: boolean;
  /** What the raw tool-use response contained before validation. Useful
   *  when the validator coerced a malformed response. */
  rawKind: string | null;
}

function buildUserPrompt(message: string, ctx: ClassifyContext): string {
  const parts: string[] = [];
  if (ctx.activeSessionsSummary) {
    parts.push(`Active sessions (for pronoun resolution):\n${ctx.activeSessionsSummary}`);
  }
  if (ctx.priorEnvoyTurn) {
    parts.push(`Your prior turn:\n${ctx.priorEnvoyTurn.slice(0, 300)}`);
  }
  parts.push(`Host's message:\n${message}`);
  return parts.join("\n\n");
}

async function callClassifier(
  message: string,
  ctx: ClassifyContext,
): Promise<{ block: ChatIntentBlock; rawKind: string | null }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CLASSIFIER_TIMEOUT_MS);
  try {
    const { object } = await generateObject({
      model: envoyModel(CLASSIFIER_MODEL),
      maxOutputTokens: CLASSIFIER_MAX_TOKENS,
      system: classifierPlaybook,
      prompt: buildUserPrompt(message, ctx),
      schema: chatIntentSchema,
      abortSignal: controller.signal,
    });
    const rawKind = typeof object?.kind === "string" ? object.kind : null;
    const validated = validateChatIntent(object);
    return { block: validated, rawKind };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Classify a host's turn-level intent. Returns the validated block + the
 * raw kind the model emitted (for telemetry) + latency + whether a retry
 * fired.
 *
 * Retry policy (§2.7): 1 retry on network/5xx/abort, 250ms backoff.
 * On second failure, defaults to `schedule` — matches today's behavior,
 * safe fallback.
 */
export async function classifyChatIntent(
  message: string,
  ctx: ClassifyContext = {},
): Promise<ClassifyResult> {
  const start = Date.now();
  try {
    const { block, rawKind } = await callClassifier(message, ctx);
    return { intent: block, latencyMs: Date.now() - start, retried: false, rawKind };
  } catch (firstErr) {
    console.warn("[intent-classifier] first call failed, retrying once:", firstErr);
    await new Promise((r) => setTimeout(r, CLASSIFIER_RETRY_BACKOFF_MS));
    try {
      const { block, rawKind } = await callClassifier(message, ctx);
      return { intent: block, latencyMs: Date.now() - start, retried: true, rawKind };
    } catch (secondErr) {
      console.error(
        "[intent-classifier] second call failed, falling back to schedule:",
        secondErr,
      );
      return {
        intent: { kind: "schedule" satisfies ChatIntent },
        latencyMs: Date.now() - start,
        retried: true,
        rawKind: null,
      };
    }
  }
}
