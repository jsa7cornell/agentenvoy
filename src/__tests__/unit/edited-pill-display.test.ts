import { describe, it, expect } from "vitest";
import {
  computeEditedPillDisplay,
  EDITED_PILL_DEFAULT_FRESHNESS_MS,
} from "@/lib/edited-pill-display";

const FIXED_NOW = Date.parse("2026-04-29T12:00:00Z");
const minutesAgo = (m: number) =>
  new Date(FIXED_NOW - m * 60 * 1000).toISOString();
const opts = (overrides: Partial<Parameters<typeof computeEditedPillDisplay>[2]> = {}) => ({
  nowMs: FIXED_NOW,
  ...overrides,
});

describe("computeEditedPillDisplay — render conditions", () => {
  it("returns null when lastMaterialEditAt is null", () => {
    expect(computeEditedPillDisplay(null, ["activity"], opts())).toBeNull();
  });

  it("returns null when lastMaterialEditAt is undefined", () => {
    expect(computeEditedPillDisplay(undefined, ["activity"], opts())).toBeNull();
  });

  it("returns null when lastEditedFields is empty array", () => {
    expect(computeEditedPillDisplay(minutesAgo(1), [], opts())).toBeNull();
  });

  it("returns null when lastEditedFields is null", () => {
    expect(computeEditedPillDisplay(minutesAgo(1), null, opts())).toBeNull();
  });

  it("returns null when only non-material fields are listed", () => {
    expect(
      computeEditedPillDisplay(minutesAgo(1), ["lastResort", "isVip", "intent"], opts()),
    ).toBeNull();
  });

  it("returns null when older than the default freshness window", () => {
    expect(
      computeEditedPillDisplay(minutesAgo(10), ["activity"], opts()),
    ).toBeNull();
  });

  it("returns null when the timestamp is in the future (clock skew defense)", () => {
    const future = new Date(FIXED_NOW + 60 * 1000).toISOString();
    expect(computeEditedPillDisplay(future, ["activity"], opts())).toBeNull();
  });

  it("returns null when the timestamp is unparseable", () => {
    expect(
      computeEditedPillDisplay("not-a-date", ["activity"], opts()),
    ).toBeNull();
  });

  it("respects custom freshnessWindowMs (1 minute)", () => {
    // 2 min ago is fresh under default 5min, but stale under 1min override.
    expect(
      computeEditedPillDisplay(minutesAgo(2), ["activity"], opts({ freshnessWindowMs: 60_000 })),
    ).toBeNull();
  });

  it("default freshness window matches the published constant", () => {
    expect(EDITED_PILL_DEFAULT_FRESHNESS_MS).toBe(5 * 60 * 1000);
  });
});

describe("computeEditedPillDisplay — age labels", () => {
  it("returns 'just now' for ages under 60 seconds", () => {
    const r = computeEditedPillDisplay(
      new Date(FIXED_NOW - 30_000).toISOString(),
      ["activity"],
      opts(),
    );
    expect(r?.ageLabel).toBe("just now");
  });

  it("returns '1 min ago' (singular) at exactly 1 minute", () => {
    const r = computeEditedPillDisplay(minutesAgo(1), ["activity"], opts());
    expect(r?.ageLabel).toBe("1 min ago");
  });

  it("returns 'N min ago' (plural form, no 's' on min) for ≥2 minutes", () => {
    const r = computeEditedPillDisplay(minutesAgo(3), ["activity"], opts());
    expect(r?.ageLabel).toBe("3 min ago");
    expect(r?.ageLabel).not.toContain("3 mins");
  });

  it("returns 'just now' at exactly 0ms age", () => {
    const r = computeEditedPillDisplay(new Date(FIXED_NOW).toISOString(), ["activity"], opts());
    expect(r?.ageLabel).toBe("just now");
  });
});

describe("computeEditedPillDisplay — field list", () => {
  it("renders single field humanized", () => {
    const r = computeEditedPillDisplay(minutesAgo(1), ["activity"], opts());
    expect(r?.fieldList).toBe("activity");
  });

  it("renders availability label", () => {
    const r = computeEditedPillDisplay(
      minutesAgo(1),
      ["availability"],
      opts(),
    );
    expect(r?.fieldList).toBe("availability");
  });

  it("preserves order across mixed fields with dedupe", () => {
    const r = computeEditedPillDisplay(
      minutesAgo(1),
      ["activity", "availability", "blockedRanges"],
      opts(),
    );
    expect(r?.fieldList).toBe("activity, availability, blocked time");
  });

  it("humanizes inviteeNames as 'guests' and topic as 'title'", () => {
    const r = computeEditedPillDisplay(
      minutesAgo(1),
      ["inviteeNames", "topic"],
      opts(),
    );
    expect(r?.fieldList).toBe("guests, title");
  });

  it("drops non-material entries silently when mixed with material ones", () => {
    const r = computeEditedPillDisplay(
      minutesAgo(1),
      ["activity", "lastResort", "isVip", "duration"],
      opts(),
    );
    expect(r?.fieldList).toBe("activity, duration");
  });

  it("the original Bug 2 reproducer renders correctly", () => {
    // After the host says "for drinks with pete - make my evenings available
    // for him, except for thursday evening", the patch touches
    // availability + blockedRanges (under the post-2026-05-01 schema).
    const r = computeEditedPillDisplay(
      minutesAgo(0),
      ["availability", "blockedRanges"],
      opts(),
    );
    expect(r?.ageLabel).toBe("just now");
    expect(r?.fieldList).toBe("availability, blocked time");
  });
});
