/**
 * getEffectiveMeetingState — three-layer fallback chain verification.
 *
 * Tests the four scenarios from §2.5 of the event-record-alignment proposal:
 *   A — guest locks format (negotiated wins over link)
 *   B — guest locks duration (negotiated wins over link)
 *   C — host edits link format; no guest override (link wins)
 *   D — host edits link after guest locked (negotiated cleared → link wins)
 *
 * Plus title-derivation coverage: customTitle verbatim, buildEventTitle
 * fallback, and the "no data → Meeting" floor.
 *
 * Decision: proposals/2026-05-14_event-record-alignment_reviewed-2026-05-14_decided-2026-05-14.md §2.5
 */

import { describe, it, expect } from "vitest";
import { getEffectiveMeetingState, type SessionWithLink } from "@/lib/effective-meeting-state";

// ── Minimal session builder ────────────────────────────────────────────────

function makeSession(overrides: Partial<SessionWithLink> = {}): SessionWithLink {
  return {
    negotiatedActivity: null,
    negotiatedFormat: null,
    negotiatedDuration: null,
    negotiatedLocation: null,
    format: null,
    duration: null,
    location: null,
    meetLink: null,
    status: "active",
    agreedTime: null,
    link: {
      customTitle: null,
      inviteeName: "Sarah",
      inviteeNames: undefined,
      parameters: null,
      user: { name: "John Anderson" },
    },
    ...overrides,
  };
}

// ── Scenario A — Guest locks format ───────────────────────────────────────

describe("Scenario A — guest locks format (negotiated wins over link param)", () => {
  it("negotiatedFormat overrides link.parameters.format", () => {
    const session = makeSession({
      negotiatedFormat: "video",
      link: {
        customTitle: null,
        inviteeName: "Sarah",
        parameters: { format: "in-person" },
        user: { name: "John" },
      },
    });
    const state = getEffectiveMeetingState(session);
    expect(state.format).toBe("video");
  });

  it("channelRow reflects the negotiated format", () => {
    const session = makeSession({
      negotiatedFormat: "video",
      link: {
        customTitle: null,
        inviteeName: "Sarah",
        parameters: { format: "in-person" },
        user: { name: "John" },
      },
    });
    const state = getEffectiveMeetingState(session);
    expect(state.channelRow.kind).toBe("video");
  });
});

// ── Scenario B — Guest locks duration ─────────────────────────────────────

describe("Scenario B — guest locks duration (negotiated wins over session-column and link)", () => {
  it("negotiatedDuration wins over session.duration", () => {
    const session = makeSession({
      negotiatedDuration: 30,
      duration: 60,
      link: {
        customTitle: null,
        inviteeName: "Sarah",
        parameters: { duration: 45 },
        user: { name: "John" },
      },
    });
    const state = getEffectiveMeetingState(session);
    expect(state.duration).toBe(30);
  });

  it("session.duration wins over link.parameters.duration when no negotiated", () => {
    const session = makeSession({
      negotiatedDuration: null,
      duration: 60,
      link: {
        customTitle: null,
        inviteeName: "Sarah",
        parameters: { duration: 45 },
        user: { name: "John" },
      },
    });
    const state = getEffectiveMeetingState(session);
    expect(state.duration).toBe(60);
  });
});

// ── Scenario C — Host edits link format; no guest override ────────────────

describe("Scenario C — host edits link format; no guest override (link.params wins)", () => {
  it("link.parameters.format is used when no negotiated or session column", () => {
    const session = makeSession({
      negotiatedFormat: null,
      format: null,
      link: {
        customTitle: null,
        inviteeName: "Sarah",
        parameters: { format: "phone" },
        user: { name: "John" },
      },
    });
    const state = getEffectiveMeetingState(session);
    expect(state.format).toBe("phone");
  });

  it("channelRow.kind reflects the link format", () => {
    const session = makeSession({
      negotiatedFormat: null,
      format: null,
      link: {
        customTitle: null,
        inviteeName: "Sarah",
        parameters: { format: "phone" },
        user: { name: "John" },
      },
    });
    const state = getEffectiveMeetingState(session);
    expect(state.channelRow.kind).toBe("phone");
  });

  it("title uses buildEventTitle formula when no customTitle", () => {
    const session = makeSession({
      negotiatedFormat: null,
      format: null,
      link: {
        customTitle: null,
        inviteeName: "Sarah",
        parameters: { format: "phone", activity: "call" },
        user: { name: "John Anderson" },
      },
    });
    const state = getEffectiveMeetingState(session);
    // "call" + "phone" → "Call: Sarah + John"
    expect(state.title).toBe("Call: Sarah + John");
  });
});

// ── Scenario D — Host edits link after guest locked ───────────────────────
// (R2/option-a — handleUpdateLink clears negotiated columns, then the
//  helper reads the new link value. The clear is done by the handler,
//  not this helper — this test verifies what the helper sees post-clear.)

describe("Scenario D — after host edit clears guest override (link wins)", () => {
  it("null negotiatedFormat falls through to the new link.parameters.format", () => {
    // Simulates state AFTER handleUpdateLink cleared negotiatedFormat=null
    // and wrote the new format to link.parameters.
    const session = makeSession({
      negotiatedFormat: null, // cleared by handler (R2/option-a)
      format: null,
      link: {
        customTitle: null,
        inviteeName: "Sarah",
        parameters: { format: "phone" }, // host's new format
        user: { name: "John" },
      },
    });
    const state = getEffectiveMeetingState(session);
    expect(state.format).toBe("phone");
  });
});

// ── Title derivation ───────────────────────────────────────────────────────

describe("title derivation — customTitle and buildEventTitle fallback", () => {
  it("customTitle wins verbatim over formula", () => {
    const session = makeSession({
      link: {
        customTitle: "Q3 board review",
        inviteeName: "Sarah",
        parameters: { activity: "coffee" },
        user: { name: "John" },
      },
    });
    const state = getEffectiveMeetingState(session);
    expect(state.title).toBe("Q3 board review");
  });

  it("buildEventTitle formula used when customTitle is null", () => {
    const session = makeSession({
      link: {
        customTitle: null,
        inviteeName: "Sarah",
        parameters: { activity: "coffee" },
        user: { name: "John Anderson" },
      },
    });
    const state = getEffectiveMeetingState(session);
    expect(state.title).toBe("Coffee: Sarah + John");
  });

  it("no data → falls back to 'Meeting'", () => {
    const session = makeSession({
      link: {
        customTitle: null,
        inviteeName: null,
        parameters: null,
        user: null,
      },
    });
    const state = getEffectiveMeetingState(session);
    expect(state.title).toBe("Meeting");
  });

  it("default duration is 30 when nothing is set", () => {
    const state = getEffectiveMeetingState(makeSession());
    expect(state.duration).toBe(30);
  });

  it("default format is 'video' when nothing is set", () => {
    const state = getEffectiveMeetingState(makeSession());
    expect(state.format).toBe("video");
    expect(state.channelRow.kind).toBe("video");
  });
});
