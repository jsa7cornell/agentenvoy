/**
 * Write-time integrity tests for `handleUpdateAvailabilityRule` (operation: "add"):
 *
 *  - allDay inference: when `action === "block"` and the rule has no
 *    `timeStart`/`timeEnd`, `allDay` should default to true. (Defense against
 *    composer omitting the flag — see 2026-05-05 ground bug.)
 *  - dedupe: writing a structurally-identical block rule twice should not
 *    create two rows; the second call returns success with
 *    `data.dedupedAgainst` pointing at the existing rule id.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock("@/lib/calendar", () => ({
  invalidateSchedule: vi.fn(async () => undefined),
}));

vi.mock("@/lib/profile-gaps", () => ({
  invalidateBehaviorSnapshot: vi.fn(),
}));

vi.mock("@/lib/utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/utils")>();
  return {
    ...actual,
    generateCode: () => "test1234",
  };
});

import { handleUpdateAvailabilityRule } from "@/agent/actions";
import { prisma } from "@/lib/prisma";
import type { AvailabilityPreference } from "@/lib/availability-rules";

const USER_ID = "user_test";

beforeEach(() => {
  vi.clearAllMocks();
});

function getWrittenRules(): AvailabilityPreference[] {
  const updateCall = (prisma.user.update as ReturnType<typeof vi.fn>).mock.calls[0];
  if (!updateCall) return [];
  const data = updateCall[0].data;
  return (data.preferences as { explicit: { structuredRules: AvailabilityPreference[] } })
    .explicit.structuredRules;
}

describe("handleUpdateAvailabilityRule — add — allDay inference", () => {
  it("infers allDay=true when action=block and there is no timeStart/timeEnd", async () => {
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      preferences: { explicit: { structuredRules: [] } },
      meetSlug: "host",
    });
    (prisma.user.update as ReturnType<typeof vi.fn>).mockResolvedValue({});

    const res = await handleUpdateAvailabilityRule(
      {
        operation: "add",
        rule: {
          originalText: "Protect next Tuesday all day",
          type: "one-time",
          action: "block",
          effectiveDate: "2026-05-12",
          expiryDate: "2026-05-12",
          // composer omitted allDay flag — this is the ground bug shape
        },
      },
      USER_ID,
    );

    expect(res.success).toBe(true);
    const written = getWrittenRules();
    expect(written).toHaveLength(1);
    expect(written[0].allDay).toBe(true);
  });

  it("does NOT set allDay when action=block has explicit timeStart/timeEnd", async () => {
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      preferences: { explicit: { structuredRules: [] } },
      meetSlug: "host",
    });
    (prisma.user.update as ReturnType<typeof vi.fn>).mockResolvedValue({});

    await handleUpdateAvailabilityRule(
      {
        operation: "add",
        rule: {
          originalText: "block 2-4pm Tuesday",
          type: "one-time",
          action: "block",
          effectiveDate: "2026-05-12",
          timeStart: "14:00",
          timeEnd: "16:00",
        },
      },
      USER_ID,
    );

    const written = getWrittenRules();
    expect(written).toHaveLength(1);
    expect(written[0].allDay).toBeFalsy();
  });

  it("does NOT infer allDay for non-block rules (e.g. allow without times)", async () => {
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      preferences: { explicit: { structuredRules: [] } },
      meetSlug: "host",
    });
    (prisma.user.update as ReturnType<typeof vi.fn>).mockResolvedValue({});

    await handleUpdateAvailabilityRule(
      {
        operation: "add",
        rule: {
          originalText: "allow",
          type: "recurring",
          action: "allow",
        },
      },
      USER_ID,
    );

    const written = getWrittenRules();
    expect(written).toHaveLength(1);
    expect(written[0].allDay).toBeFalsy();
  });
});

describe("handleUpdateAvailabilityRule — add — write-time dedupe", () => {
  const existingRule: AvailabilityPreference = {
    id: "rule_existing",
    originalText: "Protect next Tuesday all day",
    type: "one-time",
    action: "block",
    allDay: true,
    effectiveDate: "2026-05-12",
    expiryDate: "2026-05-12",
    status: "active",
    priority: 3,
    createdAt: "2026-05-05T15:12:00.000Z",
  };

  it("returns success without writing when an active rule with identical shape already exists", async () => {
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      preferences: { explicit: { structuredRules: [existingRule] } },
      meetSlug: "host",
    });
    (prisma.user.update as ReturnType<typeof vi.fn>).mockResolvedValue({});

    const res = await handleUpdateAvailabilityRule(
      {
        operation: "add",
        rule: {
          originalText: "Protect next Tuesday all day",
          type: "one-time",
          action: "block",
          effectiveDate: "2026-05-12",
          expiryDate: "2026-05-12",
          allDay: true,
        },
      },
      USER_ID,
    );

    expect(res.success).toBe(true);
    expect(res.data).toMatchObject({ dedupedAgainst: "rule_existing" });
    // No write should have occurred.
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("dedupes even when the new add omits allDay (after inference normalizes shape)", async () => {
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      preferences: { explicit: { structuredRules: [existingRule] } },
      meetSlug: "host",
    });
    (prisma.user.update as ReturnType<typeof vi.fn>).mockResolvedValue({});

    const res = await handleUpdateAvailabilityRule(
      {
        operation: "add",
        rule: {
          originalText: "Protect next Tuesday all day",
          type: "one-time",
          action: "block",
          effectiveDate: "2026-05-12",
          expiryDate: "2026-05-12",
          // allDay omitted — should be inferred to true and then dedupe should fire
        },
      },
      USER_ID,
    );

    expect(res.success).toBe(true);
    expect(res.data).toMatchObject({ dedupedAgainst: "rule_existing" });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("does NOT dedupe when the existing rule is paused/expired (active-only check)", async () => {
    const paused = { ...existingRule, id: "rule_paused", status: "paused" as const };
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      preferences: { explicit: { structuredRules: [paused] } },
      meetSlug: "host",
    });
    (prisma.user.update as ReturnType<typeof vi.fn>).mockResolvedValue({});

    const res = await handleUpdateAvailabilityRule(
      {
        operation: "add",
        rule: {
          originalText: "Protect next Tuesday all day",
          type: "one-time",
          action: "block",
          effectiveDate: "2026-05-12",
          expiryDate: "2026-05-12",
          allDay: true,
        },
      },
      USER_ID,
    );

    expect(res.success).toBe(true);
    expect(prisma.user.update).toHaveBeenCalled();
  });

  it("does NOT dedupe when shape differs (different originalText)", async () => {
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      preferences: { explicit: { structuredRules: [existingRule] } },
      meetSlug: "host",
    });
    (prisma.user.update as ReturnType<typeof vi.fn>).mockResolvedValue({});

    const res = await handleUpdateAvailabilityRule(
      {
        operation: "add",
        rule: {
          originalText: "different request text",
          type: "one-time",
          action: "block",
          effectiveDate: "2026-05-12",
          expiryDate: "2026-05-12",
          allDay: true,
        },
      },
      USER_ID,
    );

    expect(res.success).toBe(true);
    expect(prisma.user.update).toHaveBeenCalled();
  });
});
