import { describe, it, expect } from "vitest";
import {
  MATERIAL_FIELDS,
  FIELD_LABEL,
  isMaterialField,
  humanizeFieldList,
} from "@/lib/material-fields";

describe("material-fields — module shape", () => {
  it("MATERIAL_FIELDS is the canonical set the proposal §3.C names", () => {
    expect(MATERIAL_FIELDS).toEqual([
      "activity", "format", "duration", "location",
      "dateRange", "preferredTimeStart", "preferredTimeEnd",
      "preferredTimeWindows", "preferredDays", "blockedRanges",
      "inviteeNames", "topic",
      // Added in proposal 2026-04-29_link-handler-consolidation §3.F.4.
      "guestPicks", "guestGuidance",
    ]);
  });

  it("every material field has a non-empty humanizer label", () => {
    for (const f of MATERIAL_FIELDS) {
      expect(FIELD_LABEL[f]).toBeDefined();
      expect(FIELD_LABEL[f].length).toBeGreaterThan(0);
    }
  });
});

describe("isMaterialField", () => {
  it("returns true for canonical entries", () => {
    expect(isMaterialField("activity")).toBe(true);
    expect(isMaterialField("preferredTimeStart")).toBe(true);
    expect(isMaterialField("blockedRanges")).toBe(true);
  });

  it("returns false for unknown / non-material fields", () => {
    expect(isMaterialField("lastResort")).toBe(false);
    expect(isMaterialField("intent")).toBe(false);
    expect(isMaterialField("isVip")).toBe(false);
    expect(isMaterialField("activityIcon")).toBe(false);
    expect(isMaterialField("nope")).toBe(false);
  });
});

describe("humanizeFieldList", () => {
  it("maps canonical field names to display labels", () => {
    expect(humanizeFieldList(["activity", "duration"])).toEqual(["activity", "duration"]);
  });

  it("dedupes preserving first-seen order — multiple time fields collapse to 'hours'", () => {
    expect(humanizeFieldList(["preferredTimeStart", "preferredTimeEnd"])).toEqual(["hours"]);
    expect(humanizeFieldList(["preferredTimeStart", "preferredTimeEnd", "preferredTimeWindows"]))
      .toEqual(["hours"]);
  });

  it("preserves first-seen order across mixed fields with dedupe", () => {
    expect(
      humanizeFieldList(["activity", "preferredTimeStart", "preferredTimeEnd", "blockedRanges"]),
    ).toEqual(["activity", "hours", "blocked time"]);
  });

  it("drops non-material entries silently", () => {
    expect(humanizeFieldList(["activity", "lastResort", "isVip", "duration"]))
      .toEqual(["activity", "duration"]);
  });

  it("returns empty array for empty input", () => {
    expect(humanizeFieldList([])).toEqual([]);
  });

  it("does not mangle invitee/topic labels", () => {
    expect(humanizeFieldList(["inviteeNames"])).toEqual(["guests"]);
    expect(humanizeFieldList(["topic"])).toEqual(["title"]);
    expect(humanizeFieldList(["dateRange"])).toEqual(["dates"]);
  });
});
