/**
 * Day 5 — 60-turn grounding-check fixture suite.
 *
 * Exercises `runGroundingCheck` across all declared tools with a mix of:
 *   - Happy-path (evidenced) inputs that must pass
 *   - Failure paths (unevidenced / missing IDs) that must fail
 *   - Edge cases: empty strings, partial matches, bare confirmations,
 *     fait-accompli, F14/F17/F18 reproduction patterns
 *
 * No LLM calls. No DB. Pure predicate assertions.
 */
import { describe, it, expect } from "vitest";
import { runGroundingCheck } from "@/agent/unified/grounding-check";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Fixture = {
  label: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  userMessage: string;
  expectOk: boolean;
  expectSeverity?: "advisory" | "strict";
};

function run(f: Fixture) {
  const result = runGroundingCheck(f.toolName, f.toolInput, f.userMessage);
  expect(result.ok, `[${f.label}] ok`).toBe(f.expectOk);
  if (!result.ok && f.expectSeverity) {
    expect(result.severity, `[${f.label}] severity`).toBe(f.expectSeverity);
  }
}

// ---------------------------------------------------------------------------
// link_cancel — strict
// ---------------------------------------------------------------------------

describe("link_cancel (strict)", () => {
  it("F01 — passes when code is present (derivable from LOAD output)", () => {
    run({
      label: "F01",
      toolName: "link_cancel",
      toolInput: { code: "a8f3c9d2" },
      userMessage: "cancel my coffee link",
      expectOk: true,
    });
  });

  it("F02 — fails strict when code is missing entirely", () => {
    run({
      label: "F02",
      toolName: "link_cancel",
      toolInput: {},
      userMessage: "cancel my coffee link",
      expectOk: false,
      expectSeverity: "strict",
    });
  });

  it("F03 — fails strict when code is empty string", () => {
    run({
      label: "F03",
      toolName: "link_cancel",
      toolInput: { code: "" },
      userMessage: "cancel it",
      expectOk: false,
      expectSeverity: "strict",
    });
  });

  it("F04 — fails strict when code is null", () => {
    run({
      label: "F04",
      toolName: "link_cancel",
      toolInput: { code: null },
      userMessage: "delete the bike-ride link",
      expectOk: false,
      expectSeverity: "strict",
    });
  });

  // F14 reproduction: fabricated ID from prior conversation context
  it("F05 — F14 shape: fabricated code-like string still requires field to be present, but code='general' passes field-present check (derivable only checks presence)", () => {
    // The grounding check for derivable fields only verifies presence — not semantic validity.
    // Semantic validity (real code vs. fabricated word) is enforced by Layer 3 (tool description)
    // and Layer 4 (self-check). This fixture documents that boundary.
    run({
      label: "F05",
      toolName: "link_cancel",
      toolInput: { code: "general" },
      userMessage: "cancel it",
      expectOk: true, // derivable field — presence is sufficient for Layer 2
    });
  });
});

// ---------------------------------------------------------------------------
// session_archive_bulk — strict
// ---------------------------------------------------------------------------

describe("session_archive_bulk (strict)", () => {
  it("F06 — passes on 'archive all' pattern", () => {
    run({
      label: "F06",
      toolName: "session_archive_bulk",
      toolInput: { filter: "unconfirmed" },
      userMessage: "archive all unconfirmed sessions",
      expectOk: true,
    });
  });

  it("F07 — passes on 'bulk' pattern", () => {
    run({
      label: "F07",
      toolName: "session_archive_bulk",
      toolInput: { filter: "expired" },
      userMessage: "bulk archive my expired sessions please",
      expectOk: true,
    });
  });

  it("F08 — passes on 'clean up' pattern", () => {
    run({
      label: "F08",
      toolName: "session_archive_bulk",
      toolInput: { filter: "all" },
      userMessage: "can you clean up all my old sessions?",
      expectOk: true,
    });
  });

  it("F09 — fails strict on bare confirmation (fait-accompli pattern)", () => {
    // Host said 'yes' or 'go ahead' without bulk language in the current message.
    // Grounding check must block because no bulk pattern is present.
    run({
      label: "F09",
      toolName: "session_archive_bulk",
      toolInput: { filter: "all" },
      userMessage: "yes",
      expectOk: false,
      expectSeverity: "strict",
    });
  });

  it("F10 — fails strict on vague pivot ('clean this up' without bulk intent)", () => {
    run({
      label: "F10",
      toolName: "session_archive_bulk",
      toolInput: { filter: "all" },
      userMessage: "can you clean this up a bit",
      expectOk: false,
      expectSeverity: "strict",
    });
  });

  it("F11 — passes on 'cancelled' filter pattern", () => {
    run({
      label: "F11",
      toolName: "session_archive_bulk",
      toolInput: { filter: "cancelled" },
      userMessage: "archive all the cancelled ones",
      expectOk: true,
    });
  });

  it("F12 — fails strict on ambiguous archive-single language", () => {
    run({
      label: "F12",
      toolName: "session_archive_bulk",
      toolInput: { filter: "all" },
      userMessage: "archive the meeting with Sarah",
      expectOk: false,
      expectSeverity: "strict",
    });
  });
});

