/**
 * Unit tests for chat-turn intent validator (`validateChatIntent`) and
 * `normalizeChatIntent` — the structural layer of the split-pass chat
 * intent router. Semantic classification (prompt-driven) is exercised by
 * the integration regression suite.
 *
 * Proposal: 2026-04-21_dashboard-chat-intent-router §4.1.
 */

import { describe, it, expect } from "vitest";
import {
  normalizeChatIntent,
  validateChatIntent,
  CHAT_INTENT_VALUES,
} from "@/lib/intent";

describe("normalizeChatIntent", () => {
  it("accepts each valid tier verbatim", () => {
    for (const tier of CHAT_INTENT_VALUES) {
      expect(normalizeChatIntent(tier)).toBe(tier);
    }
  });

  it("rejects case-variant and stray-whitespace forms", () => {
    expect(normalizeChatIntent("Schedule")).toBeNull();
    expect(normalizeChatIntent(" schedule ")).toBeNull();
  });

  it("rejects non-string and out-of-tier inputs", () => {
    expect(normalizeChatIntent(null)).toBeNull();
    expect(normalizeChatIntent(undefined)).toBeNull();
    expect(normalizeChatIntent(42)).toBeNull();
    expect(normalizeChatIntent("book")).toBeNull();
  });
});

describe("validateChatIntent", () => {
  it("passes through a simple schedule block", () => {
    expect(validateChatIntent({ kind: "schedule" })).toEqual({ kind: "schedule" });
  });

  it("passes through profile/rule/inquire kinds without extra fields", () => {
    expect(validateChatIntent({ kind: "profile" })).toEqual({ kind: "profile" });
    expect(validateChatIntent({ kind: "rule" })).toEqual({ kind: "rule" });
    expect(validateChatIntent({ kind: "inquire" })).toEqual({ kind: "inquire" });
  });

  it("strips clarifier/quickReplies from non-unclear kinds", () => {
    const out = validateChatIntent({
      kind: "schedule",
      clarifier: "ignored",
      quickReplies: [{ label: "x", intent: "inquire" }],
    });
    expect(out).toEqual({ kind: "schedule" });
  });

  it("preserves a well-formed unclear block with two valid replies", () => {
    const out = validateChatIntent({
      kind: "unclear",
      clarifier: "Do you want to schedule or inquire?",
      quickReplies: [
        { label: "Schedule 12–5", intent: "schedule" },
        { label: "What are my defaults?", intent: "inquire" },
      ],
    });
    expect(out.kind).toBe("unclear");
    expect(out.clarifier).toBe("Do you want to schedule or inquire?");
    expect(out.quickReplies).toHaveLength(2);
  });

  it("trims whitespace around clarifier text", () => {
    const out = validateChatIntent({
      kind: "unclear",
      clarifier: "  Which one?  ",
    });
    expect(out.clarifier).toBe("Which one?");
  });

  it("falls back to schedule when kind=unclear but clarifier missing/blank", () => {
    expect(validateChatIntent({ kind: "unclear" })).toEqual({ kind: "schedule" });
    expect(validateChatIntent({ kind: "unclear", clarifier: "" })).toEqual({
      kind: "schedule",
    });
    expect(validateChatIntent({ kind: "unclear", clarifier: "   " })).toEqual({
      kind: "schedule",
    });
  });

  it("drops quick-replies targeting stub tiers (profile, rule) per N2", () => {
    const out = validateChatIntent({
      kind: "unclear",
      clarifier: "Which did you mean?",
      quickReplies: [
        { label: "Edit profile", intent: "profile" },
        { label: "Add a rule", intent: "rule" },
        { label: "Book it", intent: "schedule" },
      ],
    });
    expect(out.quickReplies).toEqual([{ label: "Book it", intent: "schedule" }]);
  });

  it("drops malformed quick-replies (missing label, bad intent)", () => {
    const out = validateChatIntent({
      kind: "unclear",
      clarifier: "?",
      quickReplies: [
        { label: "", intent: "schedule" },
        { label: "Book", intent: "bogus" },
        null,
        "string-not-object",
        { label: "OK", intent: "inquire" },
      ],
    });
    expect(out.quickReplies).toEqual([{ label: "OK", intent: "inquire" }]);
  });

  it("caps quick-replies at 3", () => {
    const out = validateChatIntent({
      kind: "unclear",
      clarifier: "?",
      quickReplies: [
        { label: "a", intent: "schedule" },
        { label: "b", intent: "schedule" },
        { label: "c", intent: "inquire" },
        { label: "d", intent: "schedule" },
        { label: "e", intent: "inquire" },
      ],
    });
    expect(out.quickReplies).toHaveLength(3);
    expect(out.quickReplies?.map((r) => r.label)).toEqual(["a", "b", "c"]);
  });

  it("returns unclear-with-generic-clarifier when input is not an object", () => {
    expect(validateChatIntent(null).kind).toBe("unclear");
    expect(validateChatIntent(undefined).kind).toBe("unclear");
    expect(validateChatIntent("schedule").kind).toBe("unclear");
    expect(validateChatIntent(42).kind).toBe("unclear");
  });

  it("returns unclear-with-generic-clarifier when kind is missing or invalid", () => {
    const out1 = validateChatIntent({});
    expect(out1.kind).toBe("unclear");
    expect(typeof out1.clarifier).toBe("string");
    expect(out1.clarifier!.length).toBeGreaterThan(0);

    const out2 = validateChatIntent({ kind: "BOOK_IT" });
    expect(out2.kind).toBe("unclear");
    expect(out2.clarifier).toBe(out1.clarifier);
  });

  it("handles unclear with clarifier but no quickReplies array", () => {
    const out = validateChatIntent({
      kind: "unclear",
      clarifier: "Which one?",
    });
    expect(out.kind).toBe("unclear");
    expect(out.clarifier).toBe("Which one?");
    expect(out.quickReplies).toEqual([]);
  });

  it("handles unclear with non-array quickReplies field", () => {
    const out = validateChatIntent({
      kind: "unclear",
      clarifier: "?",
      quickReplies: "not-an-array",
    });
    expect(out.quickReplies).toEqual([]);
  });
});
