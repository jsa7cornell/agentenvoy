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
import { envoyModel } from "@/lib/model";
import {
  CHAT_INTENT_VALUES,
  HOST_CHAT_INTENT_VALUES,
  validateChatIntent,
  type ChatIntent,
  type ChatIntentBlock,
  // Source of truth for the 7-value host intent enum (closed set per
  // PLAYBOOK Rule 19d). `hostChatIntentSchema` below picks values up via
  // `z.enum(HOST_CHAT_INTENT_VALUES)`, so adding a host intent in
  // `lib/intent.ts` automatically extends the classifier surface — no
  // edits needed here.
  type HostChatIntent,
} from "@/lib/intent";
import { recordSpan } from "@/lib/langfuse";
import { hostClassifierPlaybook as loadHostClassifierPlaybook } from "./runtime-prompts/index";

const CLASSIFIER_MODEL = "claude-haiku-4-5-20251001";
const CLASSIFIER_MAX_TOKENS = 256;
const CLASSIFIER_TIMEOUT_MS = 5000;
const CLASSIFIER_RETRY_BACKOFF_MS = 250;

const guestChatIntentSchema = z.object({
  kind: z.enum(CHAT_INTENT_VALUES),
  clarifier: z.string().optional(),
  quickReplies: z
    .array(
      z.object({
        label: z.string(),
        intent: z.enum(["schedule", "inquire"]),
      }),
    )
    .optional(),
  emoji: z.string().optional(),
});

const hostChatIntentSchema = z.object({
  kind: z.enum(HOST_CHAT_INTENT_VALUES),
});

export interface ClassifyContext {
  /** Current active sessions, formatted as lines for the classifier to see
   *  pronoun referents. Keep short — the classifier is cheap but not free. */
  activeSessionsSummary?: string;
  /** Host's recent prior turn, if any, for trailing-revision cases. */
  priorEnvoyTurn?: string;
  /** Deterministic echo detector (src/lib/echo-detect.ts) has flagged the
   *  current host message as a near-verbatim copy of a recent envoy reply.
   *  Playbook rule: when set, classifier picks `schedule`. Proposal §4.2
   *  rule 3 / §4.4. */
  echoFlag?: boolean;
}

export interface ClassifyResult {
  intent: ChatIntentBlock;
  latencyMs: number;
  retried: boolean;
  /** What the raw tool-use response contained before validation. Useful
   *  when the validator coerced a malformed response. */
  rawKind: string | null;
  /** Server detected that Haiku's `clarifier` looked fabricated (Failure C
   *  patterns from §2.3) or was missing — substituted a closed-set fallback.
   *  Surfaced so telemetry can observe the rate. */
  fabricationDetected: boolean;
}

/**
 * Detect obvious-fabrication patterns from Failure C (§2.3). Conservative —
 * we only flag the specific shapes we've seen Haiku produce when forced to
 * fill the `clarifier` slot with nothing useful to say. False positives here
 * just swap one clarifier for a closed-set fallback, which is strictly
 * better copy, but we still keep the patterns narrow so genuine clarifiers
 * survive.
 */
export function looksFabricated(clarifier: string): boolean {
  const s = clarifier.toLowerCase();
  // "Did you want to schedule X as a meeting, or are you letting me know
  // you're unavailable…" — the exact Failure-C shape.
  if (s.includes("as a meeting") && s.includes("unavailable")) return true;
  // "Do you want to schedule [that] or add an availability rule…" — the other
  // observed dead-end binary (schedule-vs-rule) that v1 can't even route to.
  // Matches both "schedule or" and "schedule that or" (Haiku variant).
  if (/schedule\b.{0,20}\bor\b/.test(s) && s.includes("rule")) return true;
  if (/schedule\b.{0,20}\bor\b/.test(s) && s.includes("availability")) return true;
  return false;
}

const FALLBACK_NO_CONTEXT =
  "I need more info — could you say more about what you'd like to do?";
const FALLBACK_WITH_SESSIONS =
  "Tell me who you'd like to meet with and when.";
const FALLBACK_PROFILE_OR_RULE =
  "Want me to schedule something, update a rule, or change a default?";

/**
 * Server-side closed-set clarifier fallback (proposal §9.3.2). Called when
 * Haiku returns `kind: "unclear"` with no clarifier OR with a clarifier that
 * matches the Failure-C fabrication patterns. Substitutes one of three
 * short, honest clarifiers chosen from context.
 */
export function pickClosedSetClarifier(ctx: ClassifyContext): string {
  const priorMentionsProfileOrRule =
    typeof ctx.priorEnvoyTurn === "string" &&
    /(default|profile|rule|availability|working hours|phone|zoom)/i.test(
      ctx.priorEnvoyTurn,
    );
  if (priorMentionsProfileOrRule) return FALLBACK_PROFILE_OR_RULE;
  const hasActive =
    typeof ctx.activeSessionsSummary === "string" &&
    ctx.activeSessionsSummary.trim().length > 0;
  if (hasActive) return FALLBACK_WITH_SESSIONS;
  return FALLBACK_NO_CONTEXT;
}

