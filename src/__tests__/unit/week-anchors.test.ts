/**
 * Unit tests for computeWeekAnchors — the "this week / next week"
 * disambiguator the LLM prompt depends on.
 *
 * Rule (per John 2026-04-18):
 *   - Mon–Sat: "next week" unambiguously = the following Monday onwards.
 *   - Sun: "next week" is AMBIGUOUS; tomorrow or 8 days out, depending on
 *     the speaker. Must confirm before acting.
 */

import { describe, expect, it } from "vitest";
import {
  computeWeekAnchors,
  formatWeekAnchorsForPrompt,
} from "@/lib/week-anchors";

const PT = "America/Los_Angeles";
const ET = "America/New_York";

// Pick a concrete week in 2026 for stable assertions.
// 2026-04-13 = Monday, 2026-04-19 = Sunday.
// 2026-04-20 = next Monday, 2026-04-26 = next Sunday.
function on(day: string, timeLocal = "12:00:00"): Date {
  // Fixed -07:00 offset (matches PT outside DST-edge dates used in tests).
  // Noon keeps us safely inside the host's day regardless of tz shift.
  return new Date(`${day}T${timeLocal}-07:00`);
}

describe("computeWeekAnchors", () => {
  it("resolves THIS WEEK / NEXT WEEK when today is a Wednesday", () => {
    const a = computeWeekAnchors(on("2026-04-15"), PT);
    expect(a.today).toBe("Wed, Apr 15, 2026");
    expect(a.todayWeekday).toBe("Wed");
    expect(a.thisWeekStart).toBe("Mon, Apr 13, 2026");
    expect(a.thisWeekEnd).toBe("Sun, Apr 19, 2026");
    expect(a.nextWeekStart).toBe("Mon, Apr 20, 2026");
    expect(a.nextWeekEnd).toBe("Sun, Apr 26, 2026");
    expect(a.nextWeekUnambiguous).toBe(true);
  });

  it("keeps Monday as the anchor when today IS Monday", () => {
    const a = computeWeekAnchors(on("2026-04-13"), PT);
    expect(a.today).toBe("Mon, Apr 13, 2026");
    expect(a.thisWeekStart).toBe("Mon, Apr 13, 2026");
    expect(a.thisWeekEnd).toBe("Sun, Apr 19, 2026");
    expect(a.nextWeekStart).toBe("Mon, Apr 20, 2026");
    expect(a.nextWeekUnambiguous).toBe(true);
  });

  it("treats Saturday as mid-week-enough: next week is unambiguous", () => {
    const a = computeWeekAnchors(on("2026-04-18"), PT);
    expect(a.today).toBe("Sat, Apr 18, 2026");
    expect(a.thisWeekStart).toBe("Mon, Apr 13, 2026");
    expect(a.nextWeekStart).toBe("Mon, Apr 20, 2026");
    expect(a.nextWeekUnambiguous).toBe(true);
  });

  it("marks Sunday as AMBIGUOUS for 'next week' — must confirm", () => {
    const a = computeWeekAnchors(on("2026-04-19"), PT);
    expect(a.today).toBe("Sun, Apr 19, 2026");
    expect(a.todayWeekday).toBe("Sun");
    // This week still contains the Sunday — Mon Apr 13 – Sun Apr 19.
    expect(a.thisWeekStart).toBe("Mon, Apr 13, 2026");
    expect(a.thisWeekEnd).toBe("Sun, Apr 19, 2026");
    // Next week starts the following Monday (tomorrow) — but speaker
    // ambiguity means we don't commit.
    expect(a.nextWeekStart).toBe("Mon, Apr 20, 2026");
    expect(a.nextWeekUnambiguous).toBe(false);
  });

  it("computes the right week when today is a Friday (end of week)", () => {
    const a = computeWeekAnchors(on("2026-04-17"), PT);
    expect(a.today).toBe("Fri, Apr 17, 2026");
    expect(a.thisWeekStart).toBe("Mon, Apr 13, 2026");
    expect(a.nextWeekStart).toBe("Mon, Apr 20, 2026");
    expect(a.nextWeekUnambiguous).toBe(true);
  });

  it("respects the host timezone when the server and host differ", () => {
    // A moment that is Saturday 11:30 PM ET but already Sunday 03:30 UTC.
    // In PT (3 hours behind ET), it's Saturday evening. The anchors must
    // reflect the host's local day, not server-local.
    const at = new Date("2026-04-18T23:30:00-04:00");
    const et = computeWeekAnchors(at, ET);
    expect(et.todayWeekday).toBe("Sat");
    expect(et.nextWeekUnambiguous).toBe(true);

    const pt = computeWeekAnchors(at, PT);
    expect(pt.todayWeekday).toBe("Sat");
    expect(pt.nextWeekUnambiguous).toBe(true);
  });

  it("crosses a month boundary correctly (today = late April)", () => {
    const a = computeWeekAnchors(on("2026-04-29"), PT);
    expect(a.today).toBe("Wed, Apr 29, 2026");
    // This week: Mon Apr 27 – Sun May 3.
    expect(a.thisWeekStart).toBe("Mon, Apr 27, 2026");
    expect(a.thisWeekEnd).toBe("Sun, May 3, 2026");
    // Next week: Mon May 4 – Sun May 10.
    expect(a.nextWeekStart).toBe("Mon, May 4, 2026");
    expect(a.nextWeekEnd).toBe("Sun, May 10, 2026");
  });
});

describe("formatWeekAnchorsForPrompt", () => {
  it("emits a terse three-line block on mid-week", () => {
    const a = computeWeekAnchors(on("2026-04-15"), PT);
    const out = formatWeekAnchorsForPrompt(a);
    expect(out).toMatch(/TODAY: Wed, Apr 15, 2026/);
    expect(out).toMatch(/THIS WEEK: Mon, Apr 13, 2026 – Sun, Apr 19, 2026/);
    expect(out).toMatch(/NEXT WEEK: Mon, Apr 20, 2026 – Sun, Apr 26, 2026/);
    expect(out).not.toMatch(/AMBIGUOUS/);
  });

  it("includes an AMBIGUOUS note when today is Sunday", () => {
    const a = computeWeekAnchors(on("2026-04-19"), PT);
    const out = formatWeekAnchorsForPrompt(a);
    expect(out).toMatch(/TODAY: Sun, Apr 19, 2026/);
    expect(out).toMatch(/"next week" is AMBIGUOUS/i);
    expect(out).toMatch(/Confirm with them/i);
  });
});
