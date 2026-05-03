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
    guestPicks: null,
    guestGuidance: null,
    bookableSlotCount: 0,
    isGuest: false,
    isDirective: false,
    toneLine: null,
    recurrence: null,
    occurrenceIndex: null,
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
      // Calendar pitch fires when bookableSlotCount > 1 AND viewer is anonymous.
      bookableSlotCount: 2,
      isGuest: false,
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

  // ─── Deferral-fields list (2026-04-29 unified opener/closing) ────────────
  //
  // The legacy "tone + guest-pick hint + suggest-alt + calendar pitch all flow
  // through" test was deleted 2026-05-03. That state was unreachable in
  // production after the 2026-04-29 unified-opener fold: any non-empty
  // guestPicks triggers `deferralFieldsList`, which suppresses guestPickHint,
  // suggestAltClause, and toneLine. The deferral-fields tests below cover the
  // reachable production paths.

  it("Branch B-proposal: with guestPicks.location, opener appends 'but wanted to check' and closing appends 'let us know any suggestions'", () => {
    const input = baseInput({
      greeteeName: "Larry",
      effectiveFormat: "in-person",
      durationForOpener: 60,
      guestPicks: { location: true },
    });
    const out = GREETINGS.proposal.render(input);
    expect(out).toBe(
      [
        "👋 Larry! I'm scheduling time with you and John. John is proposing a 1h in-person meeting but wanted to check if you had preferences in terms of the location.",
        "Pick a time below and let us know any suggestions on the location.",
      ].join("\n\n"),
    );
  });

  it("Branch B-proposal: two deferred fields render as 'the location and length'", () => {
    const input = baseInput({
      greeteeName: "Larry",
      effectiveFormat: "in-person",
      durationForOpener: 60,
      guestPicks: { location: true, duration: true },
    });
    const out = GREETINGS.proposal.render(input);
    expect(out).toContain("preferences in terms of the location and length");
    expect(out).toContain("any suggestions on the location and length");
  });

  it("Branch B-proposal: tone line is suppressed when deferral kicks in", () => {
    // Composers tend to populate guestGuidance.tone with deferral-mirroring
    // text when the host's create_link expressed deferral. That duplicates
    // the opener+closing copy — suppressed since 2026-04-29.
    const input = baseInput({
      greeteeName: "Larry",
      effectiveFormat: "in-person",
      durationForOpener: 60,
      guestPicks: { location: true },
      toneLine: "Larry picks the spot and how long — just let him know what works.",
    });
    const out = GREETINGS.proposal.render(input);
    expect(out).not.toContain("Larry picks the spot");
    expect(out).not.toContain("just let him know");
  });

  it("Branch B-proposal: tone line still renders when guestPicks is null (legitimate flavor)", () => {
    const input = baseInput({
      greeteeName: "Sarah",
      effectiveFormat: "video",
      durationForOpener: 30,
      guestPicks: null,
      toneLine: "It's been a while — looking forward to catching up!",
    });
    const out = GREETINGS.proposal.render(input);
    expect(out).toContain("It's been a while — looking forward to catching up!");
  });

  it("Branch B-find-time: with guestPicks.location, closing carries the 'let us know' suggestion (opener already invites)", () => {
    const input = baseInput({
      greeteeName: "Sarah",
      // No structural fields → find-time branch fires.
      guestPicks: { location: true },
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

  it("Branch B-find-time: tone + calendar pitch flow through when no deferral fields are set", () => {
    const input = baseInput({
      greeteeName: "Sarah",
      // guestPicks: null → no deferralFieldsList → tone renders.
      toneLine: "Excited to chat!",
      bookableSlotCount: 2,
      isGuest: false,
    });
    const out = GREETINGS["find-time"].render(input);
    expect(out).toBe(
      [
        "👋 Sarah! John asked me to find time.",
        "Excited to chat!",
        "Pick a time below. Also, if you connect your calendar I can automagically find the best fit for you! 🗓️",
      ].join("\n\n"),
    );
  });
});

// ─── Recurring templates (2026-05-01 recurring-meeting proposal) ─────────────

const weeklyCountRec = {
  v: "1" as const,
  pattern: "weekly" as const,
  timezone: "America/Los_Angeles",
  anchor: { firstDateLocal: "2026-06-02", timeLocal: "15:00", durationMin: 30 },
  endBy: { count: 10 },
};

const biweeklyUntilRec = {
  v: "1" as const,
  pattern: "biweekly" as const,
  timezone: "America/Los_Angeles",
  anchor: { firstDateLocal: "2026-06-02", timeLocal: "15:00", durationMin: 45 },
  endBy: { until: "2026-08-30T00:00:00Z" },
};

describe("selectGreeting — recurring templates take priority over anonymous", () => {
  it("routes recurring-with-null-occurrenceIndex to recurring-meeting-anchor", () => {
    const input = baseInput({ recurrence: weeklyCountRec, occurrenceIndex: null });
    expect(selectGreeting(input).key).toBe("recurring-meeting-anchor");
  });

  it("routes recurring-with-occurrenceIndex-0 to recurring-meeting-anchor (0 = anchor session view, not followup)", () => {
    // occurrenceIndex 0 means anchor committed but still the anchor occurrence
    // The followup template only fires for ≥1
    const input = baseInput({ recurrence: weeklyCountRec, occurrenceIndex: 0 });
    expect(selectGreeting(input).key).toBe("recurring-meeting-anchor");
  });

  it("routes recurring-with-occurrenceIndex-1 to recurring-meeting-followup", () => {
    const input = baseInput({ recurrence: weeklyCountRec, occurrenceIndex: 1 });
    expect(selectGreeting(input).key).toBe("recurring-meeting-followup");
  });

  it("routes recurring anonymous (office-hours-with-series) to recurring-anchor over anonymous", () => {
    // An office-hours-with-series child is BOTH isAnonymousLink=true AND has recurrence.
    // Recurring takes priority.
    const input = baseInput({
      isAnonymousLink: true,
      isOfficeHoursLink: true,
      recurrence: weeklyCountRec,
      occurrenceIndex: null,
    });
    expect(selectGreeting(input).key).toBe("recurring-meeting-anchor");
  });
});

describe("greeting registry — recurring-meeting-anchor render", () => {
  it("renders named anchor with count: 30 min, weekly, 10 sessions", () => {
    const input = baseInput({
      greeteeName: "Pat",
      rawTopic: "piano lesson",
      recurrence: weeklyCountRec,
      occurrenceIndex: null,
    });
    const out = GREETINGS["recurring-meeting-anchor"].render(input);
    expect(out).toBe(
      [
        "👋 Pat! I'm here to help you set up your piano lesson sessions with John.",
        "Please pick from any of the slots below — they are 30 min long, recurring weekly at the same time (10 sessions).",
        "If you need to change anything, I can help you make adjustments at any time.",
      ].join("\n\n"),
    );
  });

  it("renders anonymous anchor (office-hours-with-series) — greeteeName 'there', no count suffix for until-date", () => {
    const input = baseInput({
      greeteeName: "there",
      isAnonymousLink: true,
      isOfficeHoursLink: true,
      rawTopic: "coaching",
      recurrence: biweeklyUntilRec,
      occurrenceIndex: null,
    });
    const out = GREETINGS["recurring-meeting-anchor"].render(input);
    expect(out).toBe(
      [
        "👋 there! I'm here to help you set up your coaching sessions with John.",
        "Please pick from any of the slots below — they are 45 min long, recurring every other week at the same time.",
        "If you need to change anything, I can help you make adjustments at any time.",
      ].join("\n\n"),
    );
  });

  it("falls back to 'meeting' topic when rawTopic is null", () => {
    const input = baseInput({
      greeteeName: "Alex",
      rawTopic: null,
      recurrence: weeklyCountRec,
      occurrenceIndex: null,
    });
    const out = GREETINGS["recurring-meeting-anchor"].render(input);
    expect(out).toContain("your meeting sessions with John");
  });
});

describe("greeting registry — recurring-meeting-followup render", () => {
  it("renders session N of total for count-based endBy", () => {
    const input = baseInput({
      greeteeName: "Pat",
      recurrence: weeklyCountRec,
      occurrenceIndex: 2, // 3rd session (0-based), display as "Session 3 of 10"
    });
    const out = GREETINGS["recurring-meeting-followup"].render(input);
    expect(out).toBe(
      [
        "👋 Pat! Session 3 of 10 with John is coming up.",
        "This is your recurring weekly slot — confirm below or let me know if anything needs to shift.",
      ].join("\n\n"),
    );
  });

  it("renders session N without total for until-date endBy", () => {
    const input = baseInput({
      greeteeName: "Pat",
      recurrence: biweeklyUntilRec,
      occurrenceIndex: 1,
    });
    const out = GREETINGS["recurring-meeting-followup"].render(input);
    expect(out).toBe(
      [
        "👋 Pat! Session 2 with John is coming up.",
        "This is your recurring every other week slot — confirm below or let me know if anything needs to shift.",
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
