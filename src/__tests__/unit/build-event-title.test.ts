/**
 * Tests for buildEventTitle — the single-source-of-truth title helper.
 *
 * Anchored to the cmp2qcnjy regression fixture (event-data-model proposal §6
 * verification): "coffee with Christine regarding AI discussion" should
 * produce "Coffee: Christine + John" — not the AI-discussion-as-title shape
 * that drove the redesign.
 */
import { describe, it, expect } from "vitest";
import { buildEventTitle } from "@/lib/build-event-title";

describe("buildEventTitle — 1:1 turns", () => {
  it("cmp2qcnjy regression: coffee with Christine yields 'Coffee: Christine + John'", () => {
    expect(buildEventTitle({
      activity: "coffee",
      isGroup: false,
      inviteeDisplay: "Christine",
      hostFirstName: "John",
    })).toBe("Coffee: Christine + John");
  });

  it("customTitle wins verbatim, ignoring activity/invitee", () => {
    expect(buildEventTitle({
      customTitle: "Q3 board review",
      activity: "coffee",
      inviteeDisplay: "Christine",
      hostFirstName: "John",
    })).toBe("Q3 board review");
  });

  it("customTitle is trimmed", () => {
    expect(buildEventTitle({ customTitle: "  Q3 board review  " })).toBe("Q3 board review");
  });

  it("empty customTitle falls through to formula", () => {
    expect(buildEventTitle({
      customTitle: "  ",
      activity: "coffee",
      inviteeDisplay: "Christine",
      hostFirstName: "John",
    })).toBe("Coffee: Christine + John");
  });

  it("kebab-case activity flattens hyphen in prefix", () => {
    expect(buildEventTitle({
      activity: "bike-ride",
      inviteeDisplay: "Marcus",
      hostFirstName: "John",
    })).toBe("Bike ride: Marcus + John");
  });

  it("cmp457nxd regression: Cima Hack prep with Jason yields the host-named title verbatim (post Fix A/B)", () => {
    // The cmp457nxd-shape bug: the model emitted activity="Cima Hack prep"
    // + inviteeName="Cima Hack prep" + customTitle=null, dropping "Jason"
    // from the prior turn. Title rendered "Cima Hack prep + John" via the
    // 1:1 fallback formula.
    //
    // After Fix A (prompt-level CUSTOM TITLE + MULTI-TURN CONTINUATION rules)
    // and Fix B (handler-side activity-vocab guard reclassifying free-form
    // activity → customTitle), the inputs to buildEventTitle are correct
    // and the title renders the host's intent:
    expect(buildEventTitle({
      customTitle: "Cima Hack prep",
      activity: null,
      inviteeDisplay: "Jason",
      hostFirstName: "John",
    })).toBe("Cima Hack prep");
  });

  it("activity alias resolves to canonical name in prefix", () => {
    // "biking" is an alias of bike-ride
    expect(buildEventTitle({
      activity: "biking",
      inviteeDisplay: "Marcus",
      hostFirstName: "John",
    })).toBe("Bike ride: Marcus + John");
  });

  it("falls back to format prefix when activity is unknown", () => {
    expect(buildEventTitle({
      activity: "some-unknown-thing",
      format: "phone",
      inviteeDisplay: "Susan",
      hostFirstName: "John",
    })).toBe("Call: Susan + John");
  });

  it("format=video uses 'VC' prefix", () => {
    expect(buildEventTitle({
      format: "video",
      inviteeDisplay: "Susan",
      hostFirstName: "John",
    })).toBe("VC: Susan + John");
  });

  it("no activity / no format / 1:1 → just names", () => {
    expect(buildEventTitle({
      inviteeDisplay: "Susan",
      hostFirstName: "John",
    })).toBe("Susan + John");
  });

  // cmp50uvuq end-state contract: when the handler drops a generic-topic
  // `activity: "meeting"` via the GENERIC_TOPICS guard, both `activity` and
  // `customTitle` arrive at buildEventTitle as null. With format=video set
  // (or guest-pick-format defaulting), the title composes via the format
  // prefix → "VC: Geoff + John". Pre-fix the generic-topic word leaked into
  // customTitle and overrode the composition, producing the literal lowercase
  // "meeting" as the session title.
  it("no customTitle / no activity / format=video — generic-topic drop produces VC composition (cmp50uvuq)", () => {
    expect(buildEventTitle({
      customTitle: null,
      activity: null,
      format: "video",
      inviteeDisplay: "Geoff",
      hostFirstName: "John",
    })).toBe("VC: Geoff + John");
  });

  it("ditto without format → just names (also acceptable; the handler may pass null format on guestPicks.format=true)", () => {
    expect(buildEventTitle({
      customTitle: null,
      activity: null,
      inviteeDisplay: "Geoff",
      hostFirstName: "John",
    })).toBe("Geoff + John");
  });

  it("no host first name → falls back to prefix:invitee", () => {
    expect(buildEventTitle({
      activity: "coffee",
      inviteeDisplay: "Susan",
    })).toBe("Coffee: Susan");
  });

  it("no invitee → returns prefix alone", () => {
    expect(buildEventTitle({
      activity: "coffee",
      hostFirstName: "John",
    })).toBe("Coffee");
  });

  it("nothing populated → 'Meeting'", () => {
    expect(buildEventTitle({})).toBe("Meeting");
  });

  it("format-flex activity (meet) still derives prefix", () => {
    expect(buildEventTitle({
      activity: "meet",
      inviteeDisplay: "Sarah",
      hostFirstName: "John",
    })).toBe("Meet: Sarah + John");
  });
});

