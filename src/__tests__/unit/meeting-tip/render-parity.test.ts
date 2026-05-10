import { describe, expect, it } from "vitest";
import { renderTip } from "@/lib/meeting-tip/render";
import { buildTipInput } from "@/lib/meeting-tip/build-input";
import type { TipInput } from "@/lib/meeting-tip/types";

const baseInput = (overrides: Partial<TipInput> = {}): TipInput => ({
  hostFirstName: "John",
  guestFirstName: "Sarah",
  meetingFormat: "video",
  linkActivity: "coffee",
  isAnonymousLink: false,
  hasPriorSessions: false,
  isRecurring: false,
  ...overrides,
});

const fixtures: Array<{ name: string; input: TipInput }> = [
  { name: "authored-day-of", input: baseInput({ tipDayOf: "Sightglass courtyard out back" }) },
  { name: "authored-travel", input: baseInput({ tipTravel: "John in NYC May 13–15" }) },
  { name: "authored-format", input: baseInput({ tipFormat: "John prefers walking meetings" }) },
  { name: "derived-calendar-overlap", input: baseInput({ bothCalendarsConnected: true }) },
  { name: "derived-relationship-history", input: baseInput({ hasPriorSessions: true }) },
  { name: "derived-series-progress", input: baseInput({ isRecurring: true, recurringPosition: 5, recurringTotal: 10 }) },
  { name: "generative-fallback (with activity)", input: baseInput() },
  { name: "generative-fallback (no activity)", input: baseInput({ linkActivity: undefined }) },
  { name: "anonymous link (returns null)", input: baseInput({ isAnonymousLink: true }) },
];

describe("renderTip — AP5b parity invariant", () => {
  for (const { name, input } of fixtures) {
    it(`${name}: templateId is role-invariant`, () => {
      const guest = renderTip(input, "guest");
      const host = renderTip(input, "host");
      expect(guest?.templateId).toBe(host?.templateId);
    });
    it(`${name}: sourceKind is role-invariant`, () => {
      const guest = renderTip(input, "guest");
      const host = renderTip(input, "host");
      expect(guest?.sourceKind).toBe(host?.sourceKind);
    });
  }

  it("returns null for anonymous links with no derived data", () => {
    const result = renderTip(baseInput({ isAnonymousLink: true }), "guest");
    expect(result).toBeNull();
  });

  it("buildTipInput produces stable input for same args", () => {
    const args = { hostName: "John Smith", inviteeName: "Sarah Lee", linkFormat: "video", linkActivity: "coffee", linkLocation: null };
    expect(buildTipInput(args)).toEqual(buildTipInput(args));
  });
});