function buildUserPrompt(message: string, ctx: ClassifyContext): string {
  const parts: string[] = [];
  if (ctx.activeSessionsSummary) {
    parts.push(`Active sessions (for pronoun resolution):\n${ctx.activeSessionsSummary}`);
  }
  if (ctx.priorEnvoyTurn) {
    parts.push(`Your prior turn:\n${ctx.priorEnvoyTurn.slice(0, 300)}`);
  }
  const echoMarker = ctx.echoFlag ? " [ECHO_OF_PRIOR_ENVOY]" : "";
  parts.push(`Host's message:${echoMarker}\n${message}`);
  return parts.join("\n\n");
}

async function callClassifier(
  message: string,
  ctx: ClassifyContext,
  role: "host" | "guest",
): Promise<{ block: ChatIntentBlock; rawKind: string | null; rawClarifier: string | null }> {
  const playbook = role === "host" ? loadHostClassifierPlaybook() : "";
  const schema = role === "host" ? hostChatIntentSchema : guestChatIntentSchema;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CLASSIFIER_TIMEOUT_MS);
  try {
    // Langfuse instrumentation (Phase 5 PR-1): wrap the LLM call so dev-time
    // traces capture intent classification. No-op when LANGFUSE_ENABLED !==
    // "true"; production sees zero overhead. See src/lib/langfuse.ts.
    const { object } = await recordSpan(
      "intent-classifier.classify",
      () =>
        generateObject({
          model: envoyModel(CLASSIFIER_MODEL),
          maxOutputTokens: CLASSIFIER_MAX_TOKENS,
          system: playbook,
          prompt: buildUserPrompt(message, ctx),
          schema,
          abortSignal: controller.signal,
        }),
      {
        model: CLASSIFIER_MODEL,
        role,
        hasActiveSessions: !!ctx.activeSessionsSummary,
        hasPriorTurn: !!ctx.priorEnvoyTurn,
        echoFlag: !!ctx.echoFlag,
      },
    );
    const rawKind = typeof object?.kind === "string" ? object.kind : null;

    if (role === "host") {
      // Host emits { kind } only — no clarifier / quickReplies / emoji.
      // Fabrication detection / closed-set substitution is guest-only
      // (depends on the `unclear` tier, which is not in the host enum).
      const validated = validateChatIntent(object);
      return { block: validated, rawKind, rawClarifier: null };
    }

    const rawClarifier =
      typeof (object as { clarifier?: unknown })?.clarifier === "string"
        ? ((object as { clarifier?: string }).clarifier ?? null)
        : null;
    // Schema-amendment (proposal §9.3.2): if Haiku returned `unclear` with
    // either no clarifier or a fabricated-looking one, substitute a
    // closed-set clarifier BEFORE validation — otherwise the validator's
    // "unclear without clarifier → schedule" fallback triggers and we lose
    // the unclear intent entirely.
    let input: unknown = object;
    if (
      rawKind === "unclear" &&
      (!rawClarifier ||
        !rawClarifier.trim() ||
        looksFabricated(rawClarifier))
    ) {
      input = {
        ...(object as Record<string, unknown>),
        clarifier: pickClosedSetClarifier(ctx),
      };
    }
    const validated = validateChatIntent(input);
    return { block: validated, rawKind, rawClarifier };
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
  role: "host" | "guest" = "guest",
): Promise<ClassifyResult> {
  const start = Date.now();
  const fabricatedFrom = (rawClarifier: string | null, rawKind: string | null) =>
    rawKind === "unclear" &&
    ((typeof rawClarifier === "string" && rawClarifier.trim().length > 0 && looksFabricated(rawClarifier)) ||
      !rawClarifier ||
      !rawClarifier.trim());
  try {
    const { block, rawKind, rawClarifier } = await callClassifier(message, ctx, role);
    return {
      intent: block,
      latencyMs: Date.now() - start,
      retried: false,
      rawKind,
      fabricationDetected: fabricatedFrom(rawClarifier, rawKind),
    };
  } catch (firstErr) {
    console.warn("[intent-classifier] first call failed, retrying once:", firstErr);
    await new Promise((r) => setTimeout(r, CLASSIFIER_RETRY_BACKOFF_MS));
    try {
      const { block, rawKind, rawClarifier } = await callClassifier(message, ctx, role);
      return {
        intent: block,
        latencyMs: Date.now() - start,
        retried: true,
        rawKind,
        fabricationDetected: fabricatedFrom(rawClarifier, rawKind),
      };
    } catch (secondErr) {
      const fallbackKind: ChatIntent =
        role === "host"
          ? ("chat" satisfies HostChatIntent)
          : ("schedule" satisfies ChatIntent);
      console.error(
        `[intent-classifier] second call failed, falling back to ${fallbackKind}:`,
        secondErr,
      );
      return {
        intent: { kind: fallbackKind },
        latencyMs: Date.now() - start,
        retried: true,
        rawKind: null,
        fabricationDetected: false,
      };
    }
  }
}
