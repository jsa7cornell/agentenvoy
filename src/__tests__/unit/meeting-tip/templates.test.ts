import { describe, expect, it } from "vitest";
import { renderTip } from "@/lib/meeting-tip/render";
import type { TipInput } from "@/lib/meeting-tip/types";

const base: TipInput = {
  hostFirstName: "John",
  guestFirstName: "Sarah",
  meetingFormat: "video",
  isAnonymousLink: false,
  hasPriorSessions: false,
  isRecurring: false,
};

describe("priority ordering", () => {
  it("authored-day-of beats authored-travel beats derived", () => {
    const input: TipInput = {
      ...base,
      tipDayOf: "DAY-OF",
      tipTravel: "TRAVEL",
      hasPriorSessions: true,
      bothCalendarsConnected: true,
    };
    expect(renderTip(input, "guest")?.templateId).toBe("authored-day-of-v1");
  });

  it("falls through to generative when no authored/derived", () => {
    expect(renderTip({ ...base, linkActivity: "coffee" }, "guest")?.sourceKind)
      .toBe("generative-fallback");
  });
});

describe("text rendering", () => {
  it("authored-day-of returns text verbatim", () => {
    const r = renderTip({ ...base, tipDayOf: "Studio buzzer broken" }, "guest");
    expect(r?.text).toBe("Studio buzzer broken");
  });

  it("derived-calendar-overlap mentions other party", () => {
    const r = renderTip({ ...base, bothCalendarsConnected: true }, "guest");
    expect(r?.text).toContain("John");
  });

  it("derived-series-progress includes position + total", () => {
    const r = renderTip({ ...base, isRecurring: true, recurringPosition: 7, recurringTotal: 12 }, "guest");
    expect(r?.text).toContain("7");
    expect(r?.text).toContain("12");
  });

  it("generative-fallback includes activity when set", () => {
    const r = renderTip({ ...base, linkActivity: "coffee" }, "guest");
    expect(r?.text).toContain("coffee");
    expect(r?.text).toContain("John");
  });

  it("generative-fallback works without activity", () => {
    const r = renderTip(base, "guest");
    expect(r?.text).toContain("John");
  });
});

describe("source label substitution", () => {
  it("substitutes {host} with hostFirstName", () => {
    const r = renderTip({ ...base, tipDayOf: "anything" }, "guest");
    expect(r?.source).toBe("Day-of tip from John");
  });
});