// ---------------------------------------------------------------------------
// rule_remove — strict
// ---------------------------------------------------------------------------

describe("rule_remove (strict)", () => {
  it("F13 — passes when id is present (derivable from LOAD_preferences)", () => {
    run({
      label: "F13",
      toolName: "rule_remove",
      toolInput: { id: "rule_a3b9c2d1" },
      userMessage: "remove that friday block",
      expectOk: true,
    });
  });

  it("F14 — fails strict when id is missing (F18 reproduction: fabricated id not provided)", () => {
    run({
      label: "F14",
      toolName: "rule_remove",
      toolInput: {},
      userMessage: "remove the friday rule",
      expectOk: false,
      expectSeverity: "strict",
    });
  });

  it("F15 — fails strict when id is empty string", () => {
    run({
      label: "F15",
      toolName: "rule_remove",
      toolInput: { id: "" },
      userMessage: "delete the office hours rule",
      expectOk: false,
      expectSeverity: "strict",
    });
  });
});

// ---------------------------------------------------------------------------
// session_hold_slot — mixed (sessionId strict, slotStart advisory)
// ---------------------------------------------------------------------------

describe("session_hold_slot (sessionId strict, slotStart advisory)", () => {
  it("F16 — passes when sessionId present and slotStart has time evidence", () => {
    run({
      label: "F16",
      toolName: "session_hold_slot",
      toolInput: { sessionId: "cm1abc", slotStart: "2026-05-08T14:00:00" },
      userMessage: "hold 2pm on Thursday for Sarah",
      expectOk: true,
    });
  });

  it("F17 — fails strict when sessionId missing (irreversible field)", () => {
    run({
      label: "F17",
      toolName: "session_hold_slot",
      toolInput: { slotStart: "2026-05-08T14:00:00" },
      userMessage: "hold 2pm for Sarah",
      expectOk: false,
      expectSeverity: "strict",
    });
  });

  it("F18 — fails (strict severity) when slotStart has no time evidence — tool-level strict overrides field-level advisory", () => {
    // session_hold_slot has toolSeverity: "strict". Even though slotStart's
    // individual severity is "advisory", the tool-level severity escalates
    // the overall result to "strict". This is the correct design — holding a
    // slot without a time is irreversible enough to warrant the stronger signal.
    run({
      label: "F18",
      toolName: "session_hold_slot",
      toolInput: { sessionId: "cm1abc", slotStart: "2026-05-08T14:00:00" },
      userMessage: "hold a slot for sarah",
      expectOk: false,
      expectSeverity: "strict",
    });
  });

  it("F19 — passes with day-of-week evidence (Tuesday)", () => {
    run({
      label: "F19",
      toolName: "session_hold_slot",
      toolInput: { sessionId: "cm1abc", slotStart: "2026-05-12T09:00:00" },
      userMessage: "hold Tuesday morning for the coaching call",
      expectOk: true,
    });
  });

  it("F20 — passes with ISO date evidence", () => {
    run({
      label: "F20",
      toolName: "session_hold_slot",
      toolInput: { sessionId: "cm1abc", slotStart: "2026-05-20T10:00:00" },
      userMessage: "put a hold on 2026-05-20 for him",
      expectOk: true,
    });
  });
});

