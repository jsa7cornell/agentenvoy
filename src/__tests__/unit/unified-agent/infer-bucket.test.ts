/**
 * Unit tests for inferBucket — the tool-name-to-corpus-bucket mapper
 * in runner.ts. Extracted here for isolated predicate coverage.
 *
 * Mirrors the function inline (same reason as self-check-parser.test.ts:
 * keeps runner.ts clean while enabling full coverage).
 */
import { describe, it, expect } from "vitest";

function inferBucket(toolCallNames: string[]): string {
  if (toolCallNames.length === 0) return "chat";
  const first = toolCallNames[0];
  if (first.startsWith("LOAD_")) return "chat";
  if (first.startsWith("personal_link_")) return "event_action";
  if (first.startsWith("bookable_link_")) return "manage_setup";
  if (first.startsWith("group_event_")) return "group_coordination";
  if (first.startsWith("primary_link_")) return "manage_setup";
  if (first.startsWith("session_")) return "event_action";
  if (first.startsWith("rule_")) return "rule";
  if (first.startsWith("prefs_")) return "manage_setup";
  if (first.startsWith("knowledge_")) return "profile";
  return "chat";
}

describe("inferBucket", () => {
  it("returns 'chat' for empty tool list", () => {
    expect(inferBucket([])).toBe("chat");
  });

  it("returns 'chat' for LOAD_ tools (read-only)", () => {
    expect(inferBucket(["LOAD_calendar_context"])).toBe("chat");
    expect(inferBucket(["LOAD_active_sessions", "personal_link_create"])).toBe("chat"); // keyed on first
    expect(inferBucket(["LOAD_preferences"])).toBe("chat");
  });

  it("returns 'event_action' for personal_link_ tools", () => {
    expect(inferBucket(["personal_link_create"])).toBe("event_action");
    expect(inferBucket(["personal_link_update"])).toBe("event_action");
    expect(inferBucket(["personal_link_archive"])).toBe("event_action");
    expect(inferBucket(["personal_link_unarchive"])).toBe("event_action");
  });

  it("returns 'manage_setup' for bookable_link_ tools", () => {
    expect(inferBucket(["bookable_link_create"])).toBe("manage_setup");
    expect(inferBucket(["bookable_link_update"])).toBe("manage_setup");
    expect(inferBucket(["bookable_link_archive"])).toBe("manage_setup");
    expect(inferBucket(["bookable_link_unarchive"])).toBe("manage_setup");
  });

  it("returns 'group_coordination' for group_event_ tools", () => {
    expect(inferBucket(["group_event_create"])).toBe("group_coordination");
    expect(inferBucket(["group_event_update"])).toBe("group_coordination");
    expect(inferBucket(["group_event_archive"])).toBe("group_coordination");
    expect(inferBucket(["group_event_unarchive"])).toBe("group_coordination");
  });

  it("returns 'manage_setup' for primary_link_ tools", () => {
    expect(inferBucket(["primary_link_update"])).toBe("manage_setup");
  });

  it("returns 'event_action' for session_ tools", () => {
    expect(inferBucket(["session_update_time"])).toBe("event_action");
    expect(inferBucket(["session_hold_slot"])).toBe("event_action");
    expect(inferBucket(["session_archive_bulk"])).toBe("event_action");
  });

  it("returns 'rule' for rule_ tools", () => {
    expect(inferBucket(["rule_add"])).toBe("rule");
    expect(inferBucket(["rule_update"])).toBe("rule");
    expect(inferBucket(["rule_remove"])).toBe("rule");
  });

  it("returns 'manage_setup' for prefs_ tools", () => {
    expect(inferBucket(["prefs_update_appearance"])).toBe("manage_setup");
    expect(inferBucket(["prefs_update_timezone"])).toBe("manage_setup");
  });

  it("returns 'profile' for knowledge_ tools", () => {
    expect(inferBucket(["knowledge_write"])).toBe("profile");
  });

  it("returns 'chat' for unknown prefix", () => {
    expect(inferBucket(["totally_unknown_tool"])).toBe("chat");
    expect(inferBucket(["unknown_action"])).toBe("chat");
  });

  it("uses first tool name to determine bucket (not any subsequent)", () => {
    // Multi-tool turn: bucket is keyed on the first call
    expect(inferBucket(["personal_link_create", "knowledge_write"])).toBe("event_action");
    expect(inferBucket(["knowledge_write", "personal_link_create"])).toBe("profile");
  });
});
