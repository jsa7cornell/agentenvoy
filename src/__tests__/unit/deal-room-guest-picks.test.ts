/**
 * Unit tests for guestPicks deferral signals on the MeetingCard mapping function.
 *
 * Tests cover the proposal-state path only — confirmed-state path intentionally
 * ignores guestPicks (the picked values win post-confirm).
 *
 * See proposal 2026-05-11_llm-tip-seed-at-create-link.md §2 (four-surface table)
 * for which surfaces are in scope; this file covers the Card column.
 */

import { describe, it, expect } from "vitest";
import {
  dealRoomToMeetingCardProps,
  type DealRoomConfirmedSnapshot,
} from "@/components/deal-room/dealRoomToMeetingCardProps";

// ── Base snapshot — proposal state (no confirmData) ──────────────────────────

const PROPOSAL_BASE: DealRoomConfirmedSnapshot = {
  isHost: false,
  hostName: "John Anderson",
  inviteeName: "Sarah Chen",
  confirmData: null,
  linkActivity: "Coffee",
  linkLocation: null,
  sessionTimezone: "America/Los_Angeles",
  slotTimezone: "America/New_York",
  linkParameters: null,
  userPrimaryTip: null,
  gcalEventUrl: null,
  linkFormat: "in-person",
  linkGuestPicks: null,
};

// ── (a) guestPicks.location = true → channel.kind=in-person, guestPicks=true, location="" ──

describe("deal-room-guest-picks — location deferral", () => {
  it("(a) guestPicks.location=true → channel.kind=in-person, channel.guestPicks=true, location empty", () => {
    const result = dealRoomToMeetingCardProps({
      ...PROPOSAL_BASE,
      linkFormat: "in-person",
      linkGuestPicks: { location: true },
    });
    expect(result).not.toBeNull();
    expect(result?.channel.kind).toBe("in-person");
    if (result?.channel.kind === "in-person") {
      expect(result.channel.guestPicks).toBe(true);
      expect(result.channel.location).toBe("");
    }
    // formatGuestPicks should NOT be set
    expect(result?.formatGuestPicks).toBeUndefined();
  });

  it("(a-host) host viewer also gets guestPicks=true on the channel", () => {
    const result = dealRoomToMeetingCardProps({
      ...PROPOSAL_BASE,
      isHost: true,
      linkFormat: "in-person",
      linkGuestPicks: { location: true },
    });
    if (result?.channel.kind === "in-person") {
      expect(result.channel.guestPicks).toBe(true);
    }
  });
});

// ── (b) guestPicks.format = true → formatGuestPicks=true on props ────────────

describe("deal-room-guest-picks — format deferral (boolean)", () => {
  it("(b) guestPicks.format=true → formatGuestPicks=true on returned props", () => {
    const result = dealRoomToMeetingCardProps({
      ...PROPOSAL_BASE,
      linkGuestPicks: { format: true },
    });
    expect(result).not.toBeNull();
    expect(result?.formatGuestPicks).toBe(true);
  });

  it("(b) channel kind is in-person sentinel when format deferred", () => {
    const result = dealRoomToMeetingCardProps({
      ...PROPOSAL_BASE,
      linkGuestPicks: { format: true },
    });
    // Sentinel channel — renderer uses formatGuestPicks to override the display
    expect(result?.channel.kind).toBe("in-person");
    if (result?.channel.kind === "in-person") {
      expect(result.channel.location).toBe("");
      // guestPicks on the channel itself should NOT be true (format row handles this)
      expect(result.channel.guestPicks).toBeUndefined();
    }
  });
});

// ── (c) guestPicks.format = ["video", "phone"] → formatGuestPicks = ["video", "phone"] ──

describe("deal-room-guest-picks — format deferral (constrained subset)", () => {
  it("(c) guestPicks.format=array → formatGuestPicks carries the array", () => {
    const result = dealRoomToMeetingCardProps({
      ...PROPOSAL_BASE,
      linkGuestPicks: { format: ["video", "phone"] },
    });
    expect(result).not.toBeNull();
    expect(result?.formatGuestPicks).toEqual(["video", "phone"]);
  });

  it("(c) single-element array is preserved", () => {
    const result = dealRoomToMeetingCardProps({
      ...PROPOSAL_BASE,
      linkGuestPicks: { format: ["video"] },
    });
    expect(result?.formatGuestPicks).toEqual(["video"]);
  });
});

// ── (d) no guestPicks → props unchanged from prior behavior ──────────────────

describe("deal-room-guest-picks — no deferral", () => {
  it("(d) null linkGuestPicks → no guestPicks or formatGuestPicks on returned props", () => {
    const result = dealRoomToMeetingCardProps({
      ...PROPOSAL_BASE,
      linkFormat: "video",
      linkGuestPicks: null,
    });
    expect(result).not.toBeNull();
    expect(result?.formatGuestPicks).toBeUndefined();
    // channel should be normal video
    expect(result?.channel.kind).toBe("video");
    if (result?.channel.kind === "in-person") {
      expect(result.channel.guestPicks).toBeUndefined();
    }
  });

  it("(d) absent linkGuestPicks → same behavior as null", () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { linkGuestPicks: _gp, ...rest } = PROPOSAL_BASE;
    const result = dealRoomToMeetingCardProps({
      ...rest,
      linkFormat: "in-person",
      linkLocation: "Blue Bottle Coffee",
    });
    expect(result?.formatGuestPicks).toBeUndefined();
    if (result?.channel.kind === "in-person") {
      expect(result.channel.guestPicks).toBeUndefined();
      expect(result.channel.location).toBe("Blue Bottle Coffee");
    }
  });
});

// ── (e) confirmed-state: guestPicks signals are NOT surfaced ─────────────────

describe("deal-room-guest-picks — confirmed state ignores guestPicks", () => {
  it("(e) confirmed snapshot with guestPicks.location=true → no guestPicks on channel", () => {
    const result = dealRoomToMeetingCardProps({
      ...PROPOSAL_BASE,
      confirmData: {
        dateTime: "2026-05-19T16:30:00Z",
        format: "in-person",
        duration: 30,
        location: "Sightglass Coffee",
      },
      linkGuestPicks: { location: true },
    });
    expect(result).not.toBeNull();
    expect(result?.state).toBe("confirmed");
    // Confirmed path uses the actual picked location — guestPicks irrelevant
    if (result?.channel.kind === "in-person") {
      expect(result.channel.guestPicks).toBeUndefined();
      expect(result.channel.location).toBe("Sightglass Coffee");
    }
    expect(result?.formatGuestPicks).toBeUndefined();
  });

  it("(e) confirmed snapshot with guestPicks.format=true → no formatGuestPicks", () => {
    const result = dealRoomToMeetingCardProps({
      ...PROPOSAL_BASE,
      confirmData: {
        dateTime: "2026-05-19T16:30:00Z",
        format: "video",
        duration: 30,
        meetLink: "https://meet.google.com/abc-def",
      },
      linkGuestPicks: { format: true },
    });
    expect(result?.formatGuestPicks).toBeUndefined();
    expect(result?.channel.kind).toBe("video");
  });
});