describe("buildEventTitle — group turns", () => {
  it("activity + group → 'Prefix (names)'", () => {
    expect(buildEventTitle({
      activity: "dinner",
      isGroup: true,
      firstNamesDisplay: "Sarah, Marcus, Diane",
    })).toBe("Dinner (Sarah, Marcus, Diane)");
  });

  it("group with no activity → just names", () => {
    expect(buildEventTitle({
      isGroup: true,
      firstNamesDisplay: "Sarah, Marcus, Diane",
    })).toBe("Sarah, Marcus, Diane");
  });

  it("group with activity but no names → just prefix", () => {
    expect(buildEventTitle({
      activity: "brainstorm",
      isGroup: true,
    })).toBe("Brainstorm");
  });

  it("group with nothing → 'Meeting'", () => {
    expect(buildEventTitle({ isGroup: true })).toBe("Meeting");
  });

  it("customTitle wins on group too", () => {
    expect(buildEventTitle({
      customTitle: "Founder Dinner",
      isGroup: true,
      firstNamesDisplay: "Sarah, Marcus, Diane",
    })).toBe("Founder Dinner");
  });
});

// ── Format-aware prefix overrides (2026-05-14 cmp4u*) ───────────────────────
describe("buildEventTitle — format-aware prefix overrides (cmp4u*)", () => {
  // Pre-cmp4u* "call" → "Call" via titleCaseActivity, regardless of format.
  // Production bug: "grab 45 mins VC with Calle" produced "Call: Calle + John"
  // because the vocab match for "call" beat the FORMAT_PREFIX_MAP fallback.
  // Fix: the "call" vocab entry now defines prefixByFormat = { video: "VC",
  // phone: "Call", in-person: "Meeting" }, which buildEventTitle consults
  // before falling through to titleCaseActivity.

  it("call + video → 'VC: <invitee> + <host>' (the bug — was 'Call: ...')", () => {
    expect(buildEventTitle({
      activity: "call",
      format: "video",
      inviteeDisplay: "Calle",
      hostFirstName: "John",
    })).toBe("VC: Calle + John");
  });

  it("call + phone → 'Call: <invitee> + <host>' (phone-call shape preserved)", () => {
    expect(buildEventTitle({
      activity: "call",
      format: "phone",
      inviteeDisplay: "Sarah",
      hostFirstName: "John",
    })).toBe("Call: Sarah + John");
  });

  it("call + in-person → 'Meeting: <invitee> + <host>' (rare combo)", () => {
    expect(buildEventTitle({
      activity: "call",
      format: "in-person",
      inviteeDisplay: "Bob",
      hostFirstName: "John",
    })).toBe("Meeting: Bob + John");
  });

  it("call with no format → falls back to title-cased canonical name 'Call'", () => {
    // Defensive: a turn without a format should still produce a stable title
    // rather than null/empty. Falls through to titleCaseActivity → "Call".
    // Documents the back-compat path.
    expect(buildEventTitle({
      activity: "call",
      inviteeDisplay: "Calle",
      hostFirstName: "John",
    })).toBe("Call: Calle + John");
  });

  it("call aliases route through prefixByFormat too ('VC' / 'video call' / 'zoom call')", () => {
    for (const alias of ["VC", "video call", "zoom call", "Zoom"]) {
      expect(
        buildEventTitle({
          activity: alias,
          format: "video",
          inviteeDisplay: "Calle",
          hostFirstName: "John",
        }),
        `expected VC prefix for alias: ${alias}`,
      ).toBe("VC: Calle + John");
    }
  });

  it("other entries (no prefixByFormat) ignore format and use title-cased canonical name", () => {
    // Sanity check that the format-aware path doesn't accidentally affect
    // entries that haven't opted in.
    expect(buildEventTitle({
      activity: "coffee",
      format: "video", // unusual combo — coffee is in-person-locked by vocab
      inviteeDisplay: "Christine",
      hostFirstName: "John",
    })).toBe("Coffee: Christine + John");
  });
});

