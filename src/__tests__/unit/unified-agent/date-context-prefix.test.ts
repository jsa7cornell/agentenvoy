/**
 * Tests for the date-context prefix the runner injects in front of the user
 * message before every streamText call.
 *
 * cmp50uvuq (2026-05-14): the model had no authoritative source of today's
 * date — the system prompt has no date substitution, and
 * LOAD_calendar_context only returns events + timezone (no current date).
 * When the host said "tomorrow", the model was guessing from training data;
 * for one observed turn it produced "May 8" for what should have been May
 * 14. The runner now prefixes every user message with
 * `[Context · today is <Weekday>, <YYYY-MM-DD> (<IANA TZ>)]`. Tests lock
 * in the shape so a future refactor doesn't drift the format.
 */

import { describe, it, expect } from "vitest";
import { prefixUserMessageWithDateContext } from "@/agent/unified/runner";

describe("prefixUserMessageWithDateContext", () => {
  // Anchored to a fixed UTC instant. 2026-05-14T20:00:00Z is:
  //   - America/Los_Angeles: Thursday 2026-05-14 (13:00 PDT)
  //   - Europe/London:        Thursday 2026-05-14 (21:00 BST)
  //   - Pacific/Auckland:     Friday   2026-05-15 (08:00 NZST)
  const FIXED_INSTANT = new Date("2026-05-14T20:00:00Z");

  it("prefixes with [Context · today is <Weekday>, <YYYY-MM-DD> (<TZ>)]", () => {
    const result = prefixUserMessageWithDateContext(
      "Grab 45m w/ Geoff tomorrow",
      "America/Los_Angeles",
      FIXED_INSTANT,
    );
    expect(result).toBe(
      "[Context · today is Thursday, 2026-05-14 (America/Los_Angeles)]\n\nGrab 45m w/ Geoff tomorrow",
    );
  });

  it("resolves the local day correctly across timezones (LA vs. Auckland on the same UTC instant)", () => {
    const la = prefixUserMessageWithDateContext("x", "America/Los_Angeles", FIXED_INSTANT);
    const auckland = prefixUserMessageWithDateContext("x", "Pacific/Auckland", FIXED_INSTANT);

    expect(la).toContain("Thursday, 2026-05-14");
    // Auckland is +12h ahead → already Friday May 15.
    expect(auckland).toContain("Friday, 2026-05-15");
  });

  it("uses sv-SE locale formatting for the ISO date portion (zero-padded YYYY-MM-DD)", () => {
    // Jan 5 should render "2026-01-05", not "2026-1-5".
    const earlyYear = new Date("2026-01-05T18:00:00Z");
    const result = prefixUserMessageWithDateContext(
      "x",
      "America/Los_Angeles",
      earlyYear,
    );
    expect(result).toContain("2026-01-05");
  });

  it("preserves the original user message verbatim after the blank line", () => {
    const msg = 'set up "Q3 board review" with Marcus tomorrow at 2pm — call it "important"';
    const result = prefixUserMessageWithDateContext(msg, "America/Los_Angeles", FIXED_INSTANT);
    // The original message is the last line after a blank separator.
    expect(result.endsWith("\n\n" + msg)).toBe(true);
  });

  it("falls back gracefully on an invalid IANA zone (uses UTC weekday/date rather than crashing)", () => {
    const result = prefixUserMessageWithDateContext(
      "x",
      "Not/A/Real/Zone",
      FIXED_INSTANT,
    );
    // Should still produce a usable prefix, just without the zone-correct day.
    // Anything is better than throwing.
    expect(result).toMatch(/^\[Context · today is \w+, \d{4}-\d{2}-\d{2} \(Not\/A\/Real\/Zone\)\]/);
    expect(result).toContain("\n\nx");
  });

  it("formats weekdays in long English form (not abbreviated)", () => {
    // Defensive: a regression to `weekday: "short"` would produce "Thu" and
    // make the prefix slightly less unambiguous when the model parses it.
    const result = prefixUserMessageWithDateContext("x", "UTC", FIXED_INSTANT);
    expect(result).toContain("Thursday");
    expect(result).not.toContain(", Thu, ");
  });
});
