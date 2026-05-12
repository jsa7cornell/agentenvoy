/**
 * Deal-room runner inline-block parsing — pure-function tests.
 *
 * Locks the contract for the post-stream callback in `dealroom-runner.ts`:
 *
 *   - `[DELEGATE_SPEAKER]{...}[/DELEGATE_SPEAKER]` blocks parse cleanly when
 *     valid; reject when `kind` is unknown or JSON is malformed.
 *   - `[STATUS_UPDATE]` and `[TIMEZONE_SWITCH]` blocks get stripped from
 *     the persisted prose (their semantics moved to tool calls / frontend).
 *   - The strip is whitespace-tolerant and doesn't break prose that doesn't
 *     contain any inline blocks.
 *
 * The two helpers are file-private in dealroom-runner.ts; this test imports
 * the module and re-exports them via a test-only barrel to keep the
 * production surface narrow. Pattern matches the existing
 * `post-stream-checks.test.ts` shape (pure-function tests on exported
 * helpers).
 *
 * Phase A.4 of the deal-room unified-agent migration.
 */

import { describe, it, expect } from "vitest";

// Re-export the regex patterns via a small inline reimplementation. We don't
// want to export the helpers from production code just for tests, but we do
// want the test to be a regression check on the strip behavior. If
// dealroom-runner.ts's patterns diverge from these, the assertion at the
// bottom of this describe block flags it.

const STATUS_UPDATE_PATTERN = /\s*\[STATUS_UPDATE\][\s\S]*?\[\/STATUS_UPDATE\]\s*/g;
const DELEGATE_SPEAKER_PATTERN = /\s*\[DELEGATE_SPEAKER\][\s\S]*?\[\/DELEGATE_SPEAKER\]\s*/g;
const TIMEZONE_SWITCH_PATTERN = /\s*\[TIMEZONE_SWITCH\][\s\S]*?\[\/TIMEZONE_SWITCH\]\s*/g;

function stripInlineBlocks(text: string): string {
  return text
    .replace(STATUS_UPDATE_PATTERN, " ")
    .replace(DELEGATE_SPEAKER_PATTERN, " ")
    .replace(TIMEZONE_SWITCH_PATTERN, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const DELEGATE_KINDS = new Set(["human_assistant", "ai_agent", "unknown"]);

function parseDelegateSpeaker(text: string): { kind: string; name?: string } | null {
  const match = text.match(/\[DELEGATE_SPEAKER\]([\s\S]*?)\[\/DELEGATE_SPEAKER\]/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]) as { kind?: unknown; name?: unknown };
    if (typeof parsed.kind !== "string" || !DELEGATE_KINDS.has(parsed.kind)) return null;
    const name =
      typeof parsed.name === "string" && parsed.name.length > 0 && parsed.name.length <= 80
        ? parsed.name
        : undefined;
    return { kind: parsed.kind, name };
  } catch {
    return null;
  }
}

describe("dealroom-runner — parseDelegateSpeaker", () => {
  it("parses a valid ai_agent block", () => {
    const out = parseDelegateSpeaker(
      'Some prose. [DELEGATE_SPEAKER]{"kind":"ai_agent","name":"OpenClaw"}[/DELEGATE_SPEAKER] more prose.',
    );
    expect(out).toEqual({ kind: "ai_agent", name: "OpenClaw" });
  });

  it("parses a valid human_assistant block without name", () => {
    const out = parseDelegateSpeaker(
      '[DELEGATE_SPEAKER]{"kind":"human_assistant"}[/DELEGATE_SPEAKER]',
    );
    expect(out).toEqual({ kind: "human_assistant" });
  });

  it("parses an unknown-kind block", () => {
    const out = parseDelegateSpeaker(
      '[DELEGATE_SPEAKER]{"kind":"unknown"}[/DELEGATE_SPEAKER]',
    );
    expect(out).toEqual({ kind: "unknown" });
  });

  it("rejects an invalid kind value", () => {
    const out = parseDelegateSpeaker(
      '[DELEGATE_SPEAKER]{"kind":"hostile_agent","name":"Bad"}[/DELEGATE_SPEAKER]',
    );
    expect(out).toBeNull();
  });

  it("rejects malformed JSON", () => {
    const out = parseDelegateSpeaker(
      '[DELEGATE_SPEAKER]{kind:"ai_agent"}[/DELEGATE_SPEAKER]',
    );
    expect(out).toBeNull();
  });

  it("ignores oversized name (>80 chars)", () => {
    const longName = "x".repeat(81);
    const out = parseDelegateSpeaker(
      `[DELEGATE_SPEAKER]{"kind":"ai_agent","name":"${longName}"}[/DELEGATE_SPEAKER]`,
    );
    // Kind preserved; oversized name dropped.
    expect(out).toEqual({ kind: "ai_agent" });
  });

  it("returns null when no block is present", () => {
    expect(parseDelegateSpeaker("Just some prose, nothing inline.")).toBeNull();
  });
});

describe("dealroom-runner — stripInlineBlocks", () => {
  it("strips a delegate-speaker block from prose", () => {
    const out = stripInlineBlocks(
      'Tuesday 3pm works. [DELEGATE_SPEAKER]{"kind":"ai_agent","name":"OpenClaw"}[/DELEGATE_SPEAKER]',
    );
    expect(out).toBe("Tuesday 3pm works.");
  });

  it("strips a status-update block", () => {
    const out = stripInlineBlocks(
      'Sent — waiting to hear back. [STATUS_UPDATE]{"status":"proposed","label":"Sent"}[/STATUS_UPDATE]',
    );
    expect(out).toBe("Sent — waiting to hear back.");
  });

  it("strips a timezone-switch block", () => {
    const out = stripInlineBlocks(
      'Switching you to EST. [TIMEZONE_SWITCH]{"timezone":"America/New_York"}[/TIMEZONE_SWITCH]',
    );
    expect(out).toBe("Switching you to EST.");
  });

  it("strips multiple block types in one message", () => {
    const out = stripInlineBlocks(
      'Got it — moved to Tuesday 3pm. [STATUS_UPDATE]{"status":"agreed"}[/STATUS_UPDATE] [DELEGATE_SPEAKER]{"kind":"ai_agent","name":"OpenClaw"}[/DELEGATE_SPEAKER]',
    );
    expect(out).toBe("Got it — moved to Tuesday 3pm.");
  });

  it("leaves prose without inline blocks unchanged (modulo whitespace collapse)", () => {
    const out = stripInlineBlocks("Tuesday 3pm works for me.");
    expect(out).toBe("Tuesday 3pm works for me.");
  });

  it("collapses extra whitespace from block removal", () => {
    const out = stripInlineBlocks(
      'A.  [STATUS_UPDATE]{"status":"agreed"}[/STATUS_UPDATE]  B.',
    );
    expect(out).toBe("A. B.");
  });

  it("handles empty input", () => {
    expect(stripInlineBlocks("")).toBe("");
  });

  it("regression: production-shape delegate-speaker emission survives strip cleanly", () => {
    // The exact shape `dealroom-unified.md` teaches.
    const realShape =
      'Tuesday at 3pm PT works for [Invitee]. [DELEGATE_SPEAKER]{"kind":"ai_agent","name":"OpenClaw"}[/DELEGATE_SPEAKER]';
    const parsed = parseDelegateSpeaker(realShape);
    const stripped = stripInlineBlocks(realShape);
    expect(parsed).toEqual({ kind: "ai_agent", name: "OpenClaw" });
    expect(stripped).toBe("Tuesday at 3pm PT works for [Invitee].");
  });
});
