/**
 * Unit tests for the greeting registry — `src/agent/greetings/registry.ts`.
 *
 * Two layers of coverage:
 *
 *   1. **Resolver coverage (`selectGreeting`)** — for each of the four
 *      branches, assert that `selectGreeting(input).key` matches the
 *      expected registry key. Locks the priority order so future changes
 *      to `match()` predicates don't silently route a fixture to the wrong
 *      template.
 *
 *   2. **Voice-equivalence (`render()`)** — for each branch, render against
 *      a known-good fixture and assert the exact string. This is the
 *      voice-drift safety net for the 2026-04-25 registry-extraction PR:
 *      every output below was captured directly from the inline templates
 *      in `route.ts:782-1083` at HEAD `4d3ce99` (the commit before this
 *      extraction). Any divergence from these strings means the registry
 *      drifted from the prior production output — which is by definition
 *      a regression in this PR.
 */
import { describe, it, expect } from "vitest";

import {
  selectGreeting,
  GREETINGS,
  formatDeferralFieldsList,
  type GreetingInput,
} from "@/agent/greetings/registry";

// ─── Fixture helpers ─────────────────────────────────────────────────────────

/**
 * Minimal-default GreetingInput. Override only the fields the test cares
 * about so each test reads as a concise diff from the baseline.
 */
function baseInput(overrides: Partial<GreetingInput> = {}): GreetingInput {
  return {
    hostFirstName: "John",
    hostTimezone: "America/Los_Angeles",
    greeteeName: "Sarah",
    inviteeCount: 1,
    linkRules: {},
    isAnonymousLink: false,
    isOfficeHoursLink: false,
    effectiveSteering: "open",
    activityText: null,
    linkLocationForOpener: null,
    durationForOpener: null,
    effectiveDuration: undefined,
    effectiveFormat: undefined,
    rawTopic: null,
    meetingDescShort: "meeting",
    timingLabel: null,
    guestPickHint: null,
    suggestAltClause: null,
    deferralFieldsList: null,
    calendarPitch: null,
    toneLine: null,
    ...overrides,
  };
}

// ─── Layer 1: resolver — `selectGreeting` ────────────────────────────────────

describe("selectGreeting — registry key resolution", () => {
  it("routes single-slot exclusive locks to single-slot-lock", () => {
    const input = baseInput({
      effectiveSteering: "exclusive",
      linkRules: {
        availability: { restrictToSlots: [{ start: "2026-05-01T16:00:00Z", end: "2026-05-01T16:00:00Z" }] },
      },
    });
    expect(selectGreeting(input).key).toBe("single-slot-lock");
  });

  it("routes anonymous links to anonymous (primary)", () => {
    const input = baseInput({ isAnonymousLink: true });
    expect(selectGreeting(input).key).toBe("anonymous");
  });

  it("routes anonymous links to anonymous (office-hours child)", () => {
    const input = baseInput({
      isAnonymousLink: true,
      isOfficeHoursLink: true,
      rawTopic: "Coaching hours",
    });
    expect(selectGreeting(input).key).toBe("anonymous");
  });

  it("routes named links with structural fields to proposal", () => {
    const input = baseInput({
      effectiveFormat: "video",
      durationForOpener: 30,
    });
    expect(selectGreeting(input).key).toBe("proposal");
  });

  it("routes named links without structural fields to find-time", () => {
    const input = baseInput();
    expect(selectGreeting(input).key).toBe("find-time");
  });

  it("anonymous wins over exclusive when isAnonymousLink is true", () => {
    // Exclusive + anonymous shouldn't happen in practice (Office Hours don't
    // carry slotOverrides), but if it ever did, `single-slot-lock`'s match
    // predicate explicitly excludes anonymous links — confirm here.
    const input = baseInput({
      isAnonymousLink: true,
      effectiveSteering: "exclusive",
      linkRules: {
        availability: { restrictToSlots: [{ start: "2026-05-01T16:00:00Z", end: "2026-05-01T16:00:00Z" }] },
      },
    });
    expect(selectGreeting(input).key).toBe("anonymous");
  });

  it("exclusive without single-slot-override falls through to proposal/find-time", () => {
    // Steering is `exclusive` but no -2 override — the §4.8 invariant says
    // this should never happen (caller logs an error), but the registry
    // must still produce a sensible greeting. With `effectiveFormat` set
    // below, it routes to proposal.
    const input = baseInput({
      effectiveSteering: "exclusive",
      effectiveFormat: "video",
      linkRules: {},
    });
    expect(selectGreeting(input).key).toBe("proposal");
  });
});

// ─── Layer 2: voice-equivalence — `render()` ────────────────────────────────

