/**
 * Unified agent tool registry.
 *
 * 34 tools in three groups:
 *   LOAD_*  — read-only context fetchers (no side effects)
 *   write   — action wrappers over existing actions.ts handlers
 *
 * buildUnifiedTools(ctx) injects request-scoped context into execute closures.
 * Each tool's description IS its micro-playbook (Layer 3 data-fidelity).
 * Layer 2 grounding checks run inside execAction via _exec.ts.
 *
 * See agentenvoy/UNIFIEDAGENT.md for the canonical reference.
 */

import { tool } from "ai";
import { z } from "zod";
import { loadCalendar } from "./tool-impls/load-calendar";
import { loadActiveSessions } from "./tool-impls/load-active-sessions";
import { loadPreferences } from "./tool-impls/load-preferences";
import { execAction, type ToolContext } from "./tool-impls/_exec";
import type { ActionResult } from "@/agent/actions";

export type AgentToolContext = {
  userId: string;
  timezone: string;
  meetSlug?: string;
  /** Current user message — forwarded to Layer 2 grounding check. */
  userMessage?: string;
};

// Shared availability window schema — matches AvailabilityWindow[] contract.
const availabilityWindowSchema = z.object({
  days: z.array(z.number().int().min(0).max(6))
    .describe("Day-of-week numbers: 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat"),
  startMinutes: z.number().int().min(0).max(1439)
    .describe("Window open time in minutes since midnight (e.g. 540 = 9 AM)"),
  endMinutes: z.number().int().min(1).max(1440)
    .describe("Window close time in minutes since midnight (e.g. 1020 = 5 PM)"),
});

// Shared blocked-range schema.
const blockedRangeSchema = z.object({
  start: z.string().describe("ISO 8601 datetime for block start"),
  end: z.string().describe("ISO 8601 datetime for block end"),
});

// Shared LinkRecurrence schema (matches src/lib/recurrence.ts LinkRecurrence).
// Used on personal_link_create and bookable_link_create.
const recurrenceSchema = z.object({
  v: z.literal("1"),
  pattern: z.enum(["weekly", "biweekly", "monthly_nth_weekday", "daily"]),
  timezone: z.string().describe("Host's IANA timezone, e.g. 'America/Los_Angeles'."),
  anchor: z.object({
    durationMin: z.number().int().positive(),
    dayOfWeek: z.number().int().min(0).max(6).optional()
      .describe("0=Sun, 6=Sat. Required for weekly, biweekly, monthly_nth_weekday."),
    weekOfMonth: z.number().int().min(1).max(5).optional()
      .describe("1–5 (5=last). Required only for monthly_nth_weekday."),
  }),
  endBy: z.union([
    z.object({ count: z.number().int().positive() }),
    z.object({ until: z.string().describe("ISO UTC date string") }),
  ]).optional().describe("Omit for open-ended series."),
});

// Shared guestPicks schema (full set of fields a personal link supports).
const guestPicksFullSchema = z.object({
  date: z.boolean().optional().describe("Guest chooses the specific date."),
  duration: z.boolean().optional().describe("Guest chooses session length."),
  format: z.boolean().optional().describe("Guest chooses video/phone/in-person."),
  location: z.boolean().optional().describe("Guest chooses meeting location."),
  window: z.string().optional().describe("Time-of-day phrase: 'morning', 'afternoon', 'evening'."),
});

// Bookable links carry a smaller guestPicks today — only format and duration toggles.
const guestPicksBookableSchema = z.object({
  format: z.boolean().optional(),
  duration: z.boolean().optional(),
});

