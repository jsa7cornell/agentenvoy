/**
 * buildChannelRow — ChannelInfo construction from resolved format/location/meetLink.
 *
 * Covers the three format branches (video, phone, in-person) plus guestPicksLocation,
 * meetLink inclusion, and null/undefined fallbacks.
 *
 * Decision: proposals/2026-05-14_event-record-alignment_reviewed-2026-05-14_decided-2026-05-14.md §2.3
 */

import { describe, it, expect } from "vitest";
import { buildChannelRow } from "@/lib/build-channel-row";

// ── Video ──────────────────────────────────────────────────────────────────

describe("video format", () => {
  it("returns kind:video with Google Meet platform", () => {
    const row = buildChannelRow("video", null, null);
    expect(row.kind).toBe("video");
    if (row.kind === "video") expect(row.platform).toBe("Google Meet");
  });

  it("includes joinUrl when meetLink is provided", () => {
    const row = buildChannelRow("video", null, "https://meet.google.com/abc-def-ghi");
    expect(row.kind).toBe("video");
    if (row.kind === "video") expect(row.joinUrl).toBe("https://meet.google.com/abc-def-ghi");
  });

  it("omits joinUrl when meetLink is null", () => {
    const row = buildChannelRow("video", null, null);
    expect(row.kind).toBe("video");
    if (row.kind === "video") expect(row.joinUrl).toBeUndefined();
  });

  it("null format defaults to video", () => {
    const row = buildChannelRow(null, null, null);
    expect(row.kind).toBe("video");
  });

  it("undefined format defaults to video", () => {
    const row = buildChannelRow(undefined, null, null);
    expect(row.kind).toBe("video");
  });
});

// ── Phone ─────────────────────────────────────────────────────────────────

describe("phone format", () => {
  it("returns kind:phone", () => {
    const row = buildChannelRow("phone", null, null);
    expect(row.kind).toBe("phone");
  });

  it("sets hostCallsGuest:true", () => {
    const row = buildChannelRow("phone", null, null);
    if (row.kind === "phone") expect(row.hostCallsGuest).toBe(true);
  });
});

// ── In-person ─────────────────────────────────────────────────────────────

describe("in-person format", () => {
  it("returns kind:in-person with provided location", () => {
    const row = buildChannelRow("in-person", "123 Main St", null);
    expect(row.kind).toBe("in-person");
    if (row.kind === "in-person") expect(row.location).toBe("123 Main St");
  });

  it("defaults location to 'TBD' when location is null", () => {
    const row = buildChannelRow("in-person", null, null);
    if (row.kind === "in-person") expect(row.location).toBe("TBD");
  });

  it("guestPicksLocation:true overrides provided location with 'TBD'", () => {
    const row = buildChannelRow("in-person", "123 Main St", null, false, true);
    if (row.kind === "in-person") expect(row.location).toBe("TBD");
  });

  it("guestPicksLocation:false preserves provided location", () => {
    const row = buildChannelRow("in-person", "123 Main St", null, false, false);
    if (row.kind === "in-person") expect(row.location).toBe("123 Main St");
  });
});

// ── guestPicksFormat — kind:TBD (cmp5sm07o display fix) ──────────────────
// These cells exist specifically because d185362 added the parameter to
// buildChannelRow but never used it — the dead-parameter gap that WALLOFSHAME
// Entry 4 documents. A passing test here means the flag is live, not dead.

describe("guestPicksFormat:true → kind:TBD", () => {
  it("returns kind:TBD when guestPicksFormat is true, ignoring format value", () => {
    const row = buildChannelRow("video", null, null, true);
    expect(row.kind).toBe("TBD");
  });

  it("returns kind:TBD even when format is 'in-person' (pre-fix DB state)", () => {
    // This is the exact contradictory state that caused the cmp5sm07o bug:
    // DB had format:"in-person" + guestPicks.format:true. Flag must win.
    const row = buildChannelRow("in-person", "Some Venue", null, true);
    expect(row.kind).toBe("TBD");
  });

  it("returns kind:TBD when format is null and guestPicksFormat is true", () => {
    const row = buildChannelRow(null, null, null, true);
    expect(row.kind).toBe("TBD");
  });

  it("does NOT return kind:TBD when guestPicksFormat is false", () => {
    const row = buildChannelRow("video", null, null, false);
    expect(row.kind).toBe("video");
  });
});

// ── Unknown / edge-case formats fall through to video ─────────────────────

describe("unrecognized format", () => {
  it("unknown format string defaults to video", () => {
    const row = buildChannelRow("hybrid", null, null);
    expect(row.kind).toBe("video");
  });
});
