/**
 * AP5b parity test for get_tip MCP handler.
 *
 * Invariant (binding, proposal § 6.3):
 *   renderTip(buildTipInput(input), "guest").templateId
 *     === handleGetTip({ meetingUrl }).tip.templateId
 *
 * This file tests the renderTip side of the invariant using ~10 fixture
 * inputs covering the authored-link-tip path and fallback templates.
 * The handler integration side is tested via the live API route, but the
 * parity assertion can be validated here in pure unit form by calling
 * renderTip directly (same function the handler calls).
 *
 * Per SEED design pivot 2026-05-10.
 */
import { describe, it, expect } from "vitest";
import { renderTip } from "@/lib/meeting-tip/render";
import { buildTipInput } from "@/lib/meeting-tip/build-input";
import type { BuildTipInputArgs } from "@/lib/meeting-tip/build-input";

// ── Fixture inputs ────────────────────────────────────────────────────────────

const BASE: BuildTipInputArgs = {
  hostName: "John Anderson",
  inviteeName: "Sarah Chen",
  linkFormat: "video",
  linkActivity: null,
  linkLocation: null,
};

const FIXTURES: Array<{ label: string; args: BuildTipInputArgs }> = [
  {
    label: "authored-link-tip — set",
    args: { ...BASE, linkAuthoredTip: "Bring your charger." },
  },
  {
    label: "authored-link-tip — takes priority over tipDayOf",
    args: { ...BASE, linkAuthoredTip: "Link tip wins", tipDayOf: "Day-of tip" },
  },
  {
    label: "authored-day-of fallback when no linkAuthoredTip",
    args: { ...BASE, tipDayOf: "Today is the day!" },
  },
  {
    label: "authored-travel fallback",
    args: { ...BASE, tipTravel: "Leave 15 min early." },
  },
  {
    label: "authored-format fallback",
    args: { ...BASE, tipFormat: "Use headphones." },
  },
  {
    label: "derived-calendar-overlap — both calendars connected",
    args: {
      ...BASE,
      bothCalendarsConnected: true,
      linkActivity: "coffee",
    },
  },
  {
    label: "derived-relationship-history — has prior sessions",
    args: { ...BASE, hasPriorSessions: true },
  },
  {
    label: "derived-series-progress — recurring session 3 of 10",
    args: {
      ...BASE,
      isRecurring: true,
      recurringPosition: 3,
      recurringTotal: 10,
    },
  },
  {
    label: "generative fallback — no specific signals",
    args: { ...BASE, linkFormat: "phone" },
  },
  {
    label: "authored-link-tip — empty string falls through",
    args: { ...BASE, linkAuthoredTip: "", tipDayOf: "Day-of fallback" },
  },
];

// ── Parity assertion ──────────────────────────────────────────────────────────

describe("AP5b get_tip parity — guest vs host templateId invariant", () => {
  it.each(FIXTURES)("$label: guest and host share templateId + sourceKind", ({ args }) => {
    const input = buildTipInput(args);
    const guestResult = renderTip(input, "guest");
    const hostResult = renderTip(input, "host");

    // Both should resolve (or both null)
    expect(guestResult === null).toBe(hostResult === null);

    if (guestResult && hostResult) {
      expect(guestResult.templateId).toBe(hostResult.templateId);
      expect(guestResult.sourceKind).toBe(hostResult.sourceKind);
    }
  });

  it("authored-link-tip-v1 templateId is stable across both viewer roles", () => {
    const input = buildTipInput({
      ...BASE,
      linkAuthoredTip: "Stable invariant check",
    });
    const guest = renderTip(input, "guest");
    const host = renderTip(input, "host");
    expect(guest!.templateId).toBe("authored-link-tip-v1");
    expect(host!.templateId).toBe("authored-link-tip-v1");
  });
});
