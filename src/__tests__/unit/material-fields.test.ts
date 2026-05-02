import { describe, it, expect } from "vitest";
import {
  MATERIAL_FIELDS,
  FIELD_LABEL,
  isMaterialField,
  humanizeFieldList,
} from "@/lib/material-fields";

describe("material-fields — module shape", () => {
  it("MATERIAL_FIELDS includes the post-2026-05-01 set (availability + preferred replace legacy time/day fields)", () => {
    expect(MATERIAL_FIELDS).toEqual([
      "activity", "format", "duration", "location",
      "dateRange",
      "availability", "preferred",
      "blockedRanges",
      "inviteeNames", "topic",
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
    expect(isMaterialField("availability")).toBe(true);
    expect(isMaterialField("preferred")).toBe(true);
    expect(isMaterialField("blockedRanges")).toBe(true);
  });

  it("returns false for unknown / non-material fields", () => {
    expect(isMaterialField("lastResort")).toBe(false);
    expect(isMaterialField("intent")).toBe(false);
    expect(isMaterialField("isVip")).toBe(false);
    expect(isMaterialField("activityIcon")).toBe(false);
    expect(isMaterialField("nope")).toBe(false);
    // Removed legacy fields no longer count as material.
    expect(isMaterialField("preferredDays")).toBe(false);
    expect(isMaterialField("preferredTimeStart")).toBe(false);
    expect(isMaterialField("allowWeekends")).toBe(false);
    expect(isMaterialField("slotOverrides")).toBe(false);
  });
});

describe("humanizeFieldList", () => {
  it("maps canonical field names to display labels", () => {
    expect(humanizeFieldList(["activity", "duration"])).toEqual(["activity", "duration"]);
  });

  it("availability and preferred each have their own pill label", () => {
    expect(humanizeFieldList(["availability"])).toEqual(["availability"]);
    expect(humanizeFieldList(["preferred"])).toEqual(["preferences"]);
    expect(humanizeFieldList(["availability", "preferred"])).toEqual(["availability", "preferences"]);
  });

  it("preserves first-seen order across mixed fields with dedupe", () => {
    expect(
      humanizeFieldList(["activity", "availability", "blockedRanges"]),
    ).toEqual(["activity", "availability", "blocked time"]);
  });

  it("drops non-material entries silently (including removed legacy fields)", () => {
    expect(humanizeFieldList(["activity", "lastResort", "isVip", "duration"]))
      .toEqual(["activity", "duration"]);
    expect(humanizeFieldList(["activity", "preferredDays", "duration"]))
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