describe("greeting registry — voice-equivalence (byte-identical to prior inline templates)", () => {
  // ─── Branch A: single-slot-lock ──────────────────────────────────────────

  it("Branch A: single-slot-lock renders the offer-card handoff verbatim", () => {
    const input = baseInput({
      greeteeName: "Sarah",
      effectiveSteering: "exclusive",
      activityText: "coffee",
      linkLocationForOpener: "Sightglass",
      durationForOpener: 30,
      effectiveDuration: 30,
      hostTimezone: "America/Los_Angeles",
      linkRules: {
        availability: { restrictToSlots: [{ start: "2026-05-01T16:00:00Z", end: "2026-05-01T16:00:00Z" }] },
      },
    });
    const out = GREETINGS["single-slot-lock"].render(input);
    expect(out).toBe(
      "👋 Sarah! Envoy lined up a time — 30 min for coffee at Sightglass on Fri, May 1 at 9:00 AM PDT. Confirm below, or let me know if anything needs to shift.",
    );
  });

  it("Branch A: drops parts that aren't set (no activity / no location / no slot)", () => {
    const input = baseInput({
      greeteeName: "Sarah",
      effectiveSteering: "exclusive",
      effectiveDuration: 60,
      durationForOpener: 60,
      linkRules: { availability: { restrictToSlots: [] } }, // no -2 override → no whenPart
    });
    const out = GREETINGS["single-slot-lock"].render(input);
    expect(out).toBe(
      "👋 Sarah! Envoy lined up a time — 1h. Confirm below, or let me know if anything needs to shift.",
    );
  });

  it("Branch A: 'some time' fallback when duration unset", () => {
    const input = baseInput({
      greeteeName: "Sarah",
      effectiveSteering: "exclusive",
      activityText: "lunch",
      linkRules: { availability: { restrictToSlots: [] } },
    });
    const out = GREETINGS["single-slot-lock"].render(input);
    expect(out).toBe(
      "👋 Sarah! Envoy lined up a time — some time for lunch. Confirm below, or let me know if anything needs to shift.",
    );
  });

  // ─── Branch C: anonymous ─────────────────────────────────────────────────

  it("Branch C: anonymous primary link uses 'default is' body", () => {
    const input = baseInput({
      isAnonymousLink: true,
      meetingDescShort: "30-min video call",
    });
    const out = GREETINGS.anonymous.render(input);
    expect(out).toBe(
      "👋 I'm John's scheduling agent.\nJohn's default is 30-min video call sometime within the available windows below.",
    );
  });

  it("Branch C: office-hours child surfaces topic with possessive plural body", () => {
    const input = baseInput({
      isAnonymousLink: true,
      isOfficeHoursLink: true,
      rawTopic: "Coaching hours",
      meetingDescShort: "20-min video call",
    });
    const out = GREETINGS.anonymous.render(input);
    expect(out).toBe(
      "👋 I'm John's scheduling agent.\nThese are John's Coaching hours — 20-min video calls within the available windows below.",
    );
  });

  it("Branch C: appends calendar pitch with single space when present", () => {
    const input = baseInput({
      isAnonymousLink: true,
      meetingDescShort: "meeting",
      calendarPitch:
        "Also, if you connect your calendar I can automagically find the best fit for you! 🗓️",
    });
    const out = GREETINGS.anonymous.render(input);
    expect(out).toBe(
      "👋 I'm John's scheduling agent.\nJohn's default is meeting sometime within the available windows below. Also, if you connect your calendar I can automagically find the best fit for you! 🗓️",
    );
  });

  // ─── Branch B-proposal ───────────────────────────────────────────────────

  it("Branch B-proposal: format + duration + 'Pick a time' closing", () => {
    const input = baseInput({
      greeteeName: "Sarah",
      effectiveFormat: "video",
      durationForOpener: 30,
    });
    const out = GREETINGS.proposal.render(input);
    expect(out).toBe(
      [
        "👋 Sarah! I'm scheduling time with you and John. John is proposing a 30 min video call.",
        "Pick a time below.",
      ].join("\n\n"),
    );
  });

  it("Branch B-proposal: activity-leading proposal, with location and timing", () => {
    const input = baseInput({
      greeteeName: "Sarah",
      activityText: "hike",
      durationForOpener: 90,
      linkLocationForOpener: "Marin Headlands",
      timingLabel: "next week",
    });
    const out = GREETINGS.proposal.render(input);
    expect(out).toBe(
      [
        "👋 Sarah! I'm scheduling time with you and John. John is proposing 1h 30m for hike in Marin Headlands next week.",
        "Pick a time below.",
      ].join("\n\n"),
    );
  });

  it("Branch B-proposal: multi-invitee uses 'with the three of you'", () => {
    const input = baseInput({
      greeteeName: "Will & Andrew",
      inviteeCount: 2,
      effectiveFormat: "video",
      durationForOpener: 30,
    });
    const out = GREETINGS.proposal.render(input);
    expect(out).toBe(
      [
        "👋 Will & Andrew! I'm scheduling time with the three of you. John is proposing a 30 min video call.",
        "Pick a time below.",
      ].join("\n\n"),
    );
  });

  it("Branch B-proposal: assembles tone line + guest-pick hint + suggest-alt + calendar pitch", () => {
    const input = baseInput({
      greeteeName: "Sarah",
      effectiveFormat: "video",
      durationForOpener: 30,
      toneLine: "Looking forward to it!",
      guestPickHint:
        "Let me know where works for you — John suggested Sightglass.",
      suggestAltClause:
        "and feel free to suggest a different format or meeting length if that's better for you",
      calendarPitch:
        "Also, if you connect your calendar I can automagically find the best fit for you! 🗓️",
    });
    const out = GREETINGS.proposal.render(input);
    expect(out).toBe(
      [
        "👋 Sarah! I'm scheduling time with you and John. John is proposing a 30 min video call.",
        "Looking forward to it!",
        "Let me know where works for you — John suggested Sightglass.",
        "Pick a time below, and feel free to suggest a different format or meeting length if that's better for you. Also, if you connect your calendar I can automagically find the best fit for you! 🗓️",
      ].join("\n\n"),
    );
  });

  // ─── Deferral-fields list (2026-04-29 unified opener/closing) ────────────

  it("Branch B-proposal: with deferralFieldsList, opener appends 'but wanted to check' and closing appends 'let us know any suggestions'", () => {
    const input = baseInput({
      greeteeName: "Larry",
      effectiveFormat: "in-person",
      durationForOpener: 60,
      deferralFieldsList: "the location",
      // guestPickHint and suggestAltClause are now suppressed when
      // deferralFieldsList is set — they would render redundant info.
      guestPickHint: "Let me know where works for you.",
      suggestAltClause: null,
    });
    const out = GREETINGS.proposal.render(input);
    expect(out).toBe(
      [
        "👋 Larry! I'm scheduling time with you and John. John is proposing a 1h in-person meeting but wanted to check if you had preferences in terms of the location.",
        "Pick a time below and let us know any suggestions on the location.",
      ].join("\n\n"),
    );
  });

  it("Branch B-proposal: with two deferred fields, list joins with 'and' (canonical order)", () => {
    const input = baseInput({
      greeteeName: "Larry",
      effectiveFormat: "in-person",
      durationForOpener: 60,
      deferralFieldsList: "the location and length",
    });
    const out = GREETINGS.proposal.render(input);
    expect(out).toContain("preferences in terms of the location and length");
    expect(out).toContain("any suggestions on the location and length");
  });

  it("Branch B-proposal: tone line is suppressed when deferralFieldsList is set", () => {
    // Composers tend to populate guestGuidance.tone with deferral-mirroring
    // text ("Larry picks the spot and how long — just let him know what
    // works.") when the host's create_link expressed deferral. That
    // duplicates the opener+closing copy. Tone is suppressed in deferral
    // cases — live-fix from /meet/johnanderson/gmgf3k testing 2026-04-29.
    const input = baseInput({
      greeteeName: "Larry",
      effectiveFormat: "in-person",
      durationForOpener: 60,
      deferralFieldsList: "the location",
      toneLine: "Larry picks the spot and how long — just let him know what works.",
    });
    const out = GREETINGS.proposal.render(input);
    expect(out).not.toContain("Larry picks the spot");
    expect(out).not.toContain("just let him know");
  });

  it("Branch B-proposal: tone line still renders when no deferralFieldsList (legitimate flavor)", () => {
    const input = baseInput({
      greeteeName: "Sarah",
      effectiveFormat: "video",
      durationForOpener: 30,
      deferralFieldsList: null,
      toneLine: "It's been a while — looking forward to catching up!",
    });
    const out = GREETINGS.proposal.render(input);
    expect(out).toContain("It's been a while — looking forward to catching up!");
  });

  it("Branch B-find-time: with deferralFieldsList, only the closing carries the 'let us know' suggestion (opener already invites)", () => {
    const input = baseInput({
      greeteeName: "Sarah",
      // No structural fields → find-time branch fires.
      deferralFieldsList: "the location",
    });
    const out = GREETINGS["find-time"].render(input);
    expect(out).toContain("👋 Sarah! John asked me to find time");
    expect(out).toContain("Pick a time below and let us know any suggestions on the location.");
    // Opener should NOT carry the "but wanted to check" clause — find-time
    // is itself an open invitation.
    expect(out).not.toContain("but wanted to check");
  });

  it("Branch B-proposal: bare format defaults to article + format", () => {
    const input = baseInput({
      greeteeName: "Sarah",
      effectiveFormat: "in-person",
    });
    const out = GREETINGS.proposal.render(input);
    expect(out).toBe(
      [
        "👋 Sarah! I'm scheduling time with you and John. John is proposing an in-person meeting.",
        "Pick a time below.",
      ].join("\n\n"),
    );
  });

  // ─── Branch B-find-time ──────────────────────────────────────────────────

  it("Branch B-find-time: bare 'asked me to find time' single-invitee", () => {
    const input = baseInput({ greeteeName: "Sarah" });
    const out = GREETINGS["find-time"].render(input);
    expect(out).toBe(
      [
        "👋 Sarah! John asked me to find time.",
        "Pick a time below.",
      ].join("\n\n"),
    );
  });

  it("Branch B-find-time: appends timing label when set", () => {
    const input = baseInput({
      greeteeName: "Sarah",
      timingLabel: "next week",
    });
    const out = GREETINGS["find-time"].render(input);
    expect(out).toBe(
      [
        "👋 Sarah! John asked me to find time next week.",
        "Pick a time below.",
      ].join("\n\n"),
    );
  });

  it("Branch B-find-time: multi-invitee uses 'for the three of you'", () => {
    const input = baseInput({
      greeteeName: "Will & Andrew",
      inviteeCount: 2,
    });
    const out = GREETINGS["find-time"].render(input);
    expect(out).toBe(
      [
        "👋 Will & Andrew! John asked me to find time for the three of you.",
        "Pick a time below.",
      ].join("\n\n"),
    );
  });

  it("Branch B-find-time: 4-person group uses 'for the four of you'", () => {
    const input = baseInput({
      greeteeName: "Will, Andrew & Sam",
      inviteeCount: 3,
    });
    const out = GREETINGS["find-time"].render(input);
    expect(out).toBe(
      [
        "👋 Will, Andrew & Sam! John asked me to find time for the four of you.",
        "Pick a time below.",
      ].join("\n\n"),
    );
  });

  it("Branch B-find-time: 5+ group uses 'for your group'", () => {
    const input = baseInput({
      greeteeName: "the team",
      inviteeCount: 4,
    });
    const out = GREETINGS["find-time"].render(input);
    expect(out).toBe(
      [
        "👋 the team! John asked me to find time for your group.",
        "Pick a time below.",
      ].join("\n\n"),
    );
  });

  it("Branch B-find-time: tone + guest-pick hint + calendar pitch all flow through", () => {
    const input = baseInput({
      greeteeName: "Sarah",
      toneLine: "Excited to chat!",
      guestPickHint: "Let me know how long works for you.",
      calendarPitch:
        "Also, if you connect your calendar I can automagically find the best fit for you! 🗓️",
    });
    const out = GREETINGS["find-time"].render(input);
    expect(out).toBe(
      [
        "👋 Sarah! John asked me to find time.",
        "Excited to chat!",
        "Let me know how long works for you.",
        "Pick a time below. Also, if you connect your calendar I can automagically find the best fit for you! 🗓️",
      ].join("\n\n"),
    );
  });
});