export function buildUnifiedTools(ctx: AgentToolContext) {
  const toolCtx: ToolContext = {
    userId: ctx.userId,
    meetSlug: ctx.meetSlug,
    userMessage: ctx.userMessage,
  };

  // Per-request seen-call set. Guards against the model issuing the same write
  // tool with identical params twice in one turn (observed prod failure shape:
  // duplicate bookable_link_create on a single user request). LOAD_* tools call
  // their own impls directly and bypass this — read-only, dedup not needed.
  const seenCalls = new Set<string>();

  // Curried helper so each tool can pass its own name to the grounding check.
  const exec = async (
    toolName: string,
    action: string,
    params: Record<string, unknown>,
    overrideCtx?: Partial<ToolContext>,
  ): Promise<ActionResult> => {
    const key = `${toolName}:${action}:${JSON.stringify(params)}`;
    if (seenCalls.has(key)) {
      return {
        success: false,
        message:
          `Duplicate call: ${toolName} was already executed this turn with these exact parameters. ` +
          `The prior call's result is the source of truth — do not retry. If you intended a different action, change the parameters.`,
      };
    }
    seenCalls.add(key);
    return execAction(action, params, { ...toolCtx, ...overrideCtx }, toolName);
  };

  // ---------------------------------------------------------------------------
  // LOAD tools — read-only, no side effects
  // ---------------------------------------------------------------------------

  const LOAD_calendar_context = tool({
    description:
      "Load the host's calendar (upcoming events, busy blocks, free slots). " +
      "Call ONLY when answering a calendar/schedule question or moving a session to a specific time. " +
      "DO NOT call when CREATING a link — link creation does not need the calendar; the slot picker checks at booking time. " +
      "DO NOT call when the host says 'next week', 'evenings', 'weekday afternoons' etc. — those are guest-picker windows, not calendar lookups.",
    inputSchema: z.object({
      lookaheadDays: z.number().int().min(1).max(60).default(14)
        .describe("Days of calendar data to load (default 14, max 60)."),
    }),
    execute: async ({ lookaheadDays }) =>
      loadCalendar({ lookaheadDays, toolCallId: "", userId: ctx.userId, timezone: ctx.timezone }),
  });

  const LOAD_active_sessions = tool({
    description:
      "Load active sessions + their links. Call before any session/link write. " +
      "Never fabricate session IDs or link codes; ground in this output.",
    inputSchema: z.object({}),
    execute: async () => loadActiveSessions(ctx.userId),
  });

  const LOAD_preferences = tool({
    description:
      "Load preferences, rules (incl. bookable links with codes/IDs), and knowledge. " +
      "Call before any rule/bookable/primary write. Returns real IDs — never fabricate.",
    inputSchema: z.object({}),
    execute: async () => loadPreferences(ctx.userId),
  });

  // ---------------------------------------------------------------------------
  // Personal links — for one named guest
  // ---------------------------------------------------------------------------

  const personal_link_create = tool({
    description:
      "Personal link for ONE named guest. inviteeName + activity required. " +
      "Seeds from Primary by default; pass seedFromBookableCode for named bookable seed. " +
      "Set recurrence for ongoing 1:1. Set autoConfirm + inviteeEmail only with exact date+time and no optionality.",
    inputSchema: z.object({
      activity: z.string().describe("Meeting type. E.g. 'intro call', 'coffee', 'coaching'. Required."),
      activityIcon: z.string().max(8).optional()
        .describe("Single emoji for the activity (☕ coffee, 🥾 hike, 🎵 music lessons, 🍽️ dinner, etc.). Omit if no clear match."),
      inviteeName: z.string().describe("Guest's name. Required for personal links."),
      duration: z.number().int().positive().optional()
        .describe("Override duration in minutes. Inherits from seed link if omitted."),
      format: z.enum(["video", "phone", "in-person"]).optional()
        .describe("Override format. Inherits from seed link if omitted."),
      location: z.string().nullable().optional()
        .describe("Physical address or video URL. Required for in-person when host knows it."),
      availability: z.array(availabilityWindowSchema).optional()
        .describe("Override booking windows. Inherits from seed link if omitted."),
      inviteeEmail: z.string().email().optional()
        .describe("Guest's email address. REQUIRED for autoConfirm."),
      inviteeTimezone: z.string().optional()
        .describe("Guest's IANA timezone if host mentioned it (e.g. 'America/New_York')."),
      seedFromBookableCode: z.string().optional()
        .describe("Code of a bookable link to use as the canvas seed (host named it explicitly). Omit to use Primary."),
      recurrence: recurrenceSchema.optional()
        .describe("Set for ongoing 1:1 series with this guest (weekly, biweekly, etc.)."),
      autoConfirm: z.object({
        dateTime: z.string().describe("ISO 8601 datetime with timezone (e.g. '2026-05-10T14:00:00-07:00')."),
        durationMin: z.number().int().positive().optional()
          .describe("Duration in minutes. Inherits from seed if omitted."),
      }).optional()
        .describe("One-shot: pre-commit the slot. Requires inviteeEmail. Handler creates the link AND writes a GCal event."),
      guestPicks: guestPicksFullSchema.optional()
        .describe("Fields the guest decides themselves. Set when host explicitly defers: 'he picks the spot' → location:true, 'her call on duration' → duration:true, 'whatever format works' → format:true, 'she picks the day' → date:true. Never infer deferral — only set when the host said it."),
    }),
    execute: async (params) => {
      // The legacy create_link handler builds the meeting title from `topic`, not
      // `activity`. The unified personal_link_create schema only exposes `activity`,
      // so mirror it onto `topic` here when topic isn't separately provided.
      // Without this, "coffee with Susan" produces a title like "Susan + John" with
      // no activity prefix, and the card emoji-from-title fallback can't fire.
      const enriched = (params.activity && !(params as { topic?: unknown }).topic)
        ? { ...params, topic: params.activity }
        : params;
      return exec("personal_link_create", "create_link", enriched);
    },
  });

  const personal_link_update = tool({
    description:
      "Edit a personal link. Requires code or sessionId from LOAD_active_sessions. " +
      "availability[] and blockedRanges[] are full replacements. Only pass changing fields.",
    inputSchema: z.object({
      code: z.string().optional().describe("Link short code (preferred identifier)."),
      sessionId: z.string().optional().describe("Session ID to resolve the link (alternative to code)."),
      activity: z.string().optional(),
      duration: z.number().int().positive().optional(),
      format: z.enum(["video", "phone", "in-person"]).optional(),
      location: z.string().nullable().optional(),
      availability: z.array(availabilityWindowSchema).optional()
        .describe("Complete replacement availability windows."),
      blockedRanges: z.array(blockedRangeSchema).optional()
        .describe("Complete replacement blocked date ranges."),
      inviteeName: z.string().nullable().optional(),
      inviteeEmail: z.string().email().nullable().optional(),
      inviteeTimezone: z.string().nullable().optional(),
      guestPicks: guestPicksFullSchema.optional(),
      recurrence: recurrenceSchema.nullable().optional()
        .describe("Set to update the recurrence pattern; null to clear."),
    }),
    execute: async (params) => exec("personal_link_update", "update_link", params),
  });

  const personal_link_archive = tool({
    description:
      "Archive a personal link. Reversible via personal_link_unarchive. Requires code or sessionId.",
    inputSchema: z.object({
      code: z.string().optional().describe("Link short code."),
      sessionId: z.string().optional().describe("Session ID to resolve the link."),
    }),
    execute: async (params) => exec("personal_link_archive", "cancel", params),
  });

  const personal_link_unarchive = tool({
    description: "Restore an archived personal link. Requires code or sessionId.",
    inputSchema: z.object({
      code: z.string().optional().describe("Link short code."),
      sessionId: z.string().optional().describe("Session ID to resolve the link."),
    }),
    execute: async (params) => exec("personal_link_unarchive", "unarchive", params),
  });

  // ---------------------------------------------------------------------------
  // Bookable links — shareable templates
  // ---------------------------------------------------------------------------

  const bookable_link_create = tool({
    description:
      "Bookable link — shareable template anyone can self-book. Shows in 'My Bookable Links'. " +
      "Use for: 'music lessons link', 'office hours', 'sales calls'. name required. " +
      "Set recurrence when each booking should spawn a series (parent template; children inherit).",
    inputSchema: z.object({
      name: z.string()
        .describe("Display name shown in My Bookable Links. E.g. 'Music Lessons', 'Office Hours'. Per-host unique."),
      activity: z.string().optional()
        .describe("Canonical activity word ('music lessons', 'coffee', 'office hours'). Drives icon/format defaults. Often the same as name; omit if name already captures it."),
      activityIcon: z.string().max(8).optional()
        .describe("Single emoji for the link (🎵 music lessons, ☕ coffee, 🕐 office hours, 🎤 interview, etc.)."),
      format: z.enum(["video", "phone", "in-person"])
        .describe("Meeting format for every booking through this link."),
      durationMinutes: z.number().int().positive()
        .describe("Session length in minutes for every booking."),
      daysOfWeek: z.array(z.number().int().min(0).max(6)).optional()
        .describe("Days when bookings are offerable (0=Sun…6=Sat). E.g. M/T → [1,2]."),
      timeStart: z.string().optional()
        .describe("Start of the offering window in 'HH:MM' 24h. E.g. '15:00' for 3 PM."),
      timeEnd: z.string().optional()
        .describe("End of the offering window in 'HH:MM' 24h. E.g. '17:00' for 5 PM."),
      recurrence: recurrenceSchema.optional()
        .describe(
          "Set when bookings through this link should spawn a recurring series " +
          "(music lessons, weekly coaching). Omit for one-off-per-booking links.",
        ),
      guestPicks: guestPicksBookableSchema.optional()
        .describe("Whether guests can change format or duration when booking."),
    }),
    execute: async (params) => exec("bookable_link_create", "update_availability_rule", {
      operation: "add",
      rule: {
        label: params.name,
        originalText: params.name,
        action: "bookable",
        type: "recurring",
        priority: 3,
        ...(params.daysOfWeek ? { daysOfWeek: params.daysOfWeek } : {}),
        ...(params.timeStart ? { timeStart: params.timeStart } : {}),
        ...(params.timeEnd ? { timeEnd: params.timeEnd } : {}),
        bookable: {
          name: params.name,
          title: params.name,
          format: params.format,
          durationMinutes: params.durationMinutes,
          ...(params.activityIcon ? { activityIcon: params.activityIcon } : {}),
          ...(params.recurrence ? { recurrence: params.recurrence } : {}),
          ...(params.guestPicks ? { guestPicks: params.guestPicks } : {}),
        },
      },
    }),
  });

  const bookable_link_update = tool({
    description:
      "Edit a bookable link. Requires rule id from LOAD_preferences. Only pass changing fields.",
    inputSchema: z.object({
      id: z.string().describe("Exact rule ID from LOAD_preferences output."),
      name: z.string().optional().describe("Rename the bookable link."),
      format: z.enum(["video", "phone", "in-person"]).optional(),
      durationMinutes: z.number().int().positive().optional(),
      daysOfWeek: z.array(z.number().int().min(0).max(6)).optional(),
      timeStart: z.string().optional(),
      timeEnd: z.string().optional(),
      recurrence: recurrenceSchema.nullable().optional()
        .describe("Set to add/change recurrence; null to remove."),
      guestPicks: guestPicksBookableSchema.optional(),
    }),
    execute: async (params) => {
      const ruleUpdate: Record<string, unknown> = {};
      if (params.daysOfWeek !== undefined) ruleUpdate.daysOfWeek = params.daysOfWeek;
      if (params.timeStart !== undefined) ruleUpdate.timeStart = params.timeStart;
      if (params.timeEnd !== undefined) ruleUpdate.timeEnd = params.timeEnd;
      const bookableUpdate: Record<string, unknown> = {};
      if (params.name !== undefined) {
        bookableUpdate.name = params.name;
        bookableUpdate.title = params.name;
        ruleUpdate.label = params.name;
      }
      if (params.format !== undefined) bookableUpdate.format = params.format;
      if (params.durationMinutes !== undefined) bookableUpdate.durationMinutes = params.durationMinutes;
      if (params.recurrence !== undefined) bookableUpdate.recurrence = params.recurrence;
      if (params.guestPicks !== undefined) bookableUpdate.guestPicks = params.guestPicks;
      if (Object.keys(bookableUpdate).length > 0) ruleUpdate.bookable = bookableUpdate;
      return exec("bookable_link_update", "update_availability_rule", {
        operation: "update",
        id: params.id,
        rule: ruleUpdate,
      });
    },
  });

  const bookable_link_archive = tool({
    description:
      "Archive a bookable link. Reversible via bookable_link_unarchive. Requires rule id from LOAD_preferences.",
    inputSchema: z.object({
      id: z.string().describe("Exact rule ID from LOAD_preferences output."),
    }),
    execute: async (params) => exec("bookable_link_archive", "update_availability_rule", {
      operation: "archive_bookable",
      id: params.id,
    }),
  });

  const bookable_link_unarchive = tool({
    description: "Restore an archived bookable link. Requires rule id from LOAD_preferences.",
    inputSchema: z.object({
      id: z.string().describe("Exact rule ID from LOAD_preferences output."),
    }),
    execute: async (params) => exec("bookable_link_unarchive", "update_availability_rule", {
      operation: "unarchive_bookable",
      id: params.id,
    }),
  });

  // ---------------------------------------------------------------------------
  // Group events — multiple specific guests
  // ---------------------------------------------------------------------------

  const group_event_create = tool({
    description:
      "Create a group coordination link — one shared URL where each participant shares their own availability. Invitee names are optional: the host may name specific people OR just say 'create a group event' and share the link themselves. Participants self-identify when they open the link. " +
      "Use when: host names 2+ individuals (e.g. 'Bob, Sue, and Jane'), says 'group dinner/sync/event', says 'I'll share the link and people can RSVP', or uses phrasing like 'team sync', 'panel', 'everyone picks a time'. " +
      "DO NOT use for a 1:1 meeting with one person — use personal_link_create. " +
      "DO NOT use for a meeting with ONE COMPANY/ORG (e.g. 'get time w/ Acme', 'Sequoia VC call', 'Honest Game intro') — that's personal_link_create with inviteeName=the company. A company name is ONE entity, not a group. Don't fabricate 'the team' out of an org name. " +
      "Infer format from event type: dinner/meal/social/gathering → 'in-person'; VC/call/sync/meeting → 'video'; phone → 'phone'. Pass format even when not explicitly stated if the event type makes it obvious. " +
      "Infer durationMinutes from event type: dinner ≈ 120, lunch/coffee ≈ 90, casual coffee ≈ 60, sync/call ≈ 30–45. Pass duration even when not explicitly stated if the event type makes it obvious.",
    inputSchema: z.object({
      topic: z.string().describe("Event title or occasion (e.g. 'Founder Dinner')."),
      activity: z.string().optional()
        .describe("Canonical activity word ('dinner', 'sync', 'workshop'). Drives icon/format defaults. Often inferable from topic."),
      activityIcon: z.string().max(8).optional()
        .describe("Single emoji for the event (🍽️ dinner, 🍻 drinks, 👋 meet-and-greet, 🎤 panel, etc.)."),
      inviteeNames: z.array(z.string()).optional()
        .describe("Names or emails of participants, if the host mentioned them."),
      windows: z.array(z.string()).optional()
        .describe("Candidate windows as natural language (e.g. 'weekday evenings May–July'). Omit if not mentioned."),
      durationMinutes: z.number().int().positive().optional()
        .describe("Meeting duration in minutes if host specified (e.g. 45, 60, 120)."),
      format: z.enum(["video", "phone", "in-person"]).optional()
        .describe("Meeting format if host specified. 'VC' / 'video call' → 'video'."),
    }),
    execute: async (params) => {
      // create_link handler reads `duration` (not durationMinutes) on group links;
      // map here so the host's "45 mins" actually persists.
      const { durationMinutes, ...rest } = params;
      return exec("group_event_create", "create_link", {
        ...rest,
        type: "group",
        ...(durationMinutes !== undefined ? { duration: durationMinutes } : {}),
      });
    },
  });

  const group_event_update = tool({
    description: "Edit a group event (topic / invitees / windows). Requires sessionId.",
    inputSchema: z.object({
      sessionId: z.string(),
      topic: z.string().optional(),
      inviteeNames: z.array(z.string()).optional(),
      windows: z.array(z.string()).optional(),
    }),
    execute: async (params) =>
      exec("group_event_update", "update_link", params, { sessionId: params.sessionId }),
  });

  const group_event_archive = tool({
    description: "Archive a group event. Reversible via group_event_unarchive. Requires sessionId.",
    inputSchema: z.object({
      sessionId: z.string(),
    }),
    execute: async (params) =>
      exec("group_event_archive", "cancel", params, { sessionId: params.sessionId }),
  });

  const group_event_unarchive = tool({
    description: "Restore an archived group event. Requires sessionId.",
    inputSchema: z.object({
      sessionId: z.string(),
    }),
    execute: async (params) =>
      exec("group_event_unarchive", "unarchive", params, { sessionId: params.sessionId }),
  });

  const group_event_set_candidate_dates = tool({
    description:
      "Store the host-confirmed list of candidate dates for a group event. " +
      "Call this AFTER the host confirms (or edits) the ranked date list you proposed. " +
      "These dates seed the event page grid — each participant sees them as rows and marks which work. " +
      "Requires the NegotiationSession.id (sessionId) for the group event — get it from LOAD_active_sessions.",
    inputSchema: z.object({
      sessionId: z.string().describe("NegotiationSession.id of the group event."),
      candidateDays: z.array(z.string()).min(1)
        .describe("ISO date strings (YYYY-MM-DD) the host confirmed, in chronological order."),
    }),
    execute: async ({ sessionId, candidateDays }) => {
      const { prisma } = await import("@/lib/prisma");
      const gc = await prisma.groupCoordination.findUnique({
        where: { sessionId },
        select: { id: true },
      });
      if (!gc) return { success: false, message: "GroupCoordination row not found for this session." };
      await prisma.groupCoordination.update({
        where: { sessionId },
        data: { candidateDays },
      });
      return { success: true, candidateDays };
    },
  });

  // ---------------------------------------------------------------------------
  // Primary link
  // ---------------------------------------------------------------------------

  const primary_link_update = tool({
    description:
      "Update the Primary link. Single source for name, format, duration, availability, " +
      "buffer, location, phone, videoProvider, zoomLink, guestPicks. Pass only changing fields.",
    inputSchema: z.object({
      name: z.string().optional().describe("Rename the Primary link (was 'Primary link' by default)."),
      format: z.enum(["video", "phone", "in-person"]).optional(),
      duration: z.number().int().positive().optional()
        .describe("Default meeting duration in minutes (15, 30, 45, 60, 90)."),
      availability: z.array(availabilityWindowSchema).optional()
        .describe("Replace the host's offering windows entirely."),
      buffer: z.union([
        z.literal(0), z.literal(5), z.literal(10), z.literal(15), z.literal(30),
      ]).optional().describe("Buffer minutes between meetings."),
      location: z.string().nullable().optional()
        .describe("Default location (physical or video URL)."),
      phone: z.string().optional().describe("Host phone number for phone meetings."),
      videoProvider: z.enum(["google-meet", "zoom"]).optional(),
      zoomLink: z.string().optional().describe("Zoom personal link URL."),
      guestPicks: guestPicksBookableSchema.optional()
        .describe("Whether guests can change format or duration on Primary."),
    }),
    execute: async (params) => exec("primary_link_update", "update_primary_link", params),
  });

  // ---------------------------------------------------------------------------
  // Sessions
  // ---------------------------------------------------------------------------

  const session_cancel = tool({
    description:
      "Cancel a session and notify the guest. Strict: irreversible. " +
      "Requires sessionId from LOAD_active_sessions. Only with explicit host directive.",
    inputSchema: z.object({
      sessionId: z.string().describe("ID of the session to cancel."),
      reason: z.string().optional().describe("Optional cancellation reason (not surfaced to guest)."),
    }),
    execute: async (params) =>
      exec("session_cancel", "cancel", params, { sessionId: params.sessionId }),
  });

  const session_archive = tool({
    description: "Archive a session (reversible via session_unarchive). Requires sessionId.",
    inputSchema: z.object({
      sessionId: z.string().describe("ID of the session to archive."),
    }),
    execute: async (params) =>
      exec("session_archive", "archive", params, { sessionId: params.sessionId }),
  });

  const session_unarchive = tool({
    description: "Restore an archived session. Requires sessionId.",
    inputSchema: z.object({
      sessionId: z.string().describe("ID of the session to unarchive."),
    }),
    execute: async (params) =>
      exec("session_unarchive", "unarchive", params, { sessionId: params.sessionId }),
  });

  const session_archive_bulk = tool({
    description:
      "Archive sessions in bulk by filter (unconfirmed/expired/cancelled/all). " +
      "Strict: only with explicit bulk directive ('clean up all', 'archive everything').",
    inputSchema: z.object({
      filter: z.enum(["unconfirmed", "expired", "cancelled", "all"])
        .describe("Which sessions to archive."),
    }),
    execute: async (params) => exec("session_archive_bulk", "archive_bulk", params),
  });

  const session_update_format = tool({
    description:
      "Change a session's format (video/phone/in-person). Requires sessionId. " +
      "Confirmed sessions get a gcal_update_proposal posted to the feed.",
    inputSchema: z.object({
      sessionId: z.string(),
      format: z.enum(["video", "phone", "in-person"]).describe("New meeting format."),
    }),
    execute: async (params) =>
      exec("session_update_format", "update_format", params, { sessionId: params.sessionId }),
  });

  const session_update_time = tool({
    description:
      "Change a session's time/duration. dateTime MUST include UTC offset. " +
      "Use OFFERABLE SLOTS values; don't compute offsets. Requires sessionId + dateTime or duration.",
    inputSchema: z.object({
      sessionId: z.string(),
      dateTime: z.string().optional()
        .describe("ISO 8601 datetime with UTC offset."),
      duration: z.number().int().positive().optional()
        .describe("Duration in minutes."),
      timezone: z.string().optional()
        .describe("IANA timezone string (e.g. 'America/Los_Angeles')."),
    }),
    execute: async (params) =>
      exec("session_update_time", "update_time", params, { sessionId: params.sessionId }),
  });

  const session_update_location = tool({
    description:
      "Set/update a session's location. Confirmed sessions get a gcal_update_proposal.",
    inputSchema: z.object({
      sessionId: z.string(),
      location: z.string().describe("Location string (address, place name, or video URL)."),
    }),
    execute: async (params) =>
      exec("session_update_location", "update_location", params, { sessionId: params.sessionId }),
  });

  const session_hold_slot = tool({
    description:
      "Tentative calendar hold for a session slot. Strict: writes to host's calendar. " +
      "Requires sessionId, slotStart, slotEnd.",
    inputSchema: z.object({
      sessionId: z.string(),
      slotStart: z.string().describe("ISO 8601 datetime for hold start."),
      slotEnd: z.string().describe("ISO 8601 datetime for hold end."),
      ttlHours: z.number().positive().optional()
        .describe("Hold expiry in hours (default 24)."),
    }),
    execute: async (params) =>
      exec("session_hold_slot", "hold_slot", params, { sessionId: params.sessionId }),
  });

  const session_release_hold = tool({
    description: "Release a calendar hold created by session_hold_slot.",
    inputSchema: z.object({
      sessionId: z.string(),
    }),
    execute: async (params) =>
      exec("session_release_hold", "release_hold", params, { sessionId: params.sessionId }),
  });

  const session_lock_duration = tool({
    description: "Lock a session's duration (overrides link default).",
    inputSchema: z.object({
      sessionId: z.string(),
      durationMinutes: z.number().int().positive()
        .describe("Duration in minutes to lock for this session."),
    }),
    execute: async (params) =>
      exec("session_lock_duration", "lock_session_duration", params, { sessionId: params.sessionId }),
  });

  const session_lock_buffer = tool({
    description: "Lock buffer minutes on a session (per-meeting, not global).",
    inputSchema: z.object({
      sessionId: z.string(),
      bufferMinutes: z.number().int().min(0)
        .describe("Buffer minutes to add around this session."),
    }),
    execute: async (params) =>
      exec("session_lock_buffer", "lock_buffer_minutes", { sessionId: params.sessionId, bufferMinutes: params.bufferMinutes }, { sessionId: params.sessionId }),
  });

  const session_lock_activity_location = tool({
    description: "Lock activity/location on a session (per-meeting, not global).",
    inputSchema: z.object({
      sessionId: z.string(),
      activity: z.string().optional().describe("Activity name to lock (e.g. 'coffee')."),
      location: z.string().optional().describe("Location to lock (e.g. 'Blue Bottle on Market')."),
    }),
    execute: async (params) =>
      exec("session_lock_activity_location", "lock_activity_location", params, { sessionId: params.sessionId }),
  });

  const session_save_guest_info = tool({
    description: "Save guest name/email/notes onto a session.",
    inputSchema: z.object({
      sessionId: z.string(),
      guestName: z.string().optional(),
      guestEmail: z.string().email().optional(),
      notes: z.string().optional(),
    }),
    execute: async (params) =>
      exec("session_save_guest_info", "save_guest_info", params, { sessionId: params.sessionId }),
  });

  // ---------------------------------------------------------------------------
  // Availability rules — block / allow / buffer / etc. (NOT bookable links)
  // ---------------------------------------------------------------------------

  const ruleBodySchema = z.object({
    label: z.string().optional().describe("Short human-readable label."),
    originalText: z.string().optional().describe("The host's phrasing verbatim."),
    description: z.string().optional(),
    action: z.enum([
      "block", "protect", "allow", "buffer", "prefer", "limit", "location", "no_in_person",
    ]).optional().describe(
      "block=score 5 hard; protect=score 3 soft (VIP can override); allow=ignore conflicts; " +
      "buffer=padding; prefer=upweight; limit=cap; location=set venue; no_in_person=disable in-person.",
    ),
    type: z.enum(["ongoing", "recurring", "temporary", "one-time"]).optional()
      .describe("ongoing=always; recurring=specific days; temporary=date range; one-time=single date."),
    daysOfWeek: z.array(z.number().int().min(0).max(6)).optional()
      .describe("Days the rule applies (0=Sun … 6=Sat)."),
    timeStart: z.string().optional().describe("HH:MM 24h."),
    timeEnd: z.string().optional().describe("HH:MM 24h."),
    allDay: z.boolean().optional(),
    effectiveDate: z.string().optional().describe("YYYY-MM-DD for temporary/one-time rules."),
    expiryDate: z.string().optional().describe("YYYY-MM-DD for temporary rules."),
    bufferMinutesBefore: z.number().int().min(0).optional(),
    bufferMinutesAfter: z.number().int().min(0).optional(),
    bufferAppliesTo: z.string().optional(),
    locationLabel: z.string().optional()
      .describe("For action='location' — the venue label (e.g. 'Baja', 'NYC')."),
    priority: z.number().int().min(1).max(5).optional()
      .describe("Rule precedence on conflict (1=lowest, 5=highest). Default 3. NOT strictness — that's set by `action`."),
  });

  const rule_add = tool({
    description:
      "Add an availability rule (block/protect/allow/buffer/prefer/limit/location/no_in_person). " +
      "NOT for bookable links — use bookable_link_create. Load preferences first to avoid duplicates.",
    inputSchema: z.object({
      rule: ruleBodySchema.describe("Rule body to add."),
    }),
    execute: async (params) =>
      exec("rule_add", "update_availability_rule", { operation: "add", rule: params.rule }),
  });

  const rule_update = tool({
    description: "Update a rule by ID. Load preferences first; never fabricate IDs.",
    inputSchema: z.object({
      id: z.string().describe("Exact rule ID from LOAD_preferences output."),
      rule: ruleBodySchema.describe("Fields to update on the rule."),
    }),
    execute: async (params) =>
      exec("rule_update", "update_availability_rule", { operation: "update", id: params.id, rule: params.rule }),
  });

  const rule_remove = tool({
    description: "Remove a rule. Strict: irreversible. Requires id; explicit host directive.",
    inputSchema: z.object({
      id: z.string().describe("Exact rule ID from LOAD_preferences output."),
    }),
    execute: async (params) =>
      exec("rule_remove", "update_availability_rule", { operation: "remove", id: params.id }),
  });

  // ---------------------------------------------------------------------------
  // Preferences (slim — only what's genuinely preference-scoped)
  // ---------------------------------------------------------------------------

  const prefs_update_appearance = tool({
    description: "Update theme mode (light/dark/auto).",
    inputSchema: z.object({
      themeMode: z.enum(["light", "dark", "auto"])
        .describe("'auto' computes light/dark from local time."),
    }),
    execute: async (params) => exec("prefs_update_appearance", "update_appearance", params),
  });

  const prefs_update_timezone = tool({
    description:
      "Update IANA timezone. Strict: affects how all times render. " +
      "Only with explicit host directive ('moved to Berlin', 'set my timezone to Eastern').",
    inputSchema: z.object({
      timezone: z.string()
        .describe("IANA timezone identifier (e.g. 'America/Los_Angeles', 'Europe/Berlin')."),
    }),
    execute: async (params) => exec("prefs_update_timezone", "update_timezone", params),
  });

  const knowledge_write = tool({
    description:
      "Save host knowledge. persistent=long-term facts; situational=short-term notes; " +
      "blockedWindows=date/time blocks; currentLocation=where host is now.",
    inputSchema: z.object({
      persistent: z.string().optional()
        .describe("Persistent background knowledge about the host."),
      situational: z.string().optional()
        .describe("Short-term schedule preferences or notes."),
      blockedWindows: z.array(z.object({
        start: z.string(),
        end: z.string(),
        days: z.array(z.string()).optional(),
        label: z.string().optional(),
        expires: z.string().optional(),
      })).optional(),
      currentLocation: z.object({
        label: z.string(),
        until: z.string().optional().describe("ISO date after which location clears."),
      }).nullable().optional(),
    }),
    execute: async (params) => exec("knowledge_write", "update_knowledge", params),
  });

  return {
    // LOAD tools
    LOAD_calendar_context,
    LOAD_active_sessions,
    LOAD_preferences,
    // Personal links
    personal_link_create,
    personal_link_update,
    personal_link_archive,
    personal_link_unarchive,
    // Bookable links
    bookable_link_create,
    bookable_link_update,
    bookable_link_archive,
    bookable_link_unarchive,
    // Group events
    group_event_create,
    group_event_update,
    group_event_archive,
    group_event_unarchive,
    group_event_set_candidate_dates,
    // Primary link
    primary_link_update,
    // Sessions
    session_cancel,
    session_archive,
    session_unarchive,
    session_archive_bulk,
    session_update_format,
    session_update_time,
    session_update_location,
    session_hold_slot,
    session_release_hold,
    session_lock_duration,
    session_lock_buffer,
    session_lock_activity_location,
    session_save_guest_info,
    // Rules
    rule_add,
    rule_update,
    rule_remove,
    // Preferences
    prefs_update_appearance,
    prefs_update_timezone,
    knowledge_write,
  } as const;
}

export type UnifiedTools = ReturnType<typeof buildUnifiedTools>;
export type UnifiedToolName = keyof UnifiedTools;
