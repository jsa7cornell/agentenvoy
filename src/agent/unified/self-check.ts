/**
 * Layer 4 — post-stream self-check.
 *
 * After the unified agent streams its response and tool calls are known,
 * runs a single fast-model pass to verify each tool call's key input fields
 * have evidence in the user's message or conversation history.
 *
 * Pattern: same retry-once-on-flag logic as the legacy module runner's
 * postStreamGuards / preEmitChecks, but moved to the post-stream position
 * in the unified pipeline.
 *
 * Uses the "fast" model tier (Haiku) — cheap single-turn verification pass.
 * Not the critical path; runs after the main response is already collected.
 *
 * Returns: { passed: true } or { passed: false, flaggedTools: string[], reason: string }
 * Runner retries the main call once if passed=false (advisory severity only).
 */

import { generateText } from "ai";
import { envoyModel } from "@/lib/model";
import { MODEL_TIERS } from "./model-policy";

export type ToolCallSummary = {
  toolName: string;
  input: Record<string, unknown>;
};

export type SelfCheckResult =
  | { passed: true }
  | { passed: false; flaggedTools: string[]; reason: string };

const SELF_CHECK_MODEL = MODEL_TIERS.fast; // Haiku — cheap verification pass

/**
 * Run a post-stream self-check on the tool calls emitted during a turn.
 *
 * Checks that each write tool's key inputs are evidenced in the conversation.
 * LOAD_* tools are always skipped (read-only, no fabrication risk).
 *
 * @param toolCalls    - Tool calls made during this turn.
 * @param userMessage  - Current user message.
 * @param recentHistory - Recent conversation context (last few turns).
 */
export async function runSelfCheck(
  toolCalls: ToolCallSummary[],
  userMessage: string,
  recentHistory: Array<{ role: "user" | "assistant"; content: string }>,
): Promise<SelfCheckResult> {
  // Skip if no write tools were called.
  const writeToolCalls = toolCalls.filter((tc) => !tc.toolName.startsWith("LOAD_"));
  if (writeToolCalls.length === 0) return { passed: true };

  const toolCallSummary = writeToolCalls
    .map(
      (tc) =>
        `Tool: ${tc.toolName}\nInput: ${JSON.stringify(tc.input, null, 2)}`,
    )
    .join("\n\n");

  const historyContext =
    recentHistory.slice(-4).map((m) => `[${m.role}]: ${m.content}`).join("\n") || "(none)";

  const prompt = `You are a fidelity checker for an AI scheduling assistant.

The assistant just called these tools:

${toolCallSummary}

The user's current message was:
"${userMessage}"

Recent conversation context:
${historyContext}

For each tool call, check: are the key input field VALUES grounded in the user's message or recent context?
- Values that came from a LOAD tool result (IDs, codes, existing rule data) are ALWAYS grounded — do not flag them.
- Values that are clearly made up or not mentioned anywhere are NOT grounded.
- Reasonable inferences from context are grounded (e.g. "video" format inferred from "video call").

## SCHEMA NOTES — these are grounded, do NOT flag
- IDs and codes returned by LOAD_* tools (sessionId, linkCode, rule id, bookable code, etc.) are grounded by definition when they appear in a subsequent tool call. Do NOT flag them as "invented" or "not grounded in the user's message" — they came from tool output, which is a valid grounding source. Only flag IDs/codes that don't match any LOAD result in the conversation.
- guestPicks.{field}: true is grounded when the user offered multiple options for that field (e.g. "Coupa or Konditori"), said "they decide / their call / wherever works", or named the field as the guest's choice.
- Generic activity defaults like "meeting", "call", or "sync" are grounded when the user named only the guest with no specific activity (e.g. "grab an hour with Calle").
- On bookable_link_create, timeStart/timeEnd describe the booking-window during which guests may pick a slot — NOT the session end time. A 60-min session inside a 3–5 PM window correctly uses timeEnd "17:00" (the guest can still start at 3:00, 3:30, or 4:00).
- Defaults filled in from the user's primary link or preferences (e.g. format: "video", duration: 30) are grounded — when the agent omits a field, the system fills it from primary settings.

Respond in this exact format:
PASSED: true
(if all tool calls look grounded)

OR:

PASSED: false
FLAGGED: <comma-separated tool names>
REASON: <one sentence explaining what looks ungrounded>

No other output.`;

  try {
    const { text } = await generateText({
      model: envoyModel(SELF_CHECK_MODEL),
      prompt,
    });

    return parseSelfCheckResponse(text);
  } catch (err) {
    // Self-check failure must never block the turn — log and pass through.
    console.error("[unified-agent] self-check error:", err);
    return { passed: true };
  }
}

function parseSelfCheckResponse(text: string): SelfCheckResult {
  const lines = text.trim().split("\n").map((l) => l.trim());

  const passedLine = lines.find((l) => l.startsWith("PASSED:"));
  if (!passedLine) return { passed: true }; // unparseable → pass through

  const passedValue = passedLine.replace("PASSED:", "").trim().toLowerCase();
  if (passedValue === "true") return { passed: true };

  const flaggedLine = lines.find((l) => l.startsWith("FLAGGED:"));
  const reasonLine = lines.find((l) => l.startsWith("REASON:"));

  const flaggedTools = flaggedLine
    ? flaggedLine.replace("FLAGGED:", "").split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  const reason = reasonLine ? reasonLine.replace("REASON:", "").trim() : "Self-check flagged ungrounded tool input.";

  return { passed: false, flaggedTools, reason };
}
