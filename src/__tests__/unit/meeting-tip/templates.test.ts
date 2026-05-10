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

  it("generative-fallback ignores activity (locked 2026-05-10: no card-fact duplication)", () => {
    const r = renderTip({ ...base, linkActivity: "coffee" }, "guest");
    // Activity is in the card title/channel row already; tip should NOT repeat it.
    expect(r?.text).not.toContain("coffee");
    expect(r?.text).toBe("Looking forward to it — pick whatever time works.");
  });

  it("generative-fallback ignores host name (locked 2026-05-10: universal default)", () => {
    const r = renderTip(base, "guest");
    // Host name is in the avatar/who row already; tip should NOT repeat it.
    expect(r?.text).not.toContain("John");
    expect(r?.text).toBe("Looking forward to it — pick whatever time works.");
  });

  it("generative-fallback source label substitutes {host}", () => {
    const r = renderTip(base, "guest");
    expect(r?.source).toBe("From John");
  });
});

describe("source label substitution", () => {
  it("substitutes {host} with hostFirstName", () => {
    const r = renderTip({ ...base, tipDayOf: "anything" }, "guest");
    expect(r?.source).toBe("Day-of tip from John");
  });
});