// ---------------------------------------------------------------------------
// link_create — advisory
// ---------------------------------------------------------------------------

describe("link_create (advisory)", () => {
  it("F21 — passes on explicit activity name 'coffee chat'", () => {
    run({
      label: "F21",
      toolName: "link_create",
      toolInput: { activity: "coffee chat", format: "video", durationMinutes: 30 },
      userMessage: "create a coffee link for quick intro calls",
      expectOk: true,
    });
  });

  it("F22 — passes on 'set up a call link' pattern", () => {
    run({
      label: "F22",
      toolName: "link_create",
      toolInput: { activity: "call", format: "phone", durationMinutes: 15 },
      userMessage: "set up a new call link",
      expectOk: true,
    });
  });

  it("F23 — passes on 'meeting' activity match", () => {
    run({
      label: "F23",
      toolName: "link_create",
      toolInput: { activity: "strategy meeting", format: "video", durationMinutes: 60 },
      userMessage: "I want a booking link for strategy meetings",
      expectOk: true,
    });
  });

  it("F24 — fails advisory when user message has no activity context", () => {
    run({
      label: "F24",
      toolName: "link_create",
      toolInput: { activity: "consulting", format: "video", durationMinutes: 60 },
      userMessage: "yes please",
      expectOk: false,
      expectSeverity: "advisory",
    });
  });

  it("F25 — fails advisory on bare pivot ('do it')", () => {
    run({
      label: "F25",
      toolName: "link_create",
      toolInput: { activity: "coaching", format: "video", durationMinutes: 45 },
      userMessage: "do it",
      expectOk: false,
      expectSeverity: "advisory",
    });
  });

  it("F26 — passes on 'intro' activity match", () => {
    run({
      label: "F26",
      toolName: "link_create",
      toolInput: { activity: "intro call", format: "video", durationMinutes: 20 },
      userMessage: "make me an intro link",
      expectOk: true,
    });
  });

  it("F27 — passes on 'catch up' pattern", () => {
    run({
      label: "F27",
      toolName: "link_create",
      toolInput: { activity: "catch-up", format: "video", durationMinutes: 30 },
      userMessage: "create a catch-up link",
      expectOk: true,
    });
  });

  it("F28 — passes on 'workshop' pattern", () => {
    run({
      label: "F28",
      toolName: "link_create",
      toolInput: { activity: "workshop", format: "in-person", durationMinutes: 120 },
      userMessage: "I need a workshop booking link",
      expectOk: true,
    });
  });

  it("F29 — passes on 'new booking' pattern (create synonyms)", () => {
    run({
      label: "F29",
      toolName: "link_create",
      toolInput: { activity: "sales call", format: "video", durationMinutes: 30 },
      userMessage: "new booking link for sales calls",
      expectOk: true,
    });
  });
});

// ---------------------------------------------------------------------------
// session_update_time — advisory
// ---------------------------------------------------------------------------

describe("session_update_time (advisory)", () => {
  it("F30 — passes with am/pm time in message", () => {
    run({
      label: "F30",
      toolName: "session_update_time",
      toolInput: { dateTime: "2026-05-08T14:00:00" },
      userMessage: "move Sarah's call to 2pm",
      expectOk: true,
    });
  });

  it("F31 — passes with 24h format", () => {
    run({
      label: "F31",
      toolName: "session_update_time",
      toolInput: { dateTime: "2026-05-08T14:00:00" },
      userMessage: "reschedule to 14:00 on Friday",
      expectOk: true,
    });
  });

  it("F32 — passes with 'tomorrow' keyword", () => {
    run({
      label: "F32",
      toolName: "session_update_time",
      toolInput: { dateTime: "2026-05-07T09:00:00" },
      userMessage: "move it to tomorrow morning",
      expectOk: true,
    });
  });

  it("F33 — passes with day-of-week", () => {
    run({
      label: "F33",
      toolName: "session_update_time",
      toolInput: { dateTime: "2026-05-11T15:00:00" },
      userMessage: "change to Monday at 3",
      expectOk: true,
    });
  });

  it("F34 — fails advisory when no time mentioned (fait-accompli pattern)", () => {
    run({
      label: "F34",
      toolName: "session_update_time",
      toolInput: { dateTime: "2026-05-08T14:00:00" },
      userMessage: "yes reschedule it",
      expectOk: false,
      expectSeverity: "advisory",
    });
  });

  it("F35 — fails advisory on bare 'ok, move it'", () => {
    run({
      label: "F35",
      toolName: "session_update_time",
      toolInput: { dateTime: "2026-05-10T10:00:00" },
      userMessage: "ok move it",
      expectOk: false,
      expectSeverity: "advisory",
    });
  });

  it("F36 — passes with ISO date in message", () => {
    run({
      label: "F36",
      toolName: "session_update_time",
      toolInput: { dateTime: "2026-06-01T09:00:00" },
      userMessage: "push to 2026-06-01",
      expectOk: true,
    });
  });
});

