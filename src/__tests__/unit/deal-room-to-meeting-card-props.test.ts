/**
 * Unit tests for dealRoomToMeetingCardProps — PR2a mapping function.
 *
 * These tests cover the pure transformation; deal-room.tsx integration
 * is deliberately NOT tested here (component too tangled to render in
 * isolation). See proposal 2026-05-09 PR2a.
 */

import { describe, it, expect } from "vitest";
import {
  dealRoomToMeetingCardProps,
  type DealRoomConfirmedSnapshot,
} from "@/components/deal-room/dealRoomToMeetingCardProps";
import { renderTip } from "@/lib/meeting-tip/render";
import { buildTipInput } from "@/lib/meeting-tip/build-input";

// ── Shared base snapshot ──────────────────────────────────────────────────────

const BASE_SNAPSHOT: DealRoomConfirmedSnapshot = {
  isHost: false,
  hostName: "John Anderson",
  inviteeName: "Sarah Chen",
  confirmData: {
    dateTime: "2026-05-19T16:30:00Z",
    format: "video",
    duration: 30,
    meetLink: "https://meet.google.com/abc-def-ghi",
  },
  linkActivity: "Coffee",
  linkLocation: null,
  sessionTimezone: "America/Los_Angeles",
  slotTimezone: "America/New_York",
};

// ── Null-return guards ────────────────────────────────────────────────────────

describe("dealRoomToMeetingCardProps — null-return guards", () => {
  it("returns null when confirmData is null", () => {
    const result = dealRoomToMeetingCardProps({
      ...BASE_SNAPSHOT,
      confirmData: null,
    });
    expect(result).toBeNull();
  });

  it("returns null when confirmData.dateTime is missing", () => {
    const result = dealRoomToMeetingCardProps({
      ...BASE_SNAPSHOT,
      confirmData: { format: "video", duration: 30 },
    });
    expect(result).toBeNull();
  });

  it("returns null when confirmData.dateTime is not a string", () => {
    const result = dealRoomToMeetingCardProps({
      ...BASE_SNAPSHOT,
      confirmData: { dateTime: 1234567890, format: "video", duration: 30 },
    });
    expect(result).toBeNull();
  });

  it("returns null when confirmData.dateTime is an invalid date string", () => {
    const result = dealRoomToMeetingCardProps({
      ...BASE_SNAPSHOT,
      confirmData: { dateTime: "not-a-date", format: "video", duration: 30 },
    });
    expect(result).toBeNull();
  });
});

// ── Channel discrimination ────────────────────────────────────────────────────

describe("dealRoomToMeetingCardProps — channel discrimination", () => {
  it("produces channel.kind === 'video' for format=video", () => {
    const result = dealRoomToMeetingCardProps({
      ...BASE_SNAPSHOT,
      confirmData: {
        ...BASE_SNAPSHOT.confirmData,
        format: "video",
        meetLink: "https://meet.google.com/abc",
      },
    });
    expect(result?.channel.kind).toBe("video");
  });

  it("detects Zoom from meetLink", () => {
    const result = dealRoomToMeetingCardProps({
      ...BASE_SNAPSHOT,
      confirmData: {
        ...BASE_SNAPSHOT.confirmData,
        format: "video",
        meetLink: "https://zoom.us/j/123456789",
      },
    });
    expect(result?.channel.kind).toBe("video");
    if (result?.channel.kind === "video") {
      expect(result.channel.platform).toBe("Zoom");
    }
  });

  it("uses Google Meet when meetLink doesn't include zoom.us", () => {
    const result = dealRoomToMeetingCardProps({
      ...BASE_SNAPSHOT,
      confirmData: {
        ...BASE_SNAPSHOT.confirmData,
        format: "video",
        meetLink: "https://meet.google.com/abc-def",
      },
    });
    if (result?.channel.kind === "video") {
      expect(result.channel.platform).toBe("Google Meet");
    }
  });

  it("produces channel.kind === 'phone' for format=phone", () => {
    const result = dealRoomToMeetingCardProps({
      ...BASE_SNAPSHOT,
      confirmData: {
        ...BASE_SNAPSHOT.confirmData,
        format: "phone",
      },
    });
    expect(result?.channel.kind).toBe("phone");
    if (result?.channel.kind === "phone") {
      expect(result.channel.hostCallsGuest).toBe(true);
    }
  });

  it("produces channel.kind === 'in-person' for format=in-person", () => {
    const result = dealRoomToMeetingCardProps({
      ...BASE_SNAPSHOT,
      confirmData: {
        ...BASE_SNAPSHOT.confirmData,
        format: "in-person",
        location: "Sightglass Coffee",
      },
    });
    expect(result?.channel.kind).toBe("in-person");
    if (result?.channel.kind === "in-person") {
      expect(result.channel.location).toBe("Sightglass Coffee");
    }
  });

  it("falls back to linkLocation for in-person when confirmData.location absent", () => {
    const result = dealRoomToMeetingCardProps({
      ...BASE_SNAPSHOT,
      confirmData: {
        ...BASE_SNAPSHOT.confirmData,
        format: "in-person",
        // no location in confirmData
      },
      linkLocation: "Blue Bottle Coffee",
    });
    if (result?.channel.kind === "in-person") {
      expect(result.channel.location).toBe("Blue Bottle Coffee");
    }
  });

  it("falls back to 'TBD' for in-person when no location available", () => {
    const result = dealRoomToMeetingCardProps({
      ...BASE_SNAPSHOT,
      confirmData: {
        ...BASE_SNAPSHOT.confirmData,
        format: "in-person",
      },
      linkLocation: null,
    });
    if (result?.channel.kind === "in-person") {
      expect(result.channel.location).toBe("TBD");
    }
  });
});

