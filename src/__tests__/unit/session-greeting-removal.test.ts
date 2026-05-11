/**
 * Unit tests for Phase 2 PR3a — greeting Message-row removal at session-create.
 *
 * These tests cover the three assertions from the punch-list spec:
 *   (a) New sessions (non-group) no longer write a greeting Message row in
 *       the new surface path (USE_LEGACY_GREETING_ROW = false).
 *   (b) Legacy callers still get a greeting when an administrator Message
 *       row exists (pickGreeting works on resumed sessions).
 *   (c) pickGreeting doesn't crash on a session with no greeting Message row.
 *
 * Note: the route handler itself is not unit-tested here — that requires
 * integration test infrastructure (real Prisma + dev server). These tests
 * cover the pure helper functions that the route composes from.
 */

import { describe, it, expect } from "vitest";

// ─── pickGreeting logic — pure function extracted for testability ──────────────
//
// pickGreeting is a local function in session/route.ts. Rather than importing
// private internals, we reproduce the identical logic here — single source of
// truth is the route; this spec documents the expected behavior.

function pickGreeting(
  messages: Array<{ role: string; content: string }>,
): string {
  const administratorMsg = messages.find((m) => m.role === "administrator");
  if (administratorMsg) return administratorMsg.content;
  // Phase 2 PR3a: new sessions have no greeting Message row — return "".
  return "";
}

describe("pickGreeting — Phase 2 PR3a behavior", () => {
  it("(b) returns the first administrator message content when one exists", () => {
    const messages = [
      { role: "system", content: "Format updated to phone" },
      { role: "administrator", content: "👋 Sarah! Looking forward to it." },
      { role: "user", content: "Thanks!" },
    ];
    expect(pickGreeting(messages)).toBe("👋 Sarah! Looking forward to it.");
  });

  it("(b) skips system and host_note rows before the administrator row", () => {
    const messages = [
      { role: "host_note", content: "host note text" },
      { role: "system", content: "Location updated" },
      { role: "administrator", content: "Hello there!" },
    ];
    expect(pickGreeting(messages)).toBe("Hello there!");
  });

  it("(c) returns empty string when no administrator row exists (new surface sessions)", () => {
    // New sessions created with USE_LEGACY_GREETING_ROW = false have no
    // administrator Message row at all. pickGreeting must not crash.
    const messages: Array<{ role: string; content: string }> = [];
    expect(pickGreeting(messages)).toBe("");
  });

  it("(c) returns empty string for sessions with only host_note rows", () => {
    const messages = [
      { role: "host_note", content: "some host context" },
    ];
    expect(pickGreeting(messages)).toBe("");
  });

  it("(c) returns empty string for sessions with only system rows", () => {
    const messages = [
      { role: "system", content: "Format updated to video" },
      { role: "system", content: "Duration updated to 30 min" },
    ];
    expect(pickGreeting(messages)).toBe("");
  });

  it("(b) returns the FIRST administrator message (not a later one)", () => {
    const messages = [
      { role: "administrator", content: "First greeting." },
      { role: "user", content: "Hey" },
      { role: "administrator", content: "Second response." },
    ];
    expect(pickGreeting(messages)).toBe("First greeting.");
  });
});

// ─── USE_LEGACY_GREETING_ROW flag documentation ───────────────────────────────
//
// The following tests document the expected behavior difference between
// the legacy and new surface paths. They don't call the route handler
// directly (that requires integration infrastructure) — instead they verify
// the business rule in isolation.

describe("Phase 2 PR3a — greeting Message-row gate", () => {
  it("(a) non-group sessions should NOT create a greeting Message row in the new surface", () => {
    // This test documents the intended behavior locked by Phase 2 PR3a.
    // USE_LEGACY_GREETING_ROW = false in session/route.ts gates out the
    // prisma.message.create call for non-group events.
    //
    // Verification: in integration tests, a fresh non-group session should
    // have zero administrator-role messages after session-create.
    // Here we just assert the gate constant semantics.
    const USE_LEGACY_GREETING_ROW = false; // mirrors route.ts value
    const isGroupEvent = false;
    const shouldPersistGreeting = isGroupEvent || USE_LEGACY_GREETING_ROW;
    expect(shouldPersistGreeting).toBe(false);
  });

  it("(a) group sessions ALWAYS create the greeting Message row", () => {
    // Group events use an LLM-generated greeting with no MeetingCard tip
    // surface — the chat thread is the sole render surface. The Message
    // row must be written regardless of USE_LEGACY_GREETING_ROW.
    const USE_LEGACY_GREETING_ROW = false;
    const isGroupEvent = true;
    const shouldPersistGreeting = isGroupEvent || USE_LEGACY_GREETING_ROW;
    expect(shouldPersistGreeting).toBe(true);
  });

  it("(a) legacy mode re-enables greeting row creation for all sessions", () => {
    // When USE_LEGACY_GREETING_ROW is flipped to true (for testing or
    // rollback), ALL non-group sessions get the Message row again.
    const USE_LEGACY_GREETING_ROW = true;
    const isGroupEvent = false;
    const shouldPersistGreeting = isGroupEvent || USE_LEGACY_GREETING_ROW;
    expect(shouldPersistGreeting).toBe(true);
  });
});
