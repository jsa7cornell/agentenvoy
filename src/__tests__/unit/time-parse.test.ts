import { describe, it, expect } from "vitest";
import {
  parseGuestTimeReferences,
  renderParsedTime,
  parseBusinessHoursRange,
} from "@/lib/time-parse";

const ET = "America/New_York";
const PT = "America/Los_Angeles";

describe("parseGuestTimeReferences", () => {
  it("returns [] on empty input", () => {
    expect(parseGuestTimeReferences("", ET)).toEqual([]);
    expect(parseGuestTimeReferences("   ", ET)).toEqual([]);
  });

  it("returns [] when viewerTimezone is missing", () => {
    expect(parseGuestTimeReferences("3pm works", "")).toEqual([]);
  });

  it("parses a bare pm time", () => {
    const refs = parseGuestTimeReferences("3pm works for me", ET);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      hour: 15,
      minute: 0,
      dayAnchor: null,
      ambiguous: false,
      viewerTimezone: ET,
    });
  });

  it("parses a bare am time", () => {
    const refs = parseGuestTimeReferences("how about 10am tomorrow?", ET);
    // Finds the 10am reference; dayAnchor comes from "tomorrow" preceding it
    // only when adjacent. "how about 10am tomorrow" → 10am is bare.
    const tenAm = refs.find((r) => r.hour === 10);
    expect(tenAm).toBeDefined();
    expect(tenAm?.ambiguous).toBe(false);
  });

  it("parses 24-hour form without meridiem unambiguously", () => {
    const refs = parseGuestTimeReferences("can we do 15:00?", ET);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ hour: 15, minute: 0, ambiguous: false });
  });

  it("flags 3:30 without am/pm as ambiguous", () => {
    const refs = parseGuestTimeReferences("3:30 would be great", ET);
    expect(refs).toHaveLength(1);
    expect(refs[0].ambiguous).toBe(true);
    expect(refs[0].hour).toBeNull();
    expect(refs[0].minute).toBe(30);
  });

  it("parses 12pm → 12 and 12am → 0", () => {
    const noon = parseGuestTimeReferences("12pm works", ET);
    expect(noon[0].hour).toBe(12);
    const midnight = parseGuestTimeReferences("12am please", ET);
    expect(midnight[0].hour).toBe(0);
  });

  it("captures a weekday day anchor", () => {
    const refs = parseGuestTimeReferences("Thursday 10am", ET);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      hour: 10,
      dayAnchor: "thursday",
      ambiguous: false,
    });
  });

  it("captures tomorrow/today day anchors", () => {
    const tomorrow = parseGuestTimeReferences("tomorrow at 2pm", ET);
    expect(tomorrow[0]).toMatchObject({ hour: 14, dayAnchor: "tomorrow" });
    const today = parseGuestTimeReferences("today at 3:15pm", ET);
    expect(today[0]).toMatchObject({
      hour: 15,
      minute: 15,
      dayAnchor: "today",
    });
  });

  it("handles 3:30pm with minutes", () => {
    const refs = parseGuestTimeReferences("how about 3:30pm", ET);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      hour: 15,
      minute: 30,
      ambiguous: false,
    });
  });

  it("skips bare numeric tokens with no disambiguating signal", () => {
    // "$3 for lunch" or "we have 3 options" shouldn't parse as 3pm.
    expect(parseGuestTimeReferences("$3 for lunch", PT)).toEqual([]);
    expect(parseGuestTimeReferences("we have 3 options", PT)).toEqual([]);
  });

  it("dedupes identical references in one message", () => {
    const refs = parseGuestTimeReferences("3pm works. yeah 3pm is great.", ET);
    expect(refs).toHaveLength(1);
  });

  it("returns multiple distinct references in one message", () => {
    const refs = parseGuestTimeReferences("either 2pm or 4pm works", ET);
    expect(refs).toHaveLength(2);
    expect(refs.map((r) => r.hour).sort()).toEqual([14, 16]);
  });

  it("handles case variants and punctuation in meridiem", () => {
    expect(parseGuestTimeReferences("3 P.M.", ET)[0].hour).toBe(15);
    expect(parseGuestTimeReferences("3 PM", ET)[0].hour).toBe(15);
    expect(parseGuestTimeReferences("3 pm", ET)[0].hour).toBe(15);
    expect(parseGuestTimeReferences("3 a.m.", ET)[0].hour).toBe(3);
  });

  it("attaches viewerTimezone to every parsed reference", () => {
    const refs = parseGuestTimeReferences("3pm or 4pm", PT);
    for (const ref of refs) expect(ref.viewerTimezone).toBe(PT);
  });
});