// ── Tip derivation ────────────────────────────────────────────────────────────

describe("dealRoomToMeetingCardProps — tip derivation", () => {
  it("tip is set from generative-fallback when linkActivity is present", () => {
    const result = dealRoomToMeetingCardProps({
      ...BASE_SNAPSHOT,
      linkActivity: "Coffee",
    });
    expect(result?.tip).toBeDefined();
    expect(result?.tip?.text).toContain("Coffee");
    expect(result?.tip?.text).toContain("John");
    expect(result?.tip?.source).toBe("Generated for you");
  });

  it("tip uses generative-fallback without activity when linkActivity is null", () => {
    const result = dealRoomToMeetingCardProps({
      ...BASE_SNAPSHOT,
      linkActivity: null,
    });
    expect(result?.tip).toBeDefined();
    expect(result?.tip?.text).toContain("John");
    expect(result?.tip?.source).toBe("Generated for you");
  });

  it("tip is null when isAnonymousLink with no authored/derived data", () => {
    // Note: PR1 always passes isAnonymousLink: false to dealRoomToMeetingCardProps,
    // so generative-fallback always fires there. This test documents the null
    // path via direct renderTip call with anonymous=true.
    const result = renderTip(
      buildTipInput({
        hostName: "John Anderson",
        inviteeName: "Sarah Chen",
        linkFormat: "video",
        linkActivity: null,
        linkLocation: null,
        isAnonymousLink: true,
      }),
      "guest",
    );
    expect(result).toBeNull();
  });
});

// ── ViewerRole ────────────────────────────────────────────────────────────────

describe("dealRoomToMeetingCardProps — viewerRole", () => {
  it("viewerRole is 'host' when isHost is true", () => {
    const result = dealRoomToMeetingCardProps({
      ...BASE_SNAPSHOT,
      isHost: true,
    });
    expect(result?.viewerRole).toBe("host");
  });

  it("viewerRole is 'guest' when isHost is false", () => {
    const result = dealRoomToMeetingCardProps({
      ...BASE_SNAPSHOT,
      isHost: false,
    });
    expect(result?.viewerRole).toBe("guest");
  });
});

// ── Title fallback ────────────────────────────────────────────────────────────

describe("dealRoomToMeetingCardProps — title", () => {
  it("falls back to 'Meeting' when linkActivity is null", () => {
    const result = dealRoomToMeetingCardProps({
      ...BASE_SNAPSHOT,
      linkActivity: null,
    });
    expect(result?.title).toBe("Meeting");
  });

  it("composes title from linkActivity + inviteeName first name", () => {
    const result = dealRoomToMeetingCardProps({
      ...BASE_SNAPSHOT,
      linkActivity: "Coffee",
      inviteeName: "Sarah Chen",
    });
    expect(result?.title).toBe("Coffee with Sarah");
  });

  it("uses linkActivity alone when inviteeName is empty", () => {
    const result = dealRoomToMeetingCardProps({
      ...BASE_SNAPSHOT,
      linkActivity: "Office Hours",
      inviteeName: "",
    });
    expect(result?.title).toBe("Office Hours");
  });
});

// ── When block ────────────────────────────────────────────────────────────────

describe("dealRoomToMeetingCardProps — when block", () => {
  it("prefers sessionTimezone over slotTimezone", () => {
    const result = dealRoomToMeetingCardProps({
      ...BASE_SNAPSHOT,
      sessionTimezone: "America/Los_Angeles",
      slotTimezone: "America/New_York",
    });
    expect(result?.when.tz).toBe("America/Los_Angeles");
  });

  it("falls back to slotTimezone when sessionTimezone is null", () => {
    const result = dealRoomToMeetingCardProps({
      ...BASE_SNAPSHOT,
      sessionTimezone: null,
      slotTimezone: "America/Chicago",
    });
    expect(result?.when.tz).toBe("America/Chicago");
  });

  it("sets durationMin from confirmData.duration", () => {
    const result = dealRoomToMeetingCardProps({
      ...BASE_SNAPSHOT,
      confirmData: { ...BASE_SNAPSHOT.confirmData, duration: 60 },
    });
    expect(result?.when.durationMin).toBe(60);
  });

  it("defaults durationMin to 30 when confirmData.duration is not a number", () => {
    const result = dealRoomToMeetingCardProps({
      ...BASE_SNAPSHOT,
      confirmData: { ...BASE_SNAPSHOT.confirmData, duration: undefined },
    });
    expect(result?.when.durationMin).toBe(30);
  });
});

// ── State always confirmed ────────────────────────────────────────────────────

describe("dealRoomToMeetingCardProps — state", () => {
  it("always returns state === 'confirmed'", () => {
    const result = dealRoomToMeetingCardProps(BASE_SNAPSHOT);
    expect(result?.state).toBe("confirmed");
  });
});