// ---------------------------------------------------------------------------
// knowledge_write — advisory
// ---------------------------------------------------------------------------

describe("knowledge_write (advisory)", () => {
  it("F37 — passes on 'remember' pattern", () => {
    run({
      label: "F37",
      toolName: "knowledge_write",
      toolInput: { persistent: "I prefer video calls" },
      userMessage: "please remember I prefer video calls",
      expectOk: true,
    });
  });

  it("F38 — passes on 'I am' self-statement", () => {
    run({
      label: "F38",
      toolName: "knowledge_write",
      toolInput: { persistent: "based in NYC" },
      userMessage: "I'm based in New York City",
      expectOk: true,
    });
  });

  it("F39 — passes on 'my' possessive pattern", () => {
    run({
      label: "F39",
      toolName: "knowledge_write",
      toolInput: { persistent: "usually available after 9am" },
      userMessage: "my schedule usually opens after 9am",
      expectOk: true,
    });
  });

  it("F40 — passes on 'usually' adverb pattern", () => {
    run({
      label: "F40",
      toolName: "knowledge_write",
      toolInput: { situational: "traveling this week" },
      userMessage: "I usually work from home but I'm traveling this week",
      expectOk: true,
    });
  });

  it("F41 — fails advisory when no knowledge-assertion signal in message", () => {
    run({
      label: "F41",
      toolName: "knowledge_write",
      toolInput: { persistent: "prefers mornings" },
      userMessage: "what time works for a call?",
      expectOk: false,
      expectSeverity: "advisory",
    });
  });

  it("F42 — passes on 'note' pattern", () => {
    run({
      label: "F42",
      toolName: "knowledge_write",
      toolInput: { persistent: "no meetings before 10am" },
      userMessage: "note: no meetings before 10am please",
      expectOk: true,
    });
  });

  it("F43 — passes on 'save' imperative", () => {
    run({
      label: "F43",
      toolName: "knowledge_write",
      toolInput: { persistent: "works Pacific time" },
      userMessage: "save that I work on Pacific time",
      expectOk: true,
    });
  });
});

// ---------------------------------------------------------------------------
// Tools without grounding declarations — always pass
// ---------------------------------------------------------------------------

describe("tools without declarations — always pass", () => {
  it("F44 — LOAD_calendar_context has no declaration, passes", () => {
    run({
      label: "F44",
      toolName: "LOAD_calendar_context",
      toolInput: {},
      userMessage: "what's on my calendar today?",
      expectOk: true,
    });
  });

  it("F45 — LOAD_active_sessions has no declaration, passes", () => {
    run({
      label: "F45",
      toolName: "LOAD_active_sessions",
      toolInput: {},
      userMessage: "show my sessions",
      expectOk: true,
    });
  });

  it("F46 — LOAD_preferences has no declaration, passes", () => {
    run({
      label: "F46",
      toolName: "LOAD_preferences",
      toolInput: {},
      userMessage: "show my rules",
      expectOk: true,
    });
  });

  it("F47 — link_update has no declaration, passes regardless of input", () => {
    run({
      label: "F47",
      toolName: "link_update",
      toolInput: { code: "abc123", durationMinutes: 45 },
      userMessage: "change the call link to 45 min",
      expectOk: true,
    });
  });

  it("F48 — rule_add has no declaration, passes regardless of input", () => {
    run({
      label: "F48",
      toolName: "rule_add",
      toolInput: { rule: { type: "recurring", action: "block", daysOfWeek: [5] } },
      userMessage: "block all friday afternoons",
      expectOk: true,
    });
  });

  it("F49 — prefs_update_meeting_settings has no declaration, passes", () => {
    run({
      label: "F49",
      toolName: "prefs_update_meeting_settings",
      toolInput: { defaultDuration: 45 },
      userMessage: "change default to 45 minutes",
      expectOk: true,
    });
  });

  it("F50 — prefs_update_business_hours has no declaration, passes", () => {
    run({
      label: "F50",
      toolName: "prefs_update_business_hours",
      toolInput: { start: 9, end: 17 },
      userMessage: "set hours to 9 to 5",
      expectOk: true,
    });
  });
});

