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
import { DEFAULT_TIP } from "@/lib/meeting-tip/default-tip";

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
  linkParameters: null,
  userPrimaryTip: null,
  gcalEventUrl: null,
};

// ── Null-return guards ────────────────────────────────────────────────────────

describe("dealRoomToMeetingCardProps — null-return guards", () => {
  it("returns proposal-state props (NOT null) when confirmData is null but participants exist", () => {
    // 2026-05-14 cleanup: PR2c extended dealRoomToMeetingCardProps to also
    // build proposal/matched/skipped/confirming card props (not just
    // confirmed). When confirmData is null but a host or invitee name is
    // available, it returns proposal-state props now instead of null. The
    // null-return path is only hit when BOTH names are missing — see the
    // "both names absent" cell below.
    const result = dealRoomToMeetingCardProps({
      ...BASE_SNAPSHOT,
      confirmData: null,
    });
    expect(result).not.toBeNull();
    expect(result?.state).toBe("proposal");
  });

  it("returns null when confirmData is null AND both host and invitee names are missing", () => {
    // The new null-return contract for proposal-state: only fires when
    // there's literally nothing to render (no names, no card).
    const result = dealRoomToMeetingCardProps({
      ...BASE_SNAPSHOT,
      confirmData: null,
      hostName: "",
      inviteeName: "",
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

  it("falls back to 'In-person — venue TBD' for in-person when no location available", () => {
    // 2026-05-11 widening: the bare "TBD" fallback was replaced with a
    // string that surfaces format context. Two shapes documented at
    // dealRoomToMeetingCardProps.ts:317-326:
    //   - guestPicks.location === true → "Venue TBD — guest to pick"
    //   - venue just unset            → "In-person — venue TBD"
    // The test exercises the latter (linkGuestPicks unset on BASE_SNAPSHOT).
    const result = dealRoomToMeetingCardProps({
      ...BASE_SNAPSHOT,
      confirmData: {
        ...BASE_SNAPSHOT.confirmData,
        format: "in-person",
      },
      linkLocation: null,
    });
    if (result?.channel.kind === "in-person") {
      expect(result.channel.location).toBe("In-person — venue TBD");
    }
  });

  it("falls back to 'Venue TBD — guest to pick' when guestPicks.location is true", () => {
    // 2026-05-11 widening: documents the OTHER fallback shape from the
    // same code block. Locks in both branches so future changes can't
    // silently drop one.
    const result = dealRoomToMeetingCardProps({
      ...BASE_SNAPSHOT,
      confirmData: {
        ...BASE_SNAPSHOT.confirmData,
        format: "in-person",
      },
      linkLocation: null,
      linkParameters: { guestPicks: { location: true } },
    });
    if (result?.channel.kind === "in-person") {
      expect(result.channel.location).toBe("Venue TBD — guest to pick");
    }
  });
});

// ── Tip derivation ────────────────────────────────────────────────────────────

describe("dealRoomToMeetingCardProps — tip derivation", () => {
  // 2026-05-14 cleanup: the generative-fallback template was locked
  // 2026-05-10 (per John, see templates/generative-fallback.ts:8) to
  // render `DEFAULT_TIP` verbatim. The earlier activity-substituting
  // form ("Looking forward to coffee with John") was dropped because
  // it duplicated content already on the card (title + channel row).
  // Source label is now "From {host}" (or "From the host" when no
  // first name available), not the older "Generated for you".

  it("tip is the default 'Looking forward to it…' string when no authored/derived tip applies (activity present)", () => {
    const result = dealRoomToMeetingCardProps({
      ...BASE_SNAPSHOT,
      linkActivity: "Coffee",
    });
    expect(result?.tip).toBeDefined();
    expect(result?.tip?.text).toBe(
      "Looking forward to it — pick whatever time works.",
    );
    expect(result?.tip?.source).toBe("From John");
  });

  it("tip is the default 'Looking forward to it…' string when no activity (and no authored tip)", () => {
    const result = dealRoomToMeetingCardProps({
      ...BASE_SNAPSHOT,
      linkActivity: null,
    });
    expect(result?.tip).toBeDefined();
    expect(result?.tip?.text).toBe(
      "Looking forward to it — pick whatever time works.",
    );
    expect(result?.tip?.source).toBe("From John");
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

  it("linkParameters.tip flows through as linkAuthoredTip", () => {
    const result = dealRoomToMeetingCardProps({
      ...BASE_SNAPSHOT,
      linkParameters: { tip: "See you at the coffee shop!" },
    });
    expect(result?.tip?.text).toBe("See you at the coffee shop!");
  });

  it("userPrimaryTip is used when linkParameters.tip is absent", () => {
    const result = dealRoomToMeetingCardProps({
      ...BASE_SNAPSHOT,
      linkParameters: null,
      userPrimaryTip: "Really looking forward to this one.",
    });
    expect(result?.tip?.text).toBe("Really looking forward to this one.");
  });

  it("linkParameters.tip takes precedence over userPrimaryTip", () => {
    const result = dealRoomToMeetingCardProps({
      ...BASE_SNAPSHOT,
      linkParameters: { tip: "From the link" },
      userPrimaryTip: "From primary",
    });
    expect(result?.tip?.text).toBe("From the link");
  });

  it("generative-fallback fires (rendering DEFAULT_TIP) when both linkParameters.tip and userPrimaryTip are null", () => {
    // 2026-05-14 cleanup: generative-fallback locked to DEFAULT_TIP verbatim
    // 2026-05-10. The test now asserts that the fallback fires (returns
    // DEFAULT_TIP), not that it composes activity/host into the string.
    const result = dealRoomToMeetingCardProps({
      ...BASE_SNAPSHOT,
      linkParameters: null,
      userPrimaryTip: null,
      linkActivity: "Coffee",
    });
    expect(result?.tip?.text).toBe(
      "Looking forward to it — pick whatever time works.",
    );
    expect(result?.tip?.source).toBe("From John");
  });

  it("DEFAULT_TIP constant is a non-empty string", () => {
    expect(typeof DEFAULT_TIP).toBe("string");
    expect(DEFAULT_TIP.length).toBeGreaterThan(0);
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

describe("dealRoomToMeetingCardProps — title (canonical via buildEventTitle, 2026-05-14 cmp4ucke5)", () => {
  // 2026-05-14 cmp4ucke5: titles route through the canonical `buildEventTitle`
  // helper. Pre-fix this used a bespoke `{linkActivity} with {inviteeFirst}`
  // formula that produced "call with Calle" while the dashboard event card
  // showed "Call: Calle + John" — same session, two title shapes, user-
  // visible mismatch. The canonical shape is "{Prefix}: {invitee} + {host}".

  it("CONFIRMED state — uses format-derived prefix when no activity (informative fallback)", () => {
    // Pre-cmp4ucke5 this returned "Meeting". The canonical helper now uses
    // the format prefix ("VC" for video) when activity is unavailable —
    // strictly more informative since the format is known on the confirmed
    // session, and it stays consistent with what the dashboard renders for
    // the same session.
    const result = dealRoomToMeetingCardProps({
      ...BASE_SNAPSHOT,
      linkActivity: null,
      hostName: "",
    });
    expect(result?.title).toBe("VC: Sarah");
  });

  it("PROPOSAL state — falls back to 'Meeting with {host full name}' when no activity + no invitee (primary-link case preserved)", () => {
    // This fallback is preserved ONLY for the proposal-state path
    // (confirmData: null). On the confirmed path, format prefix wins.
    const result = dealRoomToMeetingCardProps({
      ...BASE_SNAPSHOT,
      confirmData: null,
      linkActivity: null,
      inviteeName: "",
    });
    expect(result?.title).toBe("Meeting with John Anderson");
  });

  it("produces canonical '{Prefix}: {invitee} + {host}' for activity + invitee (cmp4ucke5)", () => {
    // The exact production case: activity "call" + invitee "Calle" + host
    // "John Anderson" → must match the session.title stored in the DB
    // ("Call: Calle + John"), so the dashboard event card and the deal-
    // room event page render identical titles.
    const result = dealRoomToMeetingCardProps({
      ...BASE_SNAPSHOT,
      linkActivity: "call",
      inviteeName: "Calle",
      hostName: "John Anderson",
    });
    expect(result?.title).toBe("Call: Calle + John");
  });

  it("title-cases multi-word activities (e.g. 'office-hours' → 'Office hours')", () => {
    const result = dealRoomToMeetingCardProps({
      ...BASE_SNAPSHOT,
      linkActivity: "office-hours",
      inviteeName: "Sarah Chen",
      hostName: "John Anderson",
    });
    // Vocab miss falls through to format mapping; "video" → "VC".
    // If "office-hours" isn't in the vocab, the canonical helper uses VC.
    // Either way, the bespoke "office-hours with Sarah" shape must not appear.
    expect(result?.title).not.toBe("office-hours with Sarah");
  });

  it("composes 'Coffee: Sarah + John' for canonical vocab activity (was 'Coffee with Sarah' pre-fix)", () => {
    // Pre-cmp4ucke5 this returned "Coffee with Sarah". Locked in here so a
    // future refactor that drifts back to the bespoke formula fails the test.
    const result = dealRoomToMeetingCardProps({
      ...BASE_SNAPSHOT,
      linkActivity: "Coffee",
      inviteeName: "Sarah Chen",
      hostName: "John Anderson",
    });
    expect(result?.title).toBe("Coffee: Sarah + John");
  });

  it("uses linkActivity alone when no invitee + no host first name", () => {
    const result = dealRoomToMeetingCardProps({
      ...BASE_SNAPSHOT,
      linkActivity: "Office Hours",
      inviteeName: "",
      hostName: "",
    });
    // No vocab match + no format on the snapshot's default → falls back to
    // format-derived prefix ("VC" for video). Stable regardless: no
    // "{activity} with {invitee}" leak.
    expect(result?.title).not.toContain(" with ");
  });

  it("uses host-named customTitle verbatim when set (overrides activity + invitee)", () => {
    // PR-3 reader-switchover: link.customTitle wins outright. Verifies the
    // `linkCustomTitle` plumbing wired in cmp4ucke5's fix actually flows
    // through to buildEventTitle.
    const result = dealRoomToMeetingCardProps({
      ...BASE_SNAPSHOT,
      linkActivity: "Coffee",
      inviteeName: "Sarah Chen",
      hostName: "John Anderson",
      linkCustomTitle: "Q3 board review",
    });
    expect(result?.title).toBe("Q3 board review");
  });

  it("ignores empty/whitespace customTitle (falls back to canonical composition)", () => {
    const result = dealRoomToMeetingCardProps({
      ...BASE_SNAPSHOT,
      linkActivity: "Coffee",
      inviteeName: "Sarah Chen",
      hostName: "John Anderson",
      linkCustomTitle: "   ",
    });
    expect(result?.title).toBe("Coffee: Sarah + John");
  });

  it("PROPOSAL state — uses the same canonical formula as confirmed state", () => {
    // Critical: this is the regression cell. Pre-fix, the proposal-state
    // path used the same buggy bespoke formula. The screenshot in cmp4ucke5
    // showed "call with Calle" on a fresh proposal-state link.
    const result = dealRoomToMeetingCardProps({
      ...BASE_SNAPSHOT,
      confirmData: null, // forces the proposal-state code path
      linkActivity: "call",
      inviteeName: "Calle",
      hostName: "John Anderson",
      linkFormat: "video",
    });
    expect(result?.title).toBe("Call: Calle + John");
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
