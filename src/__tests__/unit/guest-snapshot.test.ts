import { describe, it, expect } from "vitest";
import { filterGuestEvents, type RawCalendarEvent } from "@/lib/guest-snapshot";

// Compact factory for fixture events. Defaults are an unprivate, opaque,
// confirmed, accepted event — the "default render this" base case.
function ev(overrides: Partial<RawCalendarEvent> = {}): RawCalendarEvent {
  return {
    status: "confirmed",
    visibility: "default",
    transparency: "opaque",
    summary: "Standup",
    start: { dateTime: "2026-04-30T17:00:00.000Z" },
    end: { dateTime: "2026-04-30T17:30:00.000Z" },
    attendees: [{ self: true, responseStatus: "accepted" }],
    ...overrides,
  };
}

describe("filterGuestEvents — render rules", () => {
  it("emits both an event (with title) and a busy interval for the default case", () => {
    const out = filterGuestEvents([ev()]);
    expect(out.events).toHaveLength(1);
    expect(out.events[0]).toEqual({
      start: "2026-04-30T17:00:00.000Z",
      end: "2026-04-30T17:30:00.000Z",
      title: "Standup",
    });
    expect(out.busy).toHaveLength(1);
    expect(out.busy[0]).toEqual({
      start: "2026-04-30T17:00:00.000Z",
      end: "2026-04-30T17:30:00.000Z",
    });
  });

  it("strips title for visibility=private but keeps the busy interval", () => {
    const out = filterGuestEvents([ev({ visibility: "private", summary: "Therapy" })]);
    expect(out.events).toHaveLength(1);
    expect(out.events[0].title).toBeUndefined();
    expect(out.events[0].start).toBe("2026-04-30T17:00:00.000Z");
    // Busy still emits — the slot is consumed time, even if we don't render the name.
    expect(out.busy).toHaveLength(1);
  });

  it("drops events with transparency=transparent entirely (focus-time markers)", () => {
    const out = filterGuestEvents([
      ev({ transparency: "transparent", summary: "Focus block" }),
    ]);
    expect(out.events).toHaveLength(0);
    expect(out.busy).toHaveLength(0);
  });

  it("drops events with status=cancelled entirely", () => {
    const out = filterGuestEvents([ev({ status: "cancelled" })]);
    expect(out.events).toHaveLength(0);
    expect(out.busy).toHaveLength(0);
  });

  it("drops events the self attendee declined", () => {
    const out = filterGuestEvents([
      ev({
        attendees: [{ self: true, responseStatus: "declined" }],
      }),
    ]);
    expect(out.events).toHaveLength(0);
    expect(out.busy).toHaveLength(0);
  });

  it("keeps events the self attendee accepted or didn't respond to", () => {
    const accepted = filterGuestEvents([
      ev({ attendees: [{ self: true, responseStatus: "accepted" }] }),
    ]);
    expect(accepted.events).toHaveLength(1);

    const noReply = filterGuestEvents([
      ev({ attendees: [{ self: true, responseStatus: "needsAction" }] }),
    ]);
    expect(noReply.events).toHaveLength(1);

    const noAttendees = filterGuestEvents([ev({ attendees: null })]);
    expect(noAttendees.events).toHaveLength(1);
  });

  it("keeps all-day events (date-only start/end)", () => {
    const out = filterGuestEvents([
      ev({
        start: { date: "2026-05-01" },
        end: { date: "2026-05-02" },
        summary: "Conference",
      }),
    ]);
    expect(out.events).toHaveLength(1);
    expect(out.events[0].title).toBe("Conference");
    expect(out.events[0].start).toBe("2026-05-01T00:00:00.000Z");
  });

  it("strips empty/whitespace titles", () => {
    const blank = filterGuestEvents([ev({ summary: "   " })]);
    expect(blank.events[0].title).toBeUndefined();
    const empty = filterGuestEvents([ev({ summary: "" })]);
    expect(empty.events[0].title).toBeUndefined();
    const missing = filterGuestEvents([ev({ summary: null })]);
    expect(missing.events[0].title).toBeUndefined();
  });

  it("processes a mixed batch with each rule firing independently", () => {
    const out = filterGuestEvents([
      ev({ summary: "Keep me" }),
      ev({ visibility: "private", summary: "Strip me" }),
      ev({ transparency: "transparent", summary: "Drop me — focus" }),
      ev({ status: "cancelled", summary: "Drop me — cancelled" }),
      ev({
        attendees: [{ self: true, responseStatus: "declined" }],
        summary: "Drop me — declined",
      }),
    ]);
    expect(out.events).toHaveLength(2);
    expect(out.events[0].title).toBe("Keep me");
    expect(out.events[1].title).toBeUndefined();
    expect(out.busy).toHaveLength(2);
  });

  it("never emits a title-bearing event without a corresponding busy interval", () => {
    // Property: every events[i] has a matching busy[i] at the same start/end.
    // This is the privacy invariant — anything renderable is also blocking.
    const out = filterGuestEvents([
      ev(),
      ev({ visibility: "private", summary: "Therapy" }),
      ev({ start: { dateTime: "2026-05-01T20:00:00.000Z" }, end: { dateTime: "2026-05-01T21:00:00.000Z" } }),
    ]);
    expect(out.events).toHaveLength(out.busy.length);
    for (let i = 0; i < out.events.length; i++) {
      expect(out.events[i].start).toBe(out.busy[i].start);
      expect(out.events[i].end).toBe(out.busy[i].end);
    }
  });
});
