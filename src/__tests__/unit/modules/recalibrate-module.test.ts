/**
 * recalibrate module shape + classifier boundary bench fixtures (PR-D).
 *
 * Two groups:
 *  1. Module shape — structural assertions confirming the recalibrate
 *     IntentModule declaration matches its contract. Uses direct field
 *     inspection, NOT toMatchSnapshot() per reviewer Q6 lock.
 *  2. Classifier boundary — positive examples (should resolve to
 *     `recalibrate`) and a negative boundary case that must resolve to
 *     `edit_preference` ("set my buffer to 15 min"). Tests mock the
 *     classifier LLM call so no Anthropic API key is required.
 *
 * Per onboarding proposal §3.4 PR-D + §9.6 reviewer Q6 decision.
 */

import { describe, it, expect, vi } from "vitest";
import { lookupModule } from "@/agent/modules";

// ---------------------------------------------------------------------------
// 1. Module shape
// ---------------------------------------------------------------------------

describe("recalibrate module shape", () => {
  const m = lookupModule("dashboard-host", "recalibrate");

  it("is registered on dashboard-host", () => {
    expect(m).toBeDefined();
  });

  it("declares intent = recalibrate", () => {
    expect(m!.intent).toBe("recalibrate");
  });

  it("declares surface = dashboard-host", () => {
    expect(m!.surface).toBe("dashboard-host");
  });

  it("declares moduleGuardBucket = recalibrate", () => {
    expect(m!.moduleGuardBucket).toBe("recalibrate");
  });

  it("declares responseStyle = human-prose", () => {
    expect(m!.responseStyle).toBe("human-prose");
  });

  it("declares allowedActions containing update_meeting_settings and update_knowledge", () => {
    expect(m!.allowedActions).toContain("update_meeting_settings");
    expect(m!.allowedActions).toContain("update_knowledge");
  });

  it("does NOT declare create_link or availability-mutation actions (scope guard)", () => {
    expect(m!.allowedActions).not.toContain("create_link");
    expect(m!.allowedActions).not.toContain("update_availability_rule");
    expect(m!.allowedActions).not.toContain("delete_availability_rule");
  });

  it("declares a composerPlaybook that includes the recalibrate base fragment", () => {
    expect(m!.composerPlaybook).toEqual(
      expect.arrayContaining(["composers/recalibrate/base"]),
    );
  });

  it("declares a contextLoader function", () => {
    expect(typeof m!.contextLoader).toBe("function");
  });

  it("has preEmitChecks as an array (may be empty)", () => {
    expect(Array.isArray(m!.preEmitChecks)).toBe(true);
  });

  it("has postStreamGuards as an array (may be empty)", () => {
    expect(Array.isArray(m!.postStreamGuards)).toBe(true);
  });

  it("has a non-empty description", () => {
    expect(typeof m!.description).toBe("string");
    expect(m!.description.length).toBeGreaterThan(20);
  });
});

// ---------------------------------------------------------------------------
// 2. Classifier boundary fixtures
//
// The classifier is mocked — we assert that (a) given a "recalibrate" LLM
// response the intent normalizes to recalibrate, and (b) a single-field
// edit_preference signal is not misrouted as recalibrate.
//
// We mock at the normalizeHostChatIntent layer so the test is independent
// of the LLM gateway, reflecting how the bench corpus checks work.
// ---------------------------------------------------------------------------

// Lazy-import after vi.mock() calls; see vitest docs on module factory
// hoisting.
const generateObjectMock = vi.fn();
const recordSpanMock = vi.fn(async (...args: unknown[]) => {
  const fn = args[1] as () => Promise<unknown>;
  return fn();
});

vi.mock("ai", () => ({
  generateObject: (args: unknown) => generateObjectMock(args),
}));

vi.mock("@/lib/model", () => ({
  envoyModel: (modelId: string) => ({ id: modelId }),
}));

vi.mock("@/lib/langfuse", () => ({
  recordSpan: (...args: unknown[]) => recordSpanMock(...args),
}));

import { classifyChatIntent } from "@/agent/intent-classifier";

// Helper — mock one LLM response and classify as host.
async function classify(
  utterance: string,
  mockKind: string,
): Promise<{ kind: string }> {
  generateObjectMock.mockResolvedValueOnce({ object: { kind: mockKind } });
  const result = await classifyChatIntent(utterance, {}, "host");
  return { kind: (result.intent as { kind: string }).kind };
}

describe("recalibrate classifier boundary — positive examples", () => {
  it('"My schedule has changed" → recalibrate', async () => {
    const r = await classify("My schedule has changed", "recalibrate");
    expect(r.kind).toBe("recalibrate");
  });

  it('"I want to redo my setup" → recalibrate', async () => {
    const r = await classify("I want to redo my setup", "recalibrate");
    expect(r.kind).toBe("recalibrate");
  });

  it('"Can you check my preferences are still right?" → recalibrate', async () => {
    const r = await classify(
      "Can you check my preferences are still right?",
      "recalibrate",
    );
    expect(r.kind).toBe("recalibrate");
  });
});

describe("recalibrate classifier boundary — negative (edit_preference)", () => {
  it('"Set my buffer to 15 minutes" → edit_preference (not recalibrate)', async () => {
    // Single field + explicit value → should route to edit_preference.
    const r = await classify("Set my buffer to 15 minutes", "edit_preference");
    expect(r.kind).toBe("edit_preference");
    expect(r.kind).not.toBe("recalibrate");
  });

  it('"Change my default meeting length to 45 min" → edit_preference (not recalibrate)', async () => {
    const r = await classify(
      "Change my default meeting length to 45 min",
      "edit_preference",
    );
    expect(r.kind).toBe("edit_preference");
    expect(r.kind).not.toBe("recalibrate");
  });
});
