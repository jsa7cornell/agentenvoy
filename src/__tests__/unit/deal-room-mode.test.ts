/**
 * Pure deal-room-mode derivation tests. Covers §3.1 of the decided proposal
 * `2026-04-21_deal-room-widget-state-machine-and-agent-dialog-clarity` —
 * `confirmed` / `offer` / `negotiate` resolution across the full input set
 * (session status, viewer tz, available slots, guest escape-hatch flag,
 * link.intent.steering).
 *
 * Also covers `sameLocalDay` tz-boundary behavior — the load-bearing bit
 * that makes the "same local day in guest's tz" check more than a calendar-
 * date string match.
 */
import { describe, it, expect } from "vitest";
import {
  deriveMode,
  sameLocalDay,
  type ModeSession,
  type ModeWidgetState,
} from "@/lib/deal-room-mode";

function makeSession(overrides: Partial<ModeSession> = {}): ModeSession {
  return {
    status: "active",
    viewerTimezone: "America/Los_Angeles",
    guestTimezone: null,
    ...overrides,
  };
}

function makeWidget(overrides: Partial<ModeWidgetState> = {}): ModeWidgetState {
  return {
    availableSlots: [],
    guestRequestedMoreOptions: false,
    link: { intent: null },
    ...overrides,
  };
}

describe("deriveMode — §3.1 proposal 2026-04-21_deal-room-widget-state-machine", () => {
  it("agreed session → confirmed (terminal)", () => {
    expect(
      deriveMode(makeSession({ status: "agreed" }), makeWidget()),
    ).toBe("confirmed");
  });

  it("agreed session → confirmed even with other inputs that would resolve to offer", () => {
    // Confirmed is terminal; nothing else about the widget matters.
    expect(
      deriveMode(
        makeSession({ status: "agreed" }),
        makeWidget({
          availableSlots: [{ start: "2026-05-04T15:00:00-07:00" }],
          link: { intent: { steering: "exclusive" } },
        }),
      ),
    ).toBe("confirmed");
  });

  it("guestRequestedMoreOptions=true → negotiate (regardless of other inputs)", () => {
    // Escape hatch is sticky: even a perfectly-shaped offer set flips to
    // negotiate once the guest has asked for more options.
    expect(
      deriveMode(
        makeSession(),
        makeWidget({
          guestRequestedMoreOptions: true,
          availableSlots: [{ start: "2026-05-04T15:00:00-07:00" }],
          link: { intent: { steering: "exclusive" } },
        }),
      ),
    ).toBe("negotiate");
  });

  it("exclusive intent + 1 slot → offer", () => {
    expect(
      deriveMode(
        makeSession(),
        makeWidget({
          availableSlots: [{ start: "2026-05-04T15:00:00-07:00" }],
          link: { intent: { steering: "exclusive" } },
        }),
      ),
    ).toBe("offer");
  });

  it("3 slots same day (host tz) → offer", () => {
    // 10am, 1pm, 3pm PT on Tuesday 2026-05-05. All fall on the same local
    // calendar day in America/Los_Angeles.
    expect(
      deriveMode(
        makeSession(),
        makeWidget({
          availableSlots: [
            { start: "2026-05-05T17:00:00Z" }, // 10:00 PT
            { start: "2026-05-05T20:00:00Z" }, // 13:00 PT
            { start: "2026-05-05T22:00:00Z" }, // 15:00 PT
          ],
        }),
      ),
    ).toBe("offer");
  });

  it("same slots read in a tz that splits them → offer only in the intended tz", () => {
    // Slots: Tue 9 AM PT and Tue 11 PM PT — both Tuesday in PT. In
    // America/New_York the first lands Tue 12:00 PM, the second lands
    // Wed 02:00 AM. PT-grouped → same day; ET-grouped → split day.
    const slots = [
      { start: "2026-05-05T16:00:00Z" }, // Tue 09:00 PT / Tue 12:00 ET
      { start: "2026-05-06T06:00:00Z" }, // Tue 23:00 PT / Wed 02:00 ET
    ];
    // Verify the dates first to avoid silent test drift: both in PT land
    // on 2026-05-05 (Tuesday).
    expect(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Los_Angeles",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date(slots[0].start)),
    ).toBe("2026-05-05");
    expect(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Los_Angeles",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date(slots[1].start)),
    ).toBe("2026-05-05");

    // PT guest sees a same-day pair → offer.
    expect(
      deriveMode(
        makeSession({ viewerTimezone: "America/Los_Angeles" }),
        makeWidget({ availableSlots: slots }),
      ),
    ).toBe("offer");
    // ET guest sees a day-split → negotiate.
    expect(
      deriveMode(
        makeSession({ viewerTimezone: "America/New_York" }),
        makeWidget({ availableSlots: slots }),
      ),
    ).toBe("negotiate");
  });

  it("2 slots on two different days → negotiate", () => {
    expect(
      deriveMode(
        makeSession(),
        makeWidget({
          availableSlots: [
            { start: "2026-05-05T20:00:00Z" }, // Tue 13:00 PT
            { start: "2026-05-06T20:00:00Z" }, // Wed 13:00 PT
          ],
        }),
      ),
    ).toBe("negotiate");
  });

  it("empty slots → negotiate", () => {
    expect(deriveMode(makeSession(), makeWidget({ availableSlots: [] }))).toBe(
      "negotiate",
    );
  });

  it("4 slots same day → negotiate (smallList cap is 3)", () => {
    expect(
      deriveMode(
        makeSession(),
        makeWidget({
          availableSlots: [
            { start: "2026-05-05T17:00:00Z" }, // 10 PT
            { start: "2026-05-05T19:00:00Z" }, // 12 PT
            { start: "2026-05-05T21:00:00Z" }, // 14 PT
            { start: "2026-05-05T23:00:00Z" }, // 16 PT
          ],
        }),
      ),
    ).toBe("negotiate");
  });

  it("viewerTimezone picker-authoritative over legacy guestTimezone (B2 fold)", () => {
    // Two slots both in PT-local Tuesday but split across a day boundary
    // in ET. If the legacy column were (wrongly) read as the source of
    // truth, a guest who had tapped the picker to PT would get a negotiate
    // answer. This test verifies viewerTimezone wins.
    const slots = [
      { start: "2026-05-05T16:00:00Z" }, // Tue 09:00 PT / Tue 12:00 ET
      { start: "2026-05-06T06:00:00Z" }, // Tue 23:00 PT / Wed 02:00 ET
    ];
    const session = makeSession({
      viewerTimezone: "America/Los_Angeles",
      guestTimezone: "America/New_York",
    });
    expect(deriveMode(session, makeWidget({ availableSlots: slots }))).toBe(
      "offer",
    );
  });

  it("pre-PR-58 link (no intent blob) — falls through to slot-count rule (N7 fold)", () => {
    // No intent.steering at all. With a small same-day set this still
    // resolves to offer via the default rule.
    expect(
      deriveMode(
        makeSession(),
        makeWidget({
          availableSlots: [{ start: "2026-05-05T20:00:00Z" }],
          link: {}, // no intent at all
        }),
      ),
    ).toBe("offer");
  });

  it("exclusive intent with MULTIPLE slots → not the exclusive branch; generic rule applies", () => {
    // `exclusiveFromHost` requires slots.length === 1. With 2+ slots the
    // path falls through to the smallList + sameDay rule.
    const slots = [
      { start: "2026-05-05T17:00:00Z" }, // 10 PT
      { start: "2026-05-05T20:00:00Z" }, // 13 PT
    ];
    expect(
      deriveMode(
        makeSession(),
        makeWidget({
          availableSlots: slots,
          link: { intent: { steering: "exclusive" } },
        }),
      ),
    ).toBe("offer");
  });
});

