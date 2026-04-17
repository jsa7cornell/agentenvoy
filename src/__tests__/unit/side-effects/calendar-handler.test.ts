/**
 * Unit tests for the calendar handler — mode routing behavior for the
 * three calendar kinds (create_event, create_hold, delete_event).
 *
 * SES-style mocking: we stub the lazy-imported Google Calendar client so
 * no real network call can happen even if the test flow drifts.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

// Mock the Google Calendar client factory. Each test can set up
// `eventsInsertMock` / `eventsDeleteMock` behavior independently.
const eventsInsertMock = vi.fn();
const eventsDeleteMock = vi.fn();
vi.mock("@/lib/calendar", () => ({
  getGoogleCalendarClient: vi.fn(async () => ({
    events: {
      insert: eventsInsertMock,
      delete: eventsDeleteMock,
    },
  })),
}));

import {
  handleCalendarCreateEvent,
  handleCalendarCreateHold,
  handleCalendarDeleteEvent,
  summarizeCalendarCreateEventTarget,
  summarizeCalendarCreateHoldTarget,
  summarizeCalendarDeleteEventTarget,
} from "@/lib/side-effects/handlers/calendar";
import type {
  CalendarCreateEventEffect,
  CalendarCreateHoldEffect,
  CalendarDeleteEventEffect,
} from "@/lib/side-effects/types";

const baseCreateEvent: CalendarCreateEventEffect = {
  kind: "calendar.create_event",
  userId: "user_1",
  summary: "Q2 Review — Sarah",
  description: "Meeting",
  startTime: new Date("2026-04-20T17:00:00Z"),
  endTime: new Date("2026-04-20T17:30:00Z"),
  attendeeEmails: ["host@example.com", "guest@example.com"],
  addMeetLink: true,
  sessionId: "sess_1",
};

const baseCreateHold: CalendarCreateHoldEffect = {
  kind: "calendar.create_hold",
  userId: "user_1",
  summary: "HOLD — Q2 Review",
  startTime: new Date("2026-04-20T17:00:00Z"),
  endTime: new Date("2026-04-20T17:30:00Z"),
};

const baseDeleteEvent: CalendarDeleteEventEffect = {
  kind: "calendar.delete_event",
  userId: "user_1",
  eventId: "gcal_evt_abc",
  notifyAttendees: false,
};

beforeEach(() => {
  eventsInsertMock.mockReset();
  eventsDeleteMock.mockReset();
  delete process.env.CALENDAR_SEND_UPDATES;
});

afterEach(() => {
  delete process.env.CALENDAR_SEND_UPDATES;
});

// ─────────────────────────────────────────────────────────────────────────────
// calendar.create_event
// ─────────────────────────────────────────────────────────────────────────────

describe("handleCalendarCreateEvent", () => {
  it("mode off → skipped, no Google call", async () => {
    const o = await handleCalendarCreateEvent(baseCreateEvent, "off");
    expect(o.status).toBe("skipped");
    expect(o.effectiveMode).toBe("off");
    expect(o.eventId).toBeNull();
    expect(eventsInsertMock).not.toHaveBeenCalled();
  });

  it("mode log → suppressed, null IDs, no Google call", async () => {
    const o = await handleCalendarCreateEvent(baseCreateEvent, "log");
    expect(o.status).toBe("suppressed");
    expect(o.effectiveMode).toBe("log");
    expect(o.eventId).toBeNull();
    expect(o.meetLink).toBeNull();
    expect(eventsInsertMock).not.toHaveBeenCalled();
  });

  it("mode dryrun → synthetic eventId, htmlLink, meetLink when addMeetLink=true", async () => {
    const o = await handleCalendarCreateEvent(baseCreateEvent, "dryrun");
    expect(o.status).toBe("dryrun");
    expect(o.effectiveMode).toBe("dryrun");
    expect(o.eventId).toMatch(/^dryrun-/);
    expect(o.htmlLink).toMatch(/calendar\.google\.com/);
    expect(o.meetLink).toMatch(/meet\.google\.com\/dryrun-/);
    expect(eventsInsertMock).not.toHaveBeenCalled();
  });

  it("mode dryrun with addMeetLink=false → null meetLink", async () => {
    const o = await handleCalendarCreateEvent(
      { ...baseCreateEvent, addMeetLink: false },
      "dryrun",
    );
    expect(o.meetLink).toBeNull();
  });

  it("mode live → calls Google with sendUpdates=all by default, returns real data", async () => {
    eventsInsertMock.mockResolvedValueOnce({
      data: {
        id: "gcal_evt_xyz",
        htmlLink: "https://calendar.google.com/event?id=xyz",
        conferenceData: {
          entryPoints: [{ entryPointType: "video", uri: "https://meet.google.com/abc-def-hij" }],
        },
      },
    });
    const o = await handleCalendarCreateEvent(baseCreateEvent, "live");
    expect(eventsInsertMock).toHaveBeenCalledTimes(1);
    const callArg = eventsInsertMock.mock.calls[0][0];
    expect(callArg.sendUpdates).toBe("all");
    expect(callArg.conferenceDataVersion).toBe(1);
    expect(o.status).toBe("sent");
    expect(o.eventId).toBe("gcal_evt_xyz");
    expect(o.meetLink).toBe("https://meet.google.com/abc-def-hij");
  });

  it("mode live → honors CALENDAR_SEND_UPDATES=none", async () => {
    process.env.CALENDAR_SEND_UPDATES = "none";
    eventsInsertMock.mockResolvedValueOnce({ data: { id: "x" } });
    await handleCalendarCreateEvent(baseCreateEvent, "live");
    expect(eventsInsertMock.mock.calls[0][0].sendUpdates).toBe("none");
  });

  it("mode live → effect-level sendUpdatesOverride trumps env", async () => {
    process.env.CALENDAR_SEND_UPDATES = "none";
    eventsInsertMock.mockResolvedValueOnce({ data: { id: "x" } });
    await handleCalendarCreateEvent(
      { ...baseCreateEvent, sendUpdatesOverride: "all" },
      "live",
    );
    expect(eventsInsertMock.mock.calls[0][0].sendUpdates).toBe("all");
  });

  it("mode live → Google error returns failed with message", async () => {
    eventsInsertMock.mockRejectedValueOnce(new Error("403 Forbidden"));
    const o = await handleCalendarCreateEvent(baseCreateEvent, "live");
    expect(o.status).toBe("failed");
    expect(o.error).toBe("403 Forbidden");
    expect(o.eventId).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// calendar.create_hold
// ─────────────────────────────────────────────────────────────────────────────

describe("handleCalendarCreateHold", () => {
  it("mode log → suppressed, no Google call", async () => {
    const o = await handleCalendarCreateHold(baseCreateHold, "log");
    expect(o.status).toBe("suppressed");
    expect(eventsInsertMock).not.toHaveBeenCalled();
  });

  it("mode dryrun → synthetic hold eventId", async () => {
    const o = await handleCalendarCreateHold(baseCreateHold, "dryrun");
    expect(o.status).toBe("dryrun");
    expect(o.eventId).toMatch(/^dryrun-hold-/);
  });

  it("mode live → creates tentative event with sendUpdates=none, no attendees", async () => {
    eventsInsertMock.mockResolvedValueOnce({
      data: { id: "hold_evt_1", htmlLink: "https://cal/1" },
    });
    const o = await handleCalendarCreateHold(baseCreateHold, "live");
    expect(eventsInsertMock).toHaveBeenCalledTimes(1);
    const callArg = eventsInsertMock.mock.calls[0][0];
    expect(callArg.sendUpdates).toBe("none");
    expect(callArg.requestBody.status).toBe("tentative");
    expect(callArg.requestBody.transparency).toBe("opaque");
    expect(callArg.requestBody.attendees).toBeUndefined();
    expect(o.status).toBe("sent");
    expect(o.eventId).toBe("hold_evt_1");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// calendar.delete_event
// ─────────────────────────────────────────────────────────────────────────────

describe("handleCalendarDeleteEvent", () => {
  it("mode log → suppressed, no Google call", async () => {
    const o = await handleCalendarDeleteEvent(baseDeleteEvent, "log");
    expect(o.status).toBe("suppressed");
    expect(eventsDeleteMock).not.toHaveBeenCalled();
  });

  it("mode dryrun → returns dryrun status, no Google call", async () => {
    const o = await handleCalendarDeleteEvent(baseDeleteEvent, "dryrun");
    expect(o.status).toBe("dryrun");
    expect(eventsDeleteMock).not.toHaveBeenCalled();
  });

  it("mode live → calls Google delete with sendUpdates=none by default", async () => {
    eventsDeleteMock.mockResolvedValueOnce({});
    const o = await handleCalendarDeleteEvent(baseDeleteEvent, "live");
    expect(eventsDeleteMock).toHaveBeenCalledTimes(1);
    expect(eventsDeleteMock.mock.calls[0][0].sendUpdates).toBe("none");
    expect(o.status).toBe("sent");
  });

  it("mode live with notifyAttendees=true → sendUpdates=all", async () => {
    eventsDeleteMock.mockResolvedValueOnce({});
    await handleCalendarDeleteEvent(
      { ...baseDeleteEvent, notifyAttendees: true },
      "live",
    );
    expect(eventsDeleteMock.mock.calls[0][0].sendUpdates).toBe("all");
  });

  it("mode live → treats 404 as success (already gone)", async () => {
    eventsDeleteMock.mockRejectedValueOnce({ code: 404, message: "Not Found" });
    const o = await handleCalendarDeleteEvent(baseDeleteEvent, "live");
    expect(o.status).toBe("sent");
  });

  it("mode live → treats 410 as success (already gone)", async () => {
    eventsDeleteMock.mockRejectedValueOnce({ code: 410, message: "Gone" });
    const o = await handleCalendarDeleteEvent(baseDeleteEvent, "live");
    expect(o.status).toBe("sent");
  });

  it("mode live → 500 returns failed", async () => {
    eventsDeleteMock.mockRejectedValueOnce({ code: 500, message: "Internal" });
    const o = await handleCalendarDeleteEvent(baseDeleteEvent, "live");
    expect(o.status).toBe("failed");
    expect(o.error).toBe("Internal");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Target summaries
// ─────────────────────────────────────────────────────────────────────────────

describe("summarizers", () => {
  it("create_event → title + time + attendee count", () => {
    expect(summarizeCalendarCreateEventTarget(baseCreateEvent)).toMatch(
      /Q2 Review — Sarah · 2026-04-20 17:00Z · 2 attendees/,
    );
  });

  it("create_event → singular attendee", () => {
    expect(
      summarizeCalendarCreateEventTarget({
        ...baseCreateEvent,
        attendeeEmails: ["solo@example.com"],
      }),
    ).toMatch(/1 attendee$/);
  });

  it("create_hold → HOLD prefix + time", () => {
    expect(summarizeCalendarCreateHoldTarget(baseCreateHold)).toMatch(
      /^HOLD · HOLD — Q2 Review · 2026-04-20 17:00Z$/,
    );
  });

  it("delete_event → eventId", () => {
    expect(summarizeCalendarDeleteEventTarget(baseDeleteEvent)).toBe("delete gcal_evt_abc");
  });

  it("delete_event with notify → adds (notify)", () => {
    expect(
      summarizeCalendarDeleteEventTarget({ ...baseDeleteEvent, notifyAttendees: true }),
    ).toBe("delete gcal_evt_abc (notify)");
  });
});