// ── Em-dash composite extraction (2026-05-14 cmp51ltr5) ─────────────────────
describe("buildEventTitle — em-dash composite topic extraction (cmp51ltr5)", () => {
  // The VERB+TOPIC convention in unified-agent.md tells the model to combine
  // both pieces into the `activity` field as "{verb} — {topic}" so both are
  // preserved in the event title. Pre-fix, buildEventTitle treated em-dash
  // composites as opaque (findActivity returned null on the full string),
  // and the topic disappeared from the title entirely.
  //
  // Fix: extract the topic after " — " and use it as the title verbatim.
  // The verb still drives downstream surfaces (emoji, format inference)
  // via `parameters.activity` — storage shape unchanged, only display
  // changes.

  it("'call — Using AI at Sugarbowl' produces 'Using AI at Sugarbowl' (cmp51ltr5 exact case)", () => {
    expect(buildEventTitle({
      activity: "call — Using AI at Sugarbowl",
      format: "video",
      inviteeDisplay: "Mark Beavor",
      hostFirstName: "John",
    })).toBe("Using AI at Sugarbowl");
  });

  it("'coffee — Q3 launch' produces 'Q3 launch' (the prompt's canonical example)", () => {
    expect(buildEventTitle({
      activity: "coffee — Q3 launch",
      inviteeDisplay: "Bob",
      hostFirstName: "John",
    })).toBe("Q3 launch");
  });

  it("'lunch — Q3 launch' (the prompt's lunch example) produces 'Q3 launch'", () => {
    expect(buildEventTitle({
      activity: "lunch — Q3 launch",
      inviteeDisplay: "Bob",
      hostFirstName: "John",
    })).toBe("Q3 launch");
  });

  it("'coffee — AI discussion continued' (the cmp2qcnjy regression case) produces the topic", () => {
    // The 2026-05-12 event-data-model proposal §6 had this exact fixture as
    // the regression check for the VERB+TOPIC fix. Pre-cmp51ltr5 it produced
    // "Coffee: Christine + John" (topic dropped). Now produces the topic.
    expect(buildEventTitle({
      activity: "coffee — AI discussion continued",
      inviteeDisplay: "Christine",
      hostFirstName: "John",
    })).toBe("AI discussion continued");
  });

  it("customTitle still wins over em-dash composite when both present", () => {
    expect(buildEventTitle({
      customTitle: "Q3 board review",
      activity: "coffee — Q3 launch",
      inviteeDisplay: "Bob",
      hostFirstName: "John",
    })).toBe("Q3 board review");
  });

  it("falls back to verb-only when em-dash is present but topic side is empty", () => {
    // Defensive: trailing em-dash with whitespace-only topic. Strip the
    // em-dash and treat the verb as the only activity input.
    expect(buildEventTitle({
      activity: "coffee — ",
      inviteeDisplay: "Bob",
      hostFirstName: "John",
    })).toBe("Coffee: Bob + John");
  });

  it("non-em-dash activities pass through unchanged (regression guard)", () => {
    // Plain "coffee" (no em-dash) should still produce the canonical
    // prefix+invitee+host shape. Em-dash detection must not affect this.
    expect(buildEventTitle({
      activity: "coffee",
      inviteeDisplay: "Bob",
      hostFirstName: "John",
    })).toBe("Coffee: Bob + John");
  });
});