describe("sameLocalDay — tz boundary correctness", () => {
  it("Tue 11pm PT vs Wed 12am PT in PT → false (different local dates)", () => {
    // 11:00 PM Tue 2026-05-05 PT = 2026-05-06T06:00:00Z
    // 12:00 AM Wed 2026-05-06 PT = 2026-05-06T07:00:00Z
    const tue11pm = "2026-05-06T06:00:00Z";
    const wed12am = "2026-05-06T07:00:00Z";
    expect(sameLocalDay(tue11pm, wed12am, "America/Los_Angeles")).toBe(false);
  });

  it("same instant in the same tz → true", () => {
    const t = "2026-05-05T20:00:00Z";
    expect(sameLocalDay(t, t, "America/Los_Angeles")).toBe(true);
  });

  it("two instants on the same local day in tz → true", () => {
    const a = "2026-05-05T17:00:00Z"; // 10 PT Tue
    const b = "2026-05-05T22:00:00Z"; // 15 PT Tue
    expect(sameLocalDay(a, b, "America/Los_Angeles")).toBe(true);
  });

  it("crossing the UTC day boundary but same local day in tz → true", () => {
    // 23:30 PT Tue and 00:30 PT Wed both in ET as a sanity check — no,
    // that's the opposite. Here the useful case: evening PT slot that
    // crosses midnight UTC but stays Tuesday locally.
    const a = "2026-05-06T02:00:00Z"; // Mon 19:00 PT
    const b = "2026-05-06T05:00:00Z"; // Mon 22:00 PT
    expect(sameLocalDay(a, b, "America/Los_Angeles")).toBe(true);
  });

  it("invalid ISO string → false (graceful, not a throw)", () => {
    expect(sameLocalDay("not-a-date", "2026-05-05T20:00:00Z", "UTC")).toBe(
      false,
    );
  });
});
