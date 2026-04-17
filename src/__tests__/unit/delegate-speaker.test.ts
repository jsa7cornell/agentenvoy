/**
 * Unit tests for the DELEGATE_SPEAKER block parser/stripper used by the
 * message route to attach proxy attribution to the most recent guest
 * message. Block shape:
 *   [DELEGATE_SPEAKER]{"kind":"ai_agent","name":"OpenClaw"}[/DELEGATE_SPEAKER]
 *
 * Replicates the helpers from src/app/api/negotiate/message/route.ts —
 * when the helpers graduate to a lib module, these tests point at the
 * right location and stay useful.
 */
import { describe, it, expect } from "vitest";

const VALID_DELEGATE_KINDS = new Set(["human_assistant", "ai_agent", "unknown"]);

function parseDelegateSpeaker(content: string): { kind: string; name?: string } | null {
  const match = content.match(/\[DELEGATE_SPEAKER\](.*?)\[\/DELEGATE_SPEAKER\]/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    if (typeof parsed?.kind !== "string" || !VALID_DELEGATE_KINDS.has(parsed.kind)) return null;
    const name = typeof parsed.name === "string" && parsed.name.length > 0 && parsed.name.length <= 80
      ? parsed.name
      : undefined;
    return { kind: parsed.kind, name };
  } catch {
    return null;
  }
}

function stripDelegateSpeaker(content: string): string {
  return content.replace(/\s*\[DELEGATE_SPEAKER\].*?\[\/DELEGATE_SPEAKER\]\s*/g, "").trim();
}

describe("parseDelegateSpeaker", () => {
  it("parses a well-formed ai_agent block with name", () => {
    const block = '[DELEGATE_SPEAKER]{"kind":"ai_agent","name":"OpenClaw"}[/DELEGATE_SPEAKER]';
    expect(parseDelegateSpeaker(block)).toEqual({ kind: "ai_agent", name: "OpenClaw" });
  });

  it("parses human_assistant with name", () => {
    const block = '[DELEGATE_SPEAKER]{"kind":"human_assistant","name":"Mike\'s EA"}[/DELEGATE_SPEAKER]';
    expect(parseDelegateSpeaker(block)).toEqual({ kind: "human_assistant", name: "Mike's EA" });
  });

  it("accepts unknown kind without a name", () => {
    const block = '[DELEGATE_SPEAKER]{"kind":"unknown"}[/DELEGATE_SPEAKER]';
    expect(parseDelegateSpeaker(block)).toEqual({ kind: "unknown" });
  });

  it("parses when embedded in surrounding text", () => {
    const content = 'Thanks — good to meet you! [DELEGATE_SPEAKER]{"kind":"ai_agent","name":"Claude"}[/DELEGATE_SPEAKER] Let me check availability.';
    expect(parseDelegateSpeaker(content)).toEqual({ kind: "ai_agent", name: "Claude" });
  });

  it("returns null when block absent", () => {
    expect(parseDelegateSpeaker("just plain text")).toBeNull();
  });

  it("rejects invalid kind", () => {
    const block = '[DELEGATE_SPEAKER]{"kind":"robot"}[/DELEGATE_SPEAKER]';
    expect(parseDelegateSpeaker(block)).toBeNull();
  });

  it("rejects missing kind", () => {
    const block = '[DELEGATE_SPEAKER]{"name":"OpenClaw"}[/DELEGATE_SPEAKER]';
    expect(parseDelegateSpeaker(block)).toBeNull();
  });

  it("rejects malformed JSON", () => {
    const block = '[DELEGATE_SPEAKER]{kind:ai_agent}[/DELEGATE_SPEAKER]';
    expect(parseDelegateSpeaker(block)).toBeNull();
  });

  it("drops overly long names while preserving kind", () => {
    const longName = "a".repeat(200);
    const block = `[DELEGATE_SPEAKER]{"kind":"ai_agent","name":"${longName}"}[/DELEGATE_SPEAKER]`;
    expect(parseDelegateSpeaker(block)).toEqual({ kind: "ai_agent" });
  });

  it("ignores non-string name while preserving kind", () => {
    const block = '[DELEGATE_SPEAKER]{"kind":"ai_agent","name":42}[/DELEGATE_SPEAKER]';
    expect(parseDelegateSpeaker(block)).toEqual({ kind: "ai_agent" });
  });
});

describe("stripDelegateSpeaker", () => {
  // The stripper consumes \s* on both sides of the block along with the block
  // itself — matches the existing STATUS_UPDATE convention. This prevents a
  // stray double-space or newline where the block used to be. Consequence:
  // words on either side end up joined without a separator. The LLM is
  // expected to emit the block on its own line, so this collapse is the
  // right outcome in practice.
  it("consumes the block and its surrounding whitespace", () => {
    const content = 'Hi there! [DELEGATE_SPEAKER]{"kind":"ai_agent"}[/DELEGATE_SPEAKER] How can I help?';
    expect(stripDelegateSpeaker(content)).toBe("Hi there!How can I help?");
  });

  it("handles content that is ONLY the block", () => {
    expect(
      stripDelegateSpeaker('[DELEGATE_SPEAKER]{"kind":"unknown"}[/DELEGATE_SPEAKER]'),
    ).toBe("");
  });

  it("is a no-op when the block isn't present", () => {
    expect(stripDelegateSpeaker("just plain text")).toBe("just plain text");
  });

  it("removes multiple adjacent blocks", () => {
    const content = 'A[DELEGATE_SPEAKER]{"kind":"ai_agent"}[/DELEGATE_SPEAKER]B[DELEGATE_SPEAKER]{"kind":"human_assistant"}[/DELEGATE_SPEAKER]C';
    expect(stripDelegateSpeaker(content)).toBe("ABC");
  });

  it("handles block on its own line (the recommended emission style)", () => {
    const content = 'Hi there!\n\n[DELEGATE_SPEAKER]{"kind":"ai_agent"}[/DELEGATE_SPEAKER]\n\nHow can I help?';
    expect(stripDelegateSpeaker(content)).toBe("Hi there!How can I help?");
  });
});
