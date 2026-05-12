/**
 * Grounding-check fixture suite — verifies the per-tool grounding declarations
 * in grounding-check.ts gate as expected against representative user messages.
 *
 * Refactored 2026-05-07 (UA refactor — UNIFIEDAGENT.md). The legacy 60-fixture
 * suite tested declarations for tools that have since been renamed or retired.
 *
 * Extended 2026-05-12 (grounding-check-evidence-scope-redesign proposal,
 * decided 2026-05-12). Adds 15 fixtures across 4 categories:
 *   1. Bare-confirmation passes (recentThread scope unblocks) — 4 fixtures
 *   2. F18-protection preserved (fabrications still block) — 4 fixtures
 *   3. Value-match upgrades (catches what regex missed) — 4 fixtures
 *   4. Edge cases (stale history, missing LOAD, no prior turn) — 3 fixtures
 *
 * Signature: runGroundingCheck(toolName, toolInput, { currentUserMessage, recentThread?, thisTurnToolResults? }).
 */
import { describe, it, expect } from "vitest";
import {
  runGroundingCheck,
  type GroundingCheckContext,
  type LoadResultShape,
} from "@/agent/unified/grounding-check";

/** Helper to build a context with just the current message (today's default shape). */
function ctxNow(currentUserMessage: string): GroundingCheckContext {
  return { currentUserMessage };
}

/** Helper to build a context with recent-thread context. */
function ctxThread(
  currentUserMessage: string,
  priorUserTurn?: string,
  priorEnvoyTurn?: string,
): GroundingCheckContext {
  return {
    currentUserMessage,
    recentThread: { priorUserTurn, priorEnvoyTurn },
  };
}

/** Helper to build a context with this-turn tool results. */
function ctxLoaded(
  currentUserMessage: string,
  thisTurnToolResults: LoadResultShape[],
  recentThread?: { priorUserTurn?: string; priorEnvoyTurn?: string },
): GroundingCheckContext {
  return {
    currentUserMessage,
    recentThread,
    thisTurnToolResults,
  };
}

// ===========================================================================
// EXISTING FIXTURES (preserved from prior suite, signature-updated)
// ===========================================================================

// ---------------------------------------------------------------------------
// session_cancel — strict (irreversible session deletion)
// ---------------------------------------------------------------------------

