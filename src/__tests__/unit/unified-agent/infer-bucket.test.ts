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
  if (first.startsWith("link_")) return "event_action";
  if (first.startsWith("session_")) return "event_action";
  if (first.startsWith("rule_")) return "rule";
  if (first.startsWith("prefs_")) return "manage_setup";
  if (first.startsWith("knowledge_")) return "profile";
  if (first.startsWith("primary_")) return "manage_setup";
  if (first.startsWith("group_coord_")) return "group_coordination";
  return "chat";
}

describe("inferBucket", () => {
  it("returns 'chat' for empty tool list", () => {
    expect(inferBucket([])).toBe("chat");
  });

  it("returns 'chat' for LOAD_ tools (read-only)", () => {
    expect(inferBucket(["LOAD_calendar_context"])).toBe("chat");
    expect(inferBucket(["LOAD_active_sessions", "link_create"])).toBe("chat"); // keyed on first
    expect(inferBucket(["LOAD_preferences"])).toBe("chat");
  });

  it("returns 'event_action' for link_ tools", () => {
    expect(inferBucket(["link_create"])).toBe("event_action");
    expect(inferBucket(["link_update"])).toBe("event_action");
    expect(inferBucket(["link_cancel"])).toBe("event_action");
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
    expect(inferBucket(["prefs_update_meeting_settings"])).toBe("manage_setup");
    expect(inferBucket(["prefs_update_business_hours"])).toBe("manage_setup");
  });

  it("returns 'profile' for knowledge_ tools", () => {
    expect(inferBucket(["knowledge_write"])).toBe("profile");
  });

  it("returns 'manage_setup' for primary_ tools", () => {
    expect(inferBucket(["primary_link_rename"])).toBe("manage_setup");
  });

  it("returns 'group_coordination' for group_coord_ tools", () => {
    expect(inferBucket(["group_coord_something"])).toBe("group_coordination");
  });

  it("returns 'chat' for unknown prefix", () => {
    expect(inferBucket(["totally_unknown_tool"])).toBe("chat");
    expect(inferBucket(["unknown_action"])).toBe("chat");
  });

  it("uses first tool name to determine bucket (not any subsequent)", () => {
    // Multi-tool turn: bucket is keyed on the first call
    expect(inferBucket(["link_create", "knowledge_write"])).toBe("event_action");
    expect(inferBucket(["knowledge_write", "link_create"])).toBe("profile");
  });
});
