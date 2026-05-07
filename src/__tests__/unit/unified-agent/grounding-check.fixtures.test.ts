/**
 * Grounding-check fixture suite — verifies the per-tool grounding declarations
 * in grounding-check.ts gate as expected against representative user messages.
 *
 * Refactored 2026-05-07 (UA refactor — UNIFIEDAGENT.md). The legacy 60-fixture
 * suite tested declarations for tools that have since been renamed or retired
 * (link_create → personal_link_create, link_cancel → personal_link_archive
 * [advisory, no declaration], primary_rename → primary_link_update). This file
 * now covers the post-rename declaration surface only.
 */
import { describe, it, expect } from "vitest";
import { runGroundingCheck } from "@/agent/unified/grounding-check";

// ---------------------------------------------------------------------------
// session_cancel — strict (irreversible session deletion)
// ---------------------------------------------------------------------------

describe("session_cancel (strict)", () => {
  it("passes when sessionId is present (came from LOAD)", () => {
    const r = runGroundingCheck(
      "session_cancel",
      { sessionId: "ses_abc123" },
      "cancel my meeting with Susan",
    );
    expect(r.ok).toBe(true);
  });

  it("fails strictly when sessionId is missing", () => {
    const r = runGroundingCheck("session_cancel", {}, "cancel my meeting");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.severity).toBe("strict");
  });
});

// ---------------------------------------------------------------------------
// session_archive_bulk — strict, requires bulk language
// ---------------------------------------------------------------------------

describe("session_archive_bulk (strict)", () => {
  it("passes when user said 'archive all'", () => {
    const r = runGroundingCheck(
      "session_archive_bulk",
      { filter: "all" },
      "archive all my old sessions",
    );
    expect(r.ok).toBe(true);
  });

  it("fails strictly with no bulk language", () => {
    const r = runGroundingCheck(
      "session_archive_bulk",
      { filter: "all" },
      "what is my schedule?",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.severity).toBe("strict");
  });
});

// ---------------------------------------------------------------------------
// rule_remove — strict, requires id from LOAD
// ---------------------------------------------------------------------------

describe("rule_remove (strict)", () => {
  it("passes when id is present", () => {
    const r = runGroundingCheck(
      "rule_remove",
      { id: "rule_xyz12345" },
      "remove my Wednesday block",
    );
    expect(r.ok).toBe(true);
  });

  it("fails strictly when id is missing", () => {
    const r = runGroundingCheck("rule_remove", {}, "remove the rule");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.severity).toBe("strict");
  });
});

// ---------------------------------------------------------------------------
// session_hold_slot — strict on sessionId, advisory on slotStart
// ---------------------------------------------------------------------------

describe("session_hold_slot (strict)", () => {
  it("passes with sessionId + time-bearing user message", () => {
    const r = runGroundingCheck(
      "session_hold_slot",
      { sessionId: "ses_abc", slotStart: "2026-05-10T14:00:00-07:00", slotEnd: "2026-05-10T15:00:00-07:00" },
      "hold 2pm Tuesday for Susan",
    );
    expect(r.ok).toBe(true);
  });

  it("fails strict when sessionId is missing", () => {
    const r = runGroundingCheck(
      "session_hold_slot",
      { slotStart: "2026-05-10T14:00:00-07:00", slotEnd: "2026-05-10T15:00:00-07:00" },
      "hold 2pm Tuesday for Susan",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.severity).toBe("strict");
  });
});

// ---------------------------------------------------------------------------
// prefs_update_timezone — strict, requires explicit tz language
// ---------------------------------------------------------------------------

describe("prefs_update_timezone (strict)", () => {
  it("passes when user mentioned timezone-related language", () => {
    const r = runGroundingCheck(
      "prefs_update_timezone",
      { timezone: "Europe/Berlin" },
      "I moved to Berlin — set my timezone",
    );
    expect(r.ok).toBe(true);
  });

  it("fails strictly without tz language", () => {
    const r = runGroundingCheck(
      "prefs_update_timezone",
      { timezone: "Europe/Berlin" },
      "schedule a meeting tomorrow",
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
      "make my primary link 45 minutes",
    );
    expect(r.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// personal_link_create — advisory, light inviteeName grounding
// ---------------------------------------------------------------------------

describe("personal_link_create (advisory)", () => {
  it("passes when host named the guest", () => {
    const r = runGroundingCheck(
      "personal_link_create",
      { activity: "intro call", inviteeName: "Susan" },
      "schedule an intro call with Susan",
    );
    expect(r.ok).toBe(true);
  });

  it("passes for capitalized name pattern", () => {
    const r = runGroundingCheck(
      "personal_link_create",
      { activity: "1:1", inviteeName: "Marcus" },
      "set up a 1:1 with Marcus",
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
      "create a recurring music lessons bookable link",
    );
    expect(r.ok).toBe(true);
  });

  it("passes for office hours phrasing", () => {
    const r = runGroundingCheck(
      "bookable_link_create",
      { name: "Office Hours", format: "video", durationMinutes: 30 },
      "set up an office hours link",
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
      "move it to Tuesday at 2pm",
    );
    expect(r.ok).toBe(true);
  });
});

describe("knowledge_write (advisory)", () => {
  it("passes for first-person facts", () => {
    const r = runGroundingCheck(
      "knowledge_write",
      { persistent: "I prefer morning meetings" },
      "remember I prefer morning meetings",
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
      "archive Susan's link",
    );
    expect(r.ok).toBe(true);
  });

  it("bookable_link_archive has no declaration → ok", () => {
    const r = runGroundingCheck(
      "bookable_link_archive",
      { id: "rule_abc12345" },
      "archive my office hours link",
    );
    expect(r.ok).toBe(true);
  });
});