// ─── formatDeferralFieldsList helper (2026-04-29) ────────────────────────────

describe("formatDeferralFieldsList — canonical-order grammar", () => {
  it("returns null for empty input", () => {
    expect(formatDeferralFieldsList([])).toBeNull();
  });

  it("formats one field with 'the' prefix", () => {
    expect(formatDeferralFieldsList(["location"])).toBe("the location");
    expect(formatDeferralFieldsList(["length"])).toBe("the length");
  });

  it("formats two fields with 'and' (canonical order: location → length → day → format)", () => {
    expect(formatDeferralFieldsList(["location", "length"])).toBe(
      "the location and length",
    );
    // Input order doesn't matter — canonical order applied.
    expect(formatDeferralFieldsList(["length", "location"])).toBe(
      "the location and length",
    );
  });

  it("formats three fields with Oxford comma + 'and'", () => {
    expect(formatDeferralFieldsList(["location", "length", "day"])).toBe(
      "the location, length, and day",
    );
    // Canonical order applied regardless of input order.
    expect(formatDeferralFieldsList(["format", "location", "length"])).toBe(
      "the location, length, and format",
    );
  });

  it("normalizes to canonical order regardless of input order", () => {
    const a = formatDeferralFieldsList(["format", "day", "length", "location"]);
    const b = formatDeferralFieldsList(["location", "length", "day", "format"]);
    expect(a).toBe(b);
    expect(a).toBe("the location, length, day, and format");
  });
});