// ---------------------------------------------------------------------------
// Edge cases and boundary conditions
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  it("F51 — unknown tool name passes (no declaration = no check)", () => {
    run({
      label: "F51",
      toolName: "totally_unknown_tool",
      toolInput: { anything: "goes" },
      userMessage: "do something",
      expectOk: true,
    });
  });

  it("F52 — link_cancel with whitespace-only code PASSES Layer 2 (whitespace not trimmed — Layer 3/action layer enforces this)", () => {
    // Layer 2 grounding-check is intentionally lightweight: checks !== "" only.
    // A whitespace-only code string passes field-present check. Semantic
    // validity (is this a real code format?) is enforced by Layer 3 (tool
    // description warns the model) and the action handler itself.
    run({
      label: "F52",
      toolName: "link_cancel",
      toolInput: { code: "   " },
      userMessage: "cancel the link",
      expectOk: true,
    });
  });

  it("F53 — session_archive_bulk with 'everything' keyword passes", () => {
    run({
      label: "F53",
      toolName: "session_archive_bulk",
      toolInput: { filter: "all" },
      userMessage: "archive everything old",
      expectOk: true,
    });
  });

  it("F54 — session_archive_bulk case-insensitive match", () => {
    run({
      label: "F54",
      toolName: "session_archive_bulk",
      toolInput: { filter: "unconfirmed" },
      userMessage: "ARCHIVE ALL unconfirmed",
      expectOk: true,
    });
  });

  it("F55 — link_create with mixed-case message matches pattern", () => {
    run({
      label: "F55",
      toolName: "link_create",
      toolInput: { activity: "consultation" },
      userMessage: "Create a new CONSULTATION link",
      expectOk: true,
    });
  });

  it("F56 — session_update_time with '3pm' (no space before pm) passes", () => {
    run({
      label: "F56",
      toolName: "session_update_time",
      toolInput: { dateTime: "2026-05-08T15:00:00" },
      userMessage: "move it to 3pm tomorrow",
      expectOk: true,
    });
  });

  it("F57 — session_hold_slot with '11:30am' format passes slotStart check", () => {
    run({
      label: "F57",
      toolName: "session_hold_slot",
      toolInput: { sessionId: "cm1abc", slotStart: "2026-05-08T11:30:00" },
      userMessage: "hold 11:30am on Friday for the sales call",
      expectOk: true,
    });
  });

  it("F58 — rule_remove with null id fails strict", () => {
    run({
      label: "F58",
      toolName: "rule_remove",
      toolInput: { id: null },
      userMessage: "remove the morning block",
      expectOk: false,
      expectSeverity: "strict",
    });
  });

  it("F59 — knowledge_write with 'prefer' keyword passes", () => {
    run({
      label: "F59",
      toolName: "knowledge_write",
      toolInput: { persistent: "morning person" },
      userMessage: "I prefer mornings for calls",
      expectOk: true,
    });
  });

  it("F60 — link_create on empty message fails advisory", () => {
    run({
      label: "F60",
      toolName: "link_create",
      toolInput: { activity: "coaching", format: "video", durationMinutes: 30 },
      userMessage: "",
      expectOk: false,
      expectSeverity: "advisory",
    });
  });
});