describe("renderParsedTime", () => {
  it("renders pm times casually", () => {
    expect(
      renderParsedTime({
        raw: "3pm",
        hour: 15,
        minute: 0,
        dayAnchor: null,
        ambiguous: false,
        viewerTimezone: ET,
      }),
    ).toBe("3pm");
  });

  it("renders minute-included times with colon", () => {
    expect(
      renderParsedTime({
        raw: "3:30pm",
        hour: 15,
        minute: 30,
        dayAnchor: null,
        ambiguous: false,
        viewerTimezone: ET,
      }),
    ).toBe("3:30pm");
  });

  it("renders 12pm and 12am correctly", () => {
    expect(
      renderParsedTime({
        raw: "noon",
        hour: 12,
        minute: 0,
        dayAnchor: null,
        ambiguous: false,
        viewerTimezone: ET,
      }),
    ).toBe("12pm");
    expect(
      renderParsedTime({
        raw: "midnight",
        hour: 0,
        minute: 0,
        dayAnchor: null,
        ambiguous: false,
        viewerTimezone: ET,
      }),
    ).toBe("12am");
  });

  it("returns null for ambiguous references", () => {
    expect(
      renderParsedTime({
        raw: "3:30",
        hour: null,
        minute: 30,
        dayAnchor: null,
        ambiguous: true,
        viewerTimezone: ET,
      }),
    ).toBeNull();
  });
});

describe("parseBusinessHoursRange", () => {
  it("parses am/pm explicit range", () => {
    expect(parseBusinessHoursRange("8am to 5pm")).toEqual({
      startMinutes: 480,
      endMinutes: 1020,
    });
    expect(parseBusinessHoursRange("9:30am-6pm")).toEqual({
      startMinutes: 570,
      endMinutes: 1080,
    });
  });

  it("infers am/pm for ambiguous bare-hour pairs", () => {
    // "9 to 5" → 9am / 5pm
    expect(parseBusinessHoursRange("9 to 5")).toEqual({
      startMinutes: 540,
      endMinutes: 1020,
    });
    expect(parseBusinessHoursRange("8:30 to 5:30")).toEqual({
      startMinutes: 510,
      endMinutes: 1050,
    });
  });

  it("accepts 24-hour form", () => {
    expect(parseBusinessHoursRange("09:00-17:00")).toEqual({
      startMinutes: 540,
      endMinutes: 1020,
    });
    expect(parseBusinessHoursRange("14 to 18")).toEqual({
      startMinutes: 840,
      endMinutes: 1080,
    });
  });

  it("inherits meridiem across sides", () => {
    // start has meridiem, end inherits
    expect(parseBusinessHoursRange("8am-6")).toEqual({
      startMinutes: 480,
      endMinutes: 1080,
    });
    // end has meridiem, start inherits am
    expect(parseBusinessHoursRange("9 to 5pm")).toEqual({
      startMinutes: 540,
      endMinutes: 1020,
    });
  });

  it("rejects non-30-min-aligned times", () => {
    expect(parseBusinessHoursRange("8:27 to 5:30")).toBeNull();
    expect(parseBusinessHoursRange("9:15-5:00")).toBeNull();
  });

  it("rejects malformed or backwards ranges", () => {
    expect(parseBusinessHoursRange("")).toBeNull();
    expect(parseBusinessHoursRange("blah")).toBeNull();
    expect(parseBusinessHoursRange("5pm to 9am")).toBeNull();
    expect(parseBusinessHoursRange("9am to 9am")).toBeNull();
  });
});
