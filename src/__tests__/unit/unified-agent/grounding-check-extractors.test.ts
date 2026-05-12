/**
 * Per-extractor unit tests for grounding-check value-match.
 *
 * P1 mitigation from the 2026-05-12 evidence-scope-redesign review:
 * the per-tool extractors in grounding-check.ts are coupled to the shape
 * of LOAD tool return values. If a LOAD tool renames `sessions[].id →
 * sessions[].sessionId` (or similar) and the rename PR doesn't sweep
 * grounding-check.ts, value-match silently degrades to "field non-empty"
 * — i.e., the SAME bug the proposal is closing.
 *
 * These tests exercise the extractor contract directly, asserting that
 * each LOAD tool's documented shape produces the expected derived values.
 * A failing test here means either the LOAD tool's shape changed (update
 * the extractor) or the extractor's logic regressed (fix the bug).
 */
import { describe, it, expect } from "vitest";
import {
  runGroundingCheck,
  type LoadResultShape,
} from "@/agent/unified/grounding-check";

describe("LoadResult extractor: LOAD_active_sessions → sessionId", () => {
  it("extracts session.id field from LOAD_active_sessions.result.sessions[]", () => {
    const r = runGroundingCheck(
      "session_cancel",
      { sessionId: "ses_alpha" },
      {
        currentUserMessage: "cancel the meeting with Sarah",
        thisTurnToolResults: [
          {
            toolName: "LOAD_active_sessions",
            result: {
              sessions: [
                { id: "ses_alpha", inviteeName: "Sarah" },
                { id: "ses_beta", inviteeName: "Marcus" },
              ],
            },
          },
        ],
      },
    );
    expect(r.ok).toBe(true);
  });

  it("multiple LOAD_active_sessions calls accumulate sessions[]", () => {
    const r = runGroundingCheck(
      "session_cancel",
      { sessionId: "ses_gamma" },
      {
        currentUserMessage: "cancel that one",
        thisTurnToolResults: [
          {
            toolName: "LOAD_active_sessions",
            result: { sessions: [{ id: "ses_alpha", inviteeName: "Sarah" }] },
          },
          {
            toolName: "LOAD_active_sessions",
            result: { sessions: [{ id: "ses_gamma", inviteeName: "Diane" }] },
          },
        ],
      },
    );
    expect(r.ok).toBe(true);
  });

  it("empty sessions[] in LOAD result → value-match fails", () => {
    const r = runGroundingCheck(
      "session_cancel",
      { sessionId: "ses_alpha" },
      {
        currentUserMessage: "cancel it",
        thisTurnToolResults: [
          { toolName: "LOAD_active_sessions", result: { sessions: [] } },
        ],
      },
    );
    expect(r.ok).toBe(false);
  });

  it("LOAD result without sessions[] field → value-match fails (shape drift detector)", () => {
    // Simulates a shape drift: result shape changed and the extractor
    // sees no sessions[] field. Should fail-safe (block) rather than
    // silently accept.
    const r = runGroundingCheck(
      "session_cancel",
      { sessionId: "ses_alpha" },
      {
        currentUserMessage: "cancel it",
        thisTurnToolResults: [
          { toolName: "LOAD_active_sessions", result: { /* no sessions */ } as unknown as LoadResultShape["result"] },
        ],
      },
    );
    expect(r.ok).toBe(false);
  });
});

describe("LoadResult extractor: LOAD_preferences → rule.id", () => {
  it("extracts rule.id field from LOAD_preferences.result.rules[]", () => {
    const r = runGroundingCheck(
      "rule_remove",
      { id: "rule_morning_block" },
      {
        currentUserMessage: "remove the morning block",
        thisTurnToolResults: [
          {
            toolName: "LOAD_preferences",
            result: {
              rules: [
                { id: "rule_morning_block", label: "Morning block" },
                { id: "rule_friday_block", label: "Friday block" },
              ],
            },
          },
        ],
      },
    );
    expect(r.ok).toBe(true);
  });

  it("empty rules[] in LOAD result → value-match fails", () => {
    const r = runGroundingCheck(
      "rule_remove",
      { id: "rule_xyz" },
      {
        currentUserMessage: "remove it",
        thisTurnToolResults: [
          { toolName: "LOAD_preferences", result: { rules: [] } },
        ],
      },
    );
    expect(r.ok).toBe(false);
  });
});

describe("Extractor cross-tool isolation: rule_remove ignores LOAD_active_sessions", () => {
  it("rule_remove.id does NOT match against LOAD_active_sessions IDs", () => {
    // If the extractor incorrectly pulled session IDs for rule_remove, this would pass.
    // It should fail because LOAD_active_sessions has no rules[] shape.
    const r = runGroundingCheck(
      "rule_remove",
      { id: "ses_collision" }, // ID that happens to be in LOAD_active_sessions, NOT in rules
      {
        currentUserMessage: "remove it",
        thisTurnToolResults: [
          {
            toolName: "LOAD_active_sessions",
            result: { sessions: [{ id: "ses_collision", inviteeName: "Foo" }] },
          },
        ],
      },
    );
    expect(r.ok).toBe(false);
  });
});

describe("Token-match value-match: inviteeName legitimate expansion", () => {
  it("ANY token from emitted value in scope → pass", () => {
    // Host said "Susan"; model emits "Susan Lee" → "Susan" appears → ✅
    const r = runGroundingCheck(
      "personal_link_create",
      { activity: "intro", inviteeName: "Susan Lee" },
      {
        currentUserMessage: "set up an intro with Susan",
        thisTurnToolResults: [],
      },
    );
    expect(r.ok).toBe(true);
  });

  it("full value in tool results → pass even when no token in text", () => {
    // Host said "the contact"; model emits "Susan Lee" from LOAD result
    const r = runGroundingCheck(
      "personal_link_create",
      { activity: "intro", inviteeName: "Susan Lee" },
      {
        currentUserMessage: "set up an intro with the contact",
        thisTurnToolResults: [
          {
            toolName: "LOAD_active_sessions",
            result: { sessions: [{ id: "ses_1", inviteeName: "Susan Lee" }] },
          },
        ],
      },
    );
    expect(r.ok).toBe(true);
  });

  it("no tokens match AND not in tool results → fail (fabrication)", () => {
    // Host said "Sarah"; model emits "Marcus Johnson" — fully unrelated.
    const r = runGroundingCheck(
      "personal_link_create",
      { activity: "intro", inviteeName: "Marcus Johnson" },
      {
        currentUserMessage: "set up an intro with Sarah",
        thisTurnToolResults: [],
      },
    );
    // Regex /\b[A-Z][a-z]+\b/ matches "Sarah" (shape passes); value-match fails.
    expect(r.ok).toBe(false);
  });
});
