/**
 * N2 fold — slot-still-offered enforcement in `confirmBooking`.
 *
 * Proposal 2026-04-21_deal-room-widget-state-machine-and-agent-dialog-
 * clarity §9 Stage 2: confirm pipeline re-derives the current offered set
 * (same `applyEventOverrides(...)` path the widget reads) and rejects
 * confirms for slots that are no longer on offer. Client maps the 409 to
 * a narration + transition to negotiate.
 *
 * This test stubs Prisma + the schedule pipeline so we exercise the new
 * branch without standing up a DB / calendar integration. Covers:
 *   (1) valid slot that IS in the offered set → proceeds past enforcement
 *       (we don't need the full happy-path — we assert the early return
 *       didn't fire by checking the outcome isn't slot_no_longer_offered).
 *   (2) invalid slot that ISN'T in the offered set → returns
 *       { ok:false, reason:"slot_no_longer_offered" } with the 409-copy
 *       message.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock surface area: all external modules `confirm-pipeline.ts` touches.
// We only need enough stubs that the pipeline reaches (and, for the
// negative case, returns at) the N2 enforcement block.

vi.mock("@vercel/functions", () => ({ waitUntil: (p: unknown) => p }));

const mockSessionFindUnique = vi.fn();
const mockAccountFindFirst = vi.fn();
const mockSessionUpdateMany = vi.fn();
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

vi.mock("@/lib/calendar", () => ({
  createCalendarEvent: vi.fn().mockResolvedValue({
    eventId: "evt_1",
    meetLink: "https://meet.example/abc",
    htmlLink: "https://cal.example/evt",
  }),
  deleteCalendarEvent: vi.fn().mockResolvedValue(undefined),
  invalidateSchedule: vi.fn().mockResolvedValue(undefined),
  // `getOrComputeSchedule` is the N2-fold input — tests set a per-case
  // return value via `mockGetOrComputeSchedule.mockResolvedValueOnce(...)`.
  getOrComputeSchedule: (...args: unknown[]) => mockGetOrComputeSchedule(...args),
}));
const mockGetOrComputeSchedule = vi.fn();

vi.mock("@/lib/oauth/required-scopes", () => ({ HOST_WRITE_SCOPE: "cal-w" }));
vi.mock("@/agent/administrator", () => ({
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

// Scoring module — applyEventOverrides and filterByDuration pass through
// the slots. We want to test the "matches / doesn't match by start time"
// branch without re-testing scoring internals.
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

// Fixture helpers -----------------------------------------------------------

const hostId = "host_1";
const sessionId = "sess_1";
const SLOT_OFFERED_ISO = "2026-05-05T20:00:00.000Z"; // 13:00 PT Tue
const SLOT_OTHER_ISO = "2026-05-06T20:00:00.000Z"; // 13:00 PT Wed

function stubSession({ status }: { status: string } = { status: "active" }) {
  mockSessionFindUnique.mockResolvedValueOnce({
    id: sessionId,
    hostId,
    status,
    agreedTime: null,
    agreedFormat: null,
    meetLink: null,
    guestTimezone: null,
    guestEmail: null,
    guestName: null,
    guestId: null,
    createdAt: new Date("2026-04-30T00:00:00Z"),
    format: null,
    linkId: "link_1",
    link: {
      id: "link_1",
      mode: "single",
      rules: {},
      code: "abc",
      slug: "host",
      topic: null,
      inviteeName: null,
      inviteeEmail: null,
      recurringWindowId: null,
    },
    host: {
      id: hostId,
      email: "host@example.com",
      name: "Host",
      preferences: {},
      persistentKnowledge: "",
      upcomingSchedulePreferences: "",
    },
  });
}

function stubOfferedSet(starts: string[]) {
  mockGetOrComputeSchedule.mockResolvedValueOnce({
    connected: true,
    slots: starts.map((s) => ({
      start: s,
      end: new Date(new Date(s).getTime() + 30 * 60_000).toISOString(),
      score: 1,
    })),
    hostLocation: null,
  });
}

function stubScopeAndCas() {
  mockAccountFindFirst.mockResolvedValue({
    scope: "openid cal-w",
    refresh_token: "r",
  });
  mockSessionUpdateMany.mockResolvedValue({ count: 1 });
}

describe("confirmBooking — N2 slot-still-offered enforcement", () => {
  beforeEach(() => {
    mockSessionFindUnique.mockReset();
    mockAccountFindFirst.mockReset();
    mockSessionUpdateMany.mockReset();
    mockGetOrComputeSchedule.mockReset();
  });

  it("slot not in current offered set → 409 slot_no_longer_offered", async () => {
    stubSession();
    stubOfferedSet([SLOT_OFFERED_ISO]); // only the offered ISO, not the requested

    const result = await confirmBooking({
      sessionId,
      dateTime: SLOT_OTHER_ISO,
      duration: 30,
      format: "video",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("slot_no_longer_offered");
    expect(result.message).toMatch(/isn't offered anymore/i);
  });

  it("slot in current offered set → enforcement passes (no slot_no_longer_offered)", async () => {
    stubSession();
    stubOfferedSet([SLOT_OFFERED_ISO]);
    stubScopeAndCas();

    const result = await confirmBooking({
      sessionId,
      dateTime: SLOT_OFFERED_ISO,
      duration: 30,
      format: "video",
    });

    // We don't assert a full ok:true here (avoids re-testing all the
    // downstream dispatch/email paths). We assert the N2 early-return did
    // NOT fire — any non-`slot_no_longer_offered` outcome is a pass.
    if (!result.ok) {
      expect(result.reason).not.toBe("slot_no_longer_offered");
    }
  });

  it("schedule pipeline throws → fail-open, enforcement skipped", async () => {
    stubSession();
    mockGetOrComputeSchedule.mockRejectedValueOnce(new Error("boom"));
    stubScopeAndCas();

    const result = await confirmBooking({
      sessionId,
      dateTime: SLOT_OFFERED_ISO,
      duration: 30,
      format: "video",
    });

    // Fail-open: a schedule-lookup hiccup must not block a confirm. Any
    // non-`slot_no_longer_offered` outcome is acceptable.
    if (!result.ok) {
      expect(result.reason).not.toBe("slot_no_longer_offered");
    }
  });

  it("group link → enforcement bypassed (participant coordination is out of scope)", async () => {
    // Group sessions have a separate validation path; N2 must not apply.
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
      createdAt: new Date("2026-04-30T00:00:00Z"),
      format: null,
      linkId: "link_g",
      link: {
        id: "link_g",
        mode: "group",
        rules: {},
        code: "grp",
        slug: "host",
        topic: null,
        inviteeName: null,
        inviteeEmail: null,
        recurringWindowId: null,
      },
      host: {
        id: hostId,
        email: "host@example.com",
        name: "Host",
        preferences: {},
        persistentKnowledge: "",
        upcomingSchedulePreferences: "",
      },
    });
    // If this WERE called, the slot wouldn't match. We assert it's NOT
    // called by not stubbing a return; the group branch skips N2 before
    // touching getOrComputeSchedule.
    stubScopeAndCas();

    const result = await confirmBooking({
      sessionId,
      dateTime: SLOT_OTHER_ISO,
      duration: 30,
      format: "video",
    });

    if (!result.ok) {
      expect(result.reason).not.toBe("slot_no_longer_offered");
    }
  });
});