describe("session_cancel (strict)", () => {
  it("passes when sessionId is present AND in this-turn LOAD results", () => {
    const r = runGroundingCheck(
      "session_cancel",
      { sessionId: "ses_abc123" },
      ctxLoaded(
        "cancel my meeting with Susan",
        [{ toolName: "LOAD_active_sessions", result: { sessions: [{ id: "ses_abc123", inviteeName: "Susan" }] } }],
      ),
    );
    expect(r.ok).toBe(true);
  });

  it("fails strictly when sessionId is missing", () => {
    const r = runGroundingCheck("session_cancel", {}, ctxNow("cancel my meeting"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.severity).toBe("strict");
  });
});

// ---------------------------------------------------------------------------
// session_archive_bulk — strict, requires bulk language (currentMessage scope)
// ---------------------------------------------------------------------------

describe("session_archive_bulk (strict)", () => {
  it("passes when user said 'archive all'", () => {
    const r = runGroundingCheck(
      "session_archive_bulk",
      { filter: "all" },
      ctxNow("archive all my old sessions"),
    );
    expect(r.ok).toBe(true);
  });

  it("fails strictly with no bulk language", () => {
    const r = runGroundingCheck(
      "session_archive_bulk",
      { filter: "all" },
      ctxNow("what is my schedule?"),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.severity).toBe("strict");
  });
});

// ---------------------------------------------------------------------------
// rule_remove — strict, requires id from LOAD with value-match (PR-A upgrade)
// ---------------------------------------------------------------------------

describe("rule_remove (strict)", () => {
  it("passes when id is present AND matches a LOAD_preferences result", () => {
    const r = runGroundingCheck(
      "rule_remove",
      { id: "rule_xyz12345" },
      ctxLoaded(
        "remove my Wednesday block",
        [{ toolName: "LOAD_preferences", result: { rules: [{ id: "rule_xyz12345", label: "Wednesday block" }] } }],
      ),
    );
    expect(r.ok).toBe(true);
  });

  it("fails strictly when id is missing", () => {
    const r = runGroundingCheck("rule_remove", {}, ctxNow("remove the rule"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.severity).toBe("strict");
  });
});

// ---------------------------------------------------------------------------
// session_hold_slot — strict on sessionId, advisory on slotStart
// ---------------------------------------------------------------------------

describe("session_hold_slot (strict)", () => {
  it("passes with sessionId in LOAD results + time-bearing user message", () => {
    const r = runGroundingCheck(
      "session_hold_slot",
      { sessionId: "ses_abc", slotStart: "2026-05-10T14:00:00-07:00", slotEnd: "2026-05-10T15:00:00-07:00" },
      ctxLoaded(
        "hold 2pm Tuesday for Susan",
        [{ toolName: "LOAD_active_sessions", result: { sessions: [{ id: "ses_abc", inviteeName: "Susan" }] } }],
      ),
    );
    expect(r.ok).toBe(true);
  });

  it("fails strict when sessionId is missing", () => {
    const r = runGroundingCheck(
      "session_hold_slot",
      { slotStart: "2026-05-10T14:00:00-07:00", slotEnd: "2026-05-10T15:00:00-07:00" },
      ctxNow("hold 2pm Tuesday for Susan"),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.severity).toBe("strict");
  });
});

// ---------------------------------------------------------------------------
// prefs_update_timezone — strict, requires explicit tz language (currentMessage)
// ---------------------------------------------------------------------------

describe("prefs_update_timezone (strict)", () => {
  it("passes when user mentioned timezone-related language", () => {
    const r = runGroundingCheck(
      "prefs_update_timezone",
      { timezone: "Europe/Berlin" },
      ctxNow("I moved to Berlin — set my timezone"),
    );
    expect(r.ok).toBe(true);
  });

  it("fails strictly without tz language", () => {
    const r = runGroundingCheck(
      "prefs_update_timezone",
      { timezone: "Europe/Berlin" },
      ctxNow("schedule a meeting tomorrow"),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.severity).toBe("strict");
  });
});

// ---------------------------------------------------------------------------
// primary_link_update — strict, no specific field gate
// ---------------------------------------------------------------------------

describe("primary_link_update (strict)", () => {
  it("passes regardless of fields (no field-level gate)", () => {
    const r = runGroundingCheck(
      "primary_link_update",
      { duration: 45 },
      ctxNow("make my primary link 45 minutes"),
    );
    expect(r.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// bookable_link_create — advisory, name/purpose grounding
// ---------------------------------------------------------------------------

describe("bookable_link_create (advisory)", () => {
  it("passes when user described the bookable link's purpose", () => {
    const r = runGroundingCheck(
      "bookable_link_create",
      { name: "Music Lessons", format: "video", durationMinutes: 60 },
      ctxNow("create a recurring music lessons bookable link"),
    );
    expect(r.ok).toBe(true);
  });

  it("passes for office hours phrasing", () => {
    const r = runGroundingCheck(
      "bookable_link_create",
      { name: "Office Hours", format: "video", durationMinutes: 30 },
      ctxNow("set up an office hours link"),
    );
    expect(r.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// session_update_time / knowledge_write — advisory pattern checks
// ---------------------------------------------------------------------------

describe("session_update_time (advisory)", () => {
  it("passes when user said a time", () => {
    const r = runGroundingCheck(
      "session_update_time",
      { sessionId: "ses_abc", dateTime: "2026-05-10T14:00:00-07:00" },
      ctxNow("move it to Tuesday at 2pm"),
    );
    expect(r.ok).toBe(true);
  });
});

describe("knowledge_write (advisory)", () => {
  it("passes for first-person facts", () => {
    const r = runGroundingCheck(
      "knowledge_write",
      { persistent: "I prefer morning meetings" },
      ctxNow("remember I prefer morning meetings"),
    );
    expect(r.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tools without declarations — runGroundingCheck returns ok:true (no gate)
// ---------------------------------------------------------------------------

describe("undeclared tools pass through", () => {
  it("personal_link_archive has no declaration → ok", () => {
    const r = runGroundingCheck(
      "personal_link_archive",
      { code: "abc12345" },
      ctxNow("archive Susan's link"),
    );
    expect(r.ok).toBe(true);
  });

  it("bookable_link_archive has no declaration → ok", () => {
    const r = runGroundingCheck(
      "bookable_link_archive",
      { id: "rule_abc12345" },
      ctxNow("archive my office hours link"),
    );
    expect(r.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// personal_link_create — advisory, light inviteeName grounding
// ---------------------------------------------------------------------------

describe("personal_link_create (advisory) — currentMessage path", () => {
  it("passes when host named the guest in current message", () => {
    const r = runGroundingCheck(
      "personal_link_create",
      { activity: "intro call", inviteeName: "Susan" },
      ctxNow("schedule an intro call with Susan"),
    );
    expect(r.ok).toBe(true);
  });

  it("passes for capitalized name pattern", () => {
    const r = runGroundingCheck(
      "personal_link_create",
      { activity: "1:1", inviteeName: "Marcus" },
      ctxNow("set up a 1:1 with Marcus"),
    );
    expect(r.ok).toBe(true);
  });
});

// ===========================================================================
// NEW FIXTURES — 2026-05-12 evidence-scope redesign (15 across 4 categories)
// ===========================================================================

// ---------------------------------------------------------------------------
// Category 1 — Bare-confirmation passes (recentThread scope unblocks) — 4
// ---------------------------------------------------------------------------

describe("Category 1: bare-confirmation passes via recentThread scope", () => {
  it("recentThread scope unblocks bare-confirm name reference (cmp2wlgke false-block side; the model's wrong interpretation of T8 lives outside this proposal — see §5)", () => {
    // T7 (user): "send test meeting to bobtester"
    // T8 (envoy): "I don't see bobtester..." (DECLINE — the deeper bug is composer-discipline, not scope)
    // T9 (user): "yes, do that"
    // T10 (model emits): personal_link_create({ inviteeName: "bobtester" })
    // After scope widening: "bobtester" appears in priorEnvoyTurn → ✅ passes
    // (Composer-discipline gap on refusal interpretation is named explicitly out-of-scope in §5.)
    const r = runGroundingCheck(
      "personal_link_create",
      { activity: "testing is fun!!!", inviteeName: "bobtester" },
      ctxThread(
        "yes, do that",
        "send test meeting to bobtester - subject is 'testing is fun!!!'",
        "I don't see a session or link specifically for 'bobtester'. Also, sending emails or messages is outside what I can do",
      ),
    );
    // Note: "bobtester" lowercase doesn't match /\b[A-Z][a-z]+\b/, but it matches
    // /\b(?:with|for)\s+\w+/ via the prior envoy turn "for 'bobtester'". Plus the
    // valueMatch:"token" upgrade accepts "bobtester" appearing in prior user turn.
    expect(r.ok).toBe(true);
  });

  it("bookable_link_create passes 'yes, make that link' after envoy summarizes", () => {
    const r = runGroundingCheck(
      "bookable_link_create",
      { name: "Office Hours" },
      ctxThread(
        "yes, make that link",
        "I want to set up office hours every week",
        "Sounds good — I'll create a bookable Office Hours link for you.",
      ),
    );
    expect(r.ok).toBe(true);
  });

  it("session_update_time passes 'yes move it then' after envoy proposes time", () => {
    const r = runGroundingCheck(
      "session_update_time",
      { sessionId: "ses_abc", dateTime: "2026-05-10T14:00:00-07:00" },
      ctxThread(
        "yes move it then",
        "can we push it?",
        "How about Tuesday at 2pm?",
      ),
    );
    expect(r.ok).toBe(true);
  });

  it("session_confirm_slot passes 'yes that works' after envoy offered a slot", () => {
    const r = runGroundingCheck(
      "session_confirm_slot",
      { sessionId: "ses_abc", dateTime: "2026-05-10T14:00:00-07:00" },
      ctxThread(
        "yes that works",
        "what about Tuesday afternoon?",
        "I have 2pm open on Tuesday — does that work?",
      ),
    );
    expect(r.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Category 2 — F18-protection preserved (fabrications still block) — 4
// ---------------------------------------------------------------------------

describe("Category 2: F18-protection preserved under widened scope", () => {
  it("personal_link_create blocks fabricated inviteeName not in scope or tool results", () => {
    // Host mentioned "Susan" in prior turn; model emits "Sarah Johnson" — fabrication.
    const r = runGroundingCheck(
      "personal_link_create",
      { activity: "coffee", inviteeName: "Sarah Johnson" },
      ctxThread(
        "yes, set it up",
        "schedule something with Susan",
        "I can do that. Should I send Susan a 30-min coffee invite?",
      ),
    );
    expect(r.ok).toBe(false);
  });

  it("session_cancel blocks fabricated sessionId not in this-turn LOAD results", () => {
    const r = runGroundingCheck(
      "session_cancel",
      { sessionId: "ses_fabricated" },
      ctxLoaded(
        "cancel the Susan meeting",
        [{ toolName: "LOAD_active_sessions", result: { sessions: [{ id: "ses_real_abc", inviteeName: "Susan" }] } }],
      ),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.severity).toBe("strict");
  });

  it("rule_remove blocks fabricated id not in this-turn LOAD results", () => {
    const r = runGroundingCheck(
      "rule_remove",
      { id: "rule_fabricated_xyz" },
      ctxLoaded(
        "remove the morning block",
        [{ toolName: "LOAD_preferences", result: { rules: [{ id: "rule_real_morning", label: "Morning block" }] } }],
      ),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.severity).toBe("strict");
  });

  it("session_hold_slot blocks fabricated sessionId even when slot time is in message", () => {
    const r = runGroundingCheck(
      "session_hold_slot",
      { sessionId: "ses_fabricated", slotStart: "2026-05-10T14:00:00-07:00", slotEnd: "2026-05-10T15:00:00-07:00" },
      ctxLoaded(
        "hold 2pm Tuesday for Susan",
        [{ toolName: "LOAD_active_sessions", result: { sessions: [{ id: "ses_real", inviteeName: "Susan" }] } }],
      ),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.severity).toBe("strict");
  });
});

// ---------------------------------------------------------------------------
// Category 3 — Value-match upgrades catch what regex missed — 4
// ---------------------------------------------------------------------------

describe("Category 3: value-match upgrades catch F18 holes regex missed", () => {
  it("personal_link_create catches name fabrication: regex shape passes but value-match fails", () => {
    // Host says "John" → regex /\b[A-Z][a-z]+\b/ matches "John"
    // Model emits inviteeName: "Susan" — shape passes today, but value-match catches.
    const r = runGroundingCheck(
      "personal_link_create",
      { activity: "coffee", inviteeName: "Susan" },
      ctxNow("schedule with John tomorrow"),
    );
    expect(r.ok).toBe(false);
  });

  it("personal_link_create allows legitimate name expansion: 'Susan' said + LOAD returned 'Susan Lee'", () => {
    // Host says "Susan"; LOAD returns "Susan Lee". Model emits "Susan Lee".
    // Token-match: "Susan" appears in scope → ✅ accept the expansion.
    const r = runGroundingCheck(
      "personal_link_create",
      { activity: "intro", inviteeName: "Susan Lee" },
      ctxLoaded(
        "set up an intro with Susan",
        [{ toolName: "LOAD_active_sessions", result: { sessions: [{ id: "ses_1", inviteeName: "Susan Lee", guestEmail: "susan@example.com" }] } }],
      ),
    );
    expect(r.ok).toBe(true);
  });

  it("session_cancel value-match: exact match against LOAD result ID required", () => {
    // Multiple LOADed sessions; model must emit one of the actual IDs.
    const r = runGroundingCheck(
      "session_cancel",
      { sessionId: "ses_xyz789" },
      ctxLoaded(
        "cancel the second one",
        [{
          toolName: "LOAD_active_sessions",
          result: {
            sessions: [
              { id: "ses_abc123", inviteeName: "Sarah" },
              { id: "ses_xyz789", inviteeName: "Marcus" },
            ],
          },
        }],
      ),
    );
    expect(r.ok).toBe(true);
  });

  it("rule_remove value-match: ID format-correct but not in LOAD results → block", () => {
    // Model invents a plausible-looking ID that wasn't returned.
    const r = runGroundingCheck(
      "rule_remove",
      { id: "rule_invented_format_correct" },
      ctxLoaded(
        "remove the morning block",
        [{ toolName: "LOAD_preferences", result: { rules: [{ id: "rule_morning_real", label: "Morning block" }] } }],
      ),
    );
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Category 4 — Edge cases — 3
// ---------------------------------------------------------------------------

describe("Category 4: edge cases", () => {
  it("stale-history degradation: recentThread undefined → distinctive 'context stale' error", () => {
    // recentThread is undefined (staleness trim fired). Field requires recentThread scope.
    // Current message ("yes do it") doesn't satisfy regex/value-match for inviteeName.
    const r = runGroundingCheck(
      "personal_link_create",
      { activity: "coffee", inviteeName: "bobtester" },
      ctxNow("yes do it"), // ctxNow doesn't set recentThread → stale path
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // Expect the staleness-distinctive error message
      expect(r.error.toLowerCase()).toContain("stale");
    }
  });

  it("missing LOAD: derivable+valueMatch:exact called with no tool results → strict fail", () => {
    // No LOAD_active_sessions in thisTurnToolResults; sessionId can't be validated.
    const r = runGroundingCheck(
      "session_cancel",
      { sessionId: "ses_xyz" },
      ctxLoaded(
        "cancel it",
        [], // empty tool results
      ),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.severity).toBe("strict");
  });

  it("confirmation-shape that's NOT a confirmation: 'yes' as first message, no prior context", () => {
    // recentThread populated but empty (no prior turns). Falls through to current-message-only failure.
    const r = runGroundingCheck(
      "personal_link_create",
      { activity: "intro", inviteeName: "Susan" },
      ctxThread("yes", undefined, undefined), // populated but both turns absent
    );
    expect(r.ok).toBe(false);
  });
});
