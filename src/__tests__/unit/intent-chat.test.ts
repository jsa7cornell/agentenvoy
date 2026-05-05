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
  normalizeGuestChatIntent,
  normalizeHostChatIntent,
  validateChatIntent,
  CHAT_INTENT_VALUES,
  HOST_CHAT_INTENT_VALUES,
} from "@/lib/intent";
import {
  looksFabricated,
  pickClosedSetClarifier,
} from "@/agent/intent-classifier";

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

// ---------------------------------------------------------------------------
// Schema-amendment / closed-set clarifier fallback helpers.
// Proposal 2026-04-22 §9.3.2.
// ---------------------------------------------------------------------------

describe("looksFabricated", () => {
  it("flags the classic Failure-C 'as a meeting / unavailable' binary", () => {
    expect(
      looksFabricated(
        "Did you want to schedule a bike ride as a meeting, or are you letting me know you're unavailable for a bike ride?",
      ),
    ).toBe(true);
  });

  it("flags 'schedule or …rule' dead-end binaries", () => {
    expect(
      looksFabricated(
        "Do you want to schedule that or add it as an availability rule?",
      ),
    ).toBe(true);
  });

  it("does NOT flag ordinary clarifiers", () => {
    expect(looksFabricated("Which meeting do you want to move to Tuesday?")).toBe(false);
    expect(looksFabricated("Who's the bike ride with, and when?")).toBe(false);
  });
});

describe("pickClosedSetClarifier", () => {
  it("returns the no-context option when no active sessions and no prior turn", () => {
    const s = pickClosedSetClarifier({});
    expect(s).toMatch(/need more info/i);
  });

  it("returns the meet-with option when active sessions exist", () => {
    const s = pickClosedSetClarifier({ activeSessionsSummary: "- Untitled (guest: Bob)" });
    expect(s).toMatch(/meet with/i);
  });

  it("returns the profile-or-rule option when prior envoy turn mentions defaults", () => {
    const s = pickClosedSetClarifier({
      priorEnvoyTurn: "Want me to update your default duration?",
      activeSessionsSummary: "- Untitled (guest: Bob)",
    });
    expect(s).toMatch(/default/i);
  });
});

// ---------------------------------------------------------------------------
// Server-side fallback behavior when the classifier would return `unclear`
// with a missing or fabricated clarifier. These tests exercise the validator
// + substitution pattern as it's applied inside callClassifier(): we pass
// the post-substitution object through validateChatIntent and confirm the
// unclear intent survives with one of the closed-set strings.
// ---------------------------------------------------------------------------

describe("unclear + missing/fabricated clarifier → closed-set fallback", () => {
  it("server-side fallback preserves kind=unclear with a closed-set clarifier (empty context)", () => {
    const substituted = {
      kind: "unclear",
      clarifier: pickClosedSetClarifier({}),
    };
    const out = validateChatIntent(substituted);
    expect(out.kind).toBe("unclear");
    expect(out.clarifier).toMatch(/need more info/i);
  });

  it("server-side fallback preserves kind=unclear with meet-with clarifier (active sessions)", () => {
    const ctx = { activeSessionsSummary: "- Untitled (guest: Bob)" };
    const substituted = {
      kind: "unclear",
      clarifier: pickClosedSetClarifier(ctx),
    };
    const out = validateChatIntent(substituted);
    expect(out.kind).toBe("unclear");
    expect(out.clarifier).toMatch(/meet with/i);
  });

  it("server-side fallback preserves kind=unclear with profile/rule clarifier (prior envoy mentions defaults)", () => {
    const ctx = {
      priorEnvoyTurn: "Want me to update your default duration?",
      activeSessionsSummary: "- Untitled (guest: Bob)",
    };
    const substituted = {
      kind: "unclear",
      clarifier: pickClosedSetClarifier(ctx),
    };
    const out = validateChatIntent(substituted);
    expect(out.kind).toBe("unclear");
    expect(out.clarifier).toMatch(/default/i);
  });
});

// ---------------------------------------------------------------------------
// Phase 5 PR 3 (CODEBASE-CLEANUP §10) — host-side intent extension.
// Pure data-structure / type-level change; classifier behavior is unchanged
// in PR 3 (PR 4 introduces the role-aware schema).
// ---------------------------------------------------------------------------

describe("HOST_CHAT_INTENT_VALUES (Phase 5 PR 3 + chat-decisioning-layer-redesign PR1)", () => {
  it("contains exactly the 8 host-side values in order (PR1 split create_link → create/modify/cancel; create_bookable_link added)", () => {
    expect([...HOST_CHAT_INTENT_VALUES]).toEqual([
      "edit_preference",
      "create_bookable_link",
      "create_link",
      "modify_link",
      "cancel_link",
      "query_calendar",
      "query_event",
      "chat",
    ]);
    expect(HOST_CHAT_INTENT_VALUES).toHaveLength(8);
  });

  it("every host value normalizes via the full-union normalizeChatIntent", () => {
    for (const v of HOST_CHAT_INTENT_VALUES) {
      expect(normalizeChatIntent(v)).toBe(v);
    }
  });

  it("every host value normalizes via normalizeHostChatIntent", () => {
    for (const v of HOST_CHAT_INTENT_VALUES) {
      expect(normalizeHostChatIntent(v)).toBe(v);
    }
  });

  it("every host value is rejected by normalizeGuestChatIntent", () => {
    for (const v of HOST_CHAT_INTENT_VALUES) {
      expect(normalizeGuestChatIntent(v)).toBeNull();
    }
  });

  it("every guest value normalizes via normalizeGuestChatIntent and is rejected by normalizeHostChatIntent", () => {
    for (const v of CHAT_INTENT_VALUES) {
      expect(normalizeGuestChatIntent(v)).toBe(v);
      expect(normalizeHostChatIntent(v)).toBeNull();
    }
  });

  it("guest and host sets are disjoint (combined size = guest+host)", () => {
    const combined = new Set<string>([
      ...CHAT_INTENT_VALUES,
      ...HOST_CHAT_INTENT_VALUES,
    ]);
    expect(combined.size).toBe(
      CHAT_INTENT_VALUES.length + HOST_CHAT_INTENT_VALUES.length,
    );
  });

  it("validateChatIntent passes host values through the default branch", () => {
    expect(validateChatIntent({ kind: "edit_preference" })).toEqual({
      kind: "edit_preference",
    });
    expect(validateChatIntent({ kind: "create_link" })).toEqual({
      kind: "create_link",
    });
    expect(validateChatIntent({ kind: "query_calendar" })).toEqual({
      kind: "query_calendar",
    });
    expect(validateChatIntent({ kind: "query_event" })).toEqual({
      kind: "query_event",
    });
    expect(validateChatIntent({ kind: "chat" })).toEqual({ kind: "chat" });
  });

  it("validateChatIntent strips clarifier/quickReplies/emoji from host kinds (default-branch behavior)", () => {
    const out = validateChatIntent({
      kind: "edit_preference",
      clarifier: "ignored",
      quickReplies: [{ label: "x", intent: "schedule" }],
      emoji: "👍",
    });
    expect(out).toEqual({ kind: "edit_preference" });
  });

  it("normalizeChatIntent rejects unknown values that resemble host intents", () => {
    expect(normalizeChatIntent("EDIT_PREFERENCE")).toBeNull();
    expect(normalizeChatIntent("preferences")).toBeNull();
    expect(normalizeChatIntent("createLink")).toBeNull();
  });
});
