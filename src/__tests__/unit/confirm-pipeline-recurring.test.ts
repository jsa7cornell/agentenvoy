/**
 * Anchor-commit GCal master-event write (proposal §5.9).
 *
 * The contract this test pins:
 *   1. When `link.recurrence` is set, the GCal write carries an RRULE
 *      array derived from the recurrence + the slot the guest just picked.
 *   2. The event description embeds the **materialized child URL**
 *      (`/meet/<slug>/<childCode>`) — never the source-rule URL — per the
 *      [COMPOSER.md §4.6] calendar-doorway invariant.
 *   3. The link row gets `seriesGcalEventId` AND a committed-anchor
 *      `recurrence` written back, so future readers know the series is
 *      committed and reschedule flows can address the master event.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@vercel/functions", () => ({ waitUntil: (p: unknown) => p }));

const mockSessionFindUnique = vi.fn();
const mockAccountFindFirst = vi.fn();
const mockSessionUpdateMany = vi.fn();
const mockLinkUpdate = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    negotiationSession: {
      findUnique: (args: unknown) => mockSessionFindUnique(args),
      updateMany: (args: unknown) => mockSessionUpdateMany(args),
      findMany: vi.fn().mockResolvedValue([]),
    },
    sessionParticipant: {
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    sessionInvitee: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    negotiationLink: {
      update: (args: unknown) => mockLinkUpdate(args),
    },
    account: {
      findFirst: (args: unknown) => mockAccountFindFirst(args),
    },
    message: { findMany: vi.fn().mockResolvedValue([]), create: vi.fn() },
    hold: {
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    negotiationOutcome: { create: vi.fn() },
    channel: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
    },
    channelMessage: { create: vi.fn() },
    user: {
      findUnique: vi.fn().mockResolvedValue(null),
      update: vi.fn(),
    },
  },
}));

const mockCreateCalendarEvent = vi.fn().mockResolvedValue({
  eventId: "gcal_evt_recurring_1",
  meetLink: "https://meet.example/abc",
  htmlLink: "https://cal.example/evt",
});
const mockGetOrComputeSchedule = vi.fn();

vi.mock("@/lib/calendar", () => ({
  createCalendarEvent: (...args: unknown[]) =>
    (mockCreateCalendarEvent as unknown as (...a: unknown[]) => Promise<unknown>)(...args),
  deleteCalendarEvent: vi.fn().mockResolvedValue(undefined),
  invalidateSchedule: vi.fn().mockResolvedValue(undefined),
  getOrComputeSchedule: (...args: unknown[]) => mockGetOrComputeSchedule(...args),
}));

vi.mock("@/lib/oauth/required-scopes", () => ({ HOST_WRITE_SCOPE: "cal-w" }));
vi.mock("@/agent/agent-runner", () => ({
  extractLearnings: vi.fn().mockResolvedValue({ persistent: "", situational: "" }),
}));
vi.mock("@/lib/timezone", () => ({
  getUserTimezone: () => "America/Los_Angeles",
}));
vi.mock("@/lib/side-effects/dispatcher", () => ({
  dispatch: vi.fn().mockResolvedValue({ status: "sent" }),
}));
vi.mock("@/lib/route-error", () => ({ logRouteError: vi.fn() }));
vi.mock("@/lib/emails/guest-confirmation", () => ({
  buildGuestConfirmationEmail: () => ({ subject: "s", html: "<p/>" }),
}));

vi.mock("@/lib/scoring", async () => {
  const actual = await vi.importActual<typeof import("@/lib/scoring")>(
    "@/lib/scoring",
  );
  return {
    ...actual,
    applyEventOverrides: (slots: unknown) => slots,
    filterByDuration: (slots: unknown) => slots,
  };
});

import { confirmBooking } from "@/lib/confirm-pipeline";

const hostId = "host_recur";
const sessionId = "sess_recur";
const linkId = "link_recur";
// Mon 2026-05-04 15:00 PDT == 22:00 UTC.
const SLOT_ISO = "2026-05-04T22:00:00.000Z";

function stubRecurringSession(opts: {
  childCode: string;
  recurrence: Record<string, unknown> | null;
}) {
  mockSessionFindUnique.mockResolvedValueOnce({
    id: sessionId,
    hostId,
    status: "active",
    agreedTime: null,
    agreedFormat: null,
    meetLink: null,
    guestTimezone: null,
    guestEmail: null,
    guestName: null,
    guestId: null,
    createdAt: new Date("2026-05-01T00:00:00Z"),
    format: null,
    linkId,
    link: {
      id: linkId,
      mode: "single",
      slug: "johnanderson",
      code: opts.childCode,
      type: "contextual",
      topic: "Coaching Program",
      inviteeName: null,
      inviteeEmail: null,
      parameters: {},
      recurringWindowId: null,
      recurrence: opts.recurrence,
      seriesGcalEventId: null,
    },
    host: {
      id: hostId,
      email: "host@example.com",
      name: "John",
      preferences: {},
      persistentKnowledge: "",
      upcomingSchedulePreferences: "",
    },
  });
}

beforeEach(() => {
  mockSessionFindUnique.mockReset();
  mockAccountFindFirst.mockReset();
  mockSessionUpdateMany.mockReset();
  mockLinkUpdate.mockReset();
  mockGetOrComputeSchedule.mockReset();
  mockCreateCalendarEvent.mockClear();

  mockGetOrComputeSchedule.mockResolvedValue({
    connected: true,
    slots: [
      {
        start: SLOT_ISO,
        end: new Date(new Date(SLOT_ISO).getTime() + 45 * 60_000).toISOString(),
        score: 1,
      },
    ],
    hostLocation: null,
  });
  mockAccountFindFirst.mockResolvedValue({ scope: "openid cal-w", refresh_token: "r" });
  mockSessionUpdateMany.mockResolvedValue({ count: 1 });
});

describe("confirmBooking — recurring anchor commit", () => {
  it("derives RRULE from the slot pick and embeds the materialized child URL", async () => {
    stubRecurringSession({
      childCode: "u36ggs", // matches the bug-bundle child link
      recurrence: {
        v: "1",
        pattern: "weekly",
        timezone: "America/Los_Angeles",
        anchor: { durationMin: 45 }, // pre-commit shape (composer's emit)
        endBy: { count: 8 },
      },
    });

    const result = await confirmBooking({
      sessionId,
      dateTime: SLOT_ISO,
      duration: 45,
      format: "video",
    });
    expect(result.ok).toBe(true);

    expect(mockCreateCalendarEvent).toHaveBeenCalledTimes(1);
    const callArgs = mockCreateCalendarEvent.mock.calls[0];
    expect(callArgs[0]).toBe(hostId);
    const params = callArgs[1] as Record<string, unknown>;

    // RRULE derivation: weekly + Mon (2026-05-04 PDT was a Monday) + COUNT=8.
    expect(params.recurrence).toEqual(["RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=8"]);

    // Calendar invite must point at the materialized child URL — not the
    // source rule. COMPOSER.md §4.6 invariant.
    const description = String(params.description ?? "");
    expect(description).toContain("/meet/johnanderson/u36ggs");
    expect(description).not.toMatch(/\/meet\/johnanderson\/?\s/);
  });

  it("persists seriesGcalEventId AND committed recurrence on the link row", async () => {
    stubRecurringSession({
      childCode: "u36ggs",
      recurrence: {
        v: "1",
        pattern: "weekly",
        timezone: "America/Los_Angeles",
        anchor: { durationMin: 45 },
        endBy: { count: 8 },
      },
    });

    await confirmBooking({
      sessionId,
      dateTime: SLOT_ISO,
      duration: 45,
      format: "video",
    });

    expect(mockLinkUpdate).toHaveBeenCalled();
    const writes = mockLinkUpdate.mock.calls.map((c) => c[0] as Record<string, unknown>);
    const seriesWrite = writes.find((w) => {
      const data = (w as { data?: Record<string, unknown> }).data;
      return data && "seriesGcalEventId" in data;
    });
    expect(seriesWrite).toBeDefined();
    const data = (seriesWrite as { data: Record<string, unknown> }).data;
    expect(data.seriesGcalEventId).toBe("gcal_evt_recurring_1");
    const rec = data.recurrence as Record<string, unknown>;
    const anchor = rec.anchor as Record<string, unknown>;
    expect(anchor.firstDateLocal).toBe("2026-05-04");
    expect(anchor.timeLocal).toBe("15:00");
  });

  it("non-recurring link writes a single event with no recurrence array", async () => {
    stubRecurringSession({ childCode: "abc123", recurrence: null });

    await confirmBooking({
      sessionId,
      dateTime: SLOT_ISO,
      duration: 45,
      format: "video",
    });

    const params = mockCreateCalendarEvent.mock.calls[0][1] as Record<string, unknown>;
    expect(params.recurrence).toBeUndefined();

    // No series persistence call.
    const seriesWrites = mockLinkUpdate.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .filter((w) => {
        const data = (w as { data?: Record<string, unknown> }).data;
        return data && "seriesGcalEventId" in data;
      });
    expect(seriesWrites).toHaveLength(0);
  });
});
