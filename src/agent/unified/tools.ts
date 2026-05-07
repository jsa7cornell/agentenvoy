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

  // Curried helper so each tool can pass its own name to the grounding check.
  const exec = (
    toolName: string,
    action: string,
    params: Record<string, unknown>,
    overrideCtx?: Partial<ToolContext>,
  ) => execAction(action, params, { ...toolCtx, ...overrideCtx }, toolName);

  // ---------------------------------------------------------------------------
  // LOAD tools — read-only, no side effects
  // ---------------------------------------------------------------------------

  const LOAD_calendar_context = tool({
    description:
      "Load the host's calendar: upcoming events, busy blocks, available slots. " +
      "Call before answering ANY question about times or scheduling. " +
      "Do NOT call for preference edits, rule changes, or link management.",
    inputSchema: z.object({
      lookaheadDays: z.number().int().min(1).max(60).default(14)
        .describe("Days of calendar data to load (default 14, max 60)."),
    }),
    execute: async ({ lookaheadDays }) =>
      loadCalendar({ lookaheadDays, toolCallId: "", userId: ctx.userId, timezone: ctx.timezone }),
  });

  const LOAD_active_sessions = tool({
    description:
      "Load the host's active (non-archived) negotiation sessions and their links. " +
      "Call before any action that references a session or link by ID/code — archive, " +
      "update_time, update_format, hold_slot, personal_link_update, etc. " +
      "Do NOT fabricate session IDs or link codes; always ground in this tool's output.",
    inputSchema: z.object({}),
    execute: async () => loadActiveSessions(ctx.userId),
  });

  const LOAD_preferences = tool({
    description:
      "Load the host's preferences, availability rules (including bookable links), and knowledge fields. " +
      "Call before editing rules, bookable links, primary link config, or knowledge. " +
      "Returns the full rule list with IDs and bookable link codes — required to avoid fabricating identifiers.",
    inputSchema: z.object({}),
    execute: async () => loadPreferences(ctx.userId),
  });

  // ---------------------------------------------------------------------------
  // Personal links — for one named guest
  // ---------------------------------------------------------------------------

  const personal_link_create = tool({
    description:
      "Create a PERSONAL LINK for one specific named guest. " +
      "Use for: 'grab time with Susan', 'schedule with John', '1:1 with Sarah', 'set up Marcus's onboarding'. " +
      "Do NOT use for shareable templates anyone can book — use bookable_link_create. " +
      "Do NOT use for multi-person events — use group_event_create. " +
      "inviteeName and activity are required.\n\n" +
      "SEEDING: by default the host's Primary link seeds availability/format/duration. " +
      "If the host names a different bookable link ('Office Hours meeting with Susie'), call LOAD_preferences " +
      "to find the link's code, then pass seedFromBookableCode.\n\n" +
      "RECURRENCE: set the recurrence object only if the host described an ongoing 1:1 with this person.\n\n" +
      "ONE-SHOT (autoConfirm): set autoConfirm + inviteeEmail when the host gives an exact date+time AND " +
      "guest email AND no optionality phrasing ('might', 'flexible', 'or'). Handler creates the link AND " +
      "commits the slot to GCal. Do NOT use autoConfirm without both dateTime and inviteeEmail.",
    inputSchema: z.object({
      activity: z.string().describe("Meeting type. E.g. 'intro call', 'coffee', 'coaching'. Required."),
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
      hostNote: z.string().max(280).optional()
        .describe("Host context surfaced to the guest in the greeting (no URLs/emails/phones, max 280 chars)."),
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
        .describe("Fields the guest decides themselves. Only set when host explicitly defers."),
    }),
    execute: async (params) => exec("personal_link_create", "create_link", params),
  });

  const personal_link_update = tool({
    description:
      "Edit an existing personal link. Requires code (the link's short code) OR sessionId. " +
      "Call LOAD_active_sessions first to get the real code. Do NOT fabricate codes. " +
      "availability[] and blockedRanges[] are COMPLETE replacement arrays. " +
      "Only include fields that are actually changing (patch hygiene).",
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
      hostNote: z.string().max(280).nullable().optional(),
      guestPicks: guestPicksFullSchema.optional(),
      recurrence: recurrenceSchema.nullable().optional()
        .describe("Set to update the recurrence pattern; null to clear."),
    }),
    execute: async (params) => exec("personal_link_update", "update_link", params),
  });

  const personal_link_archive = tool({
    description:
      "Archive a personal link — hides it from the host's view. " +
      "Existing bookings remain intact. Reversible via personal_link_unarchive. " +
      "Requires code or sessionId from LOAD_active_sessions.",
    inputSchema: z.object({
      code: z.string().optional().describe("Link short code."),
      sessionId: z.string().optional().describe("Session ID to resolve the link."),
    }),
    execute: async (params) => exec("personal_link_archive", "cancel", params),
  });

  const personal_link_unarchive = tool({
    description:
      "Restore a previously archived personal link. " +
      "Requires code or sessionId.",
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
      "Create a BOOKABLE LINK — a shareable, reusable scheduling template that shows up in " +
      "'My Bookable Links' and any guest can use to self-book. " +
      "Use for: 'music lessons link', 'office hours', 'coaching sessions', 'sales calls', " +
      "any named link the host wants to share with multiple people over time. " +
      "Do NOT use for one-specific-guest scheduling — use personal_link_create. " +
      "Do NOT use for group events — use group_event_create. " +
      "name is required.\n\n" +
      "RECURRENCE: set the recurrence object when the host wants every booking through this link to " +
      "spawn a recurring series (e.g. 'recurring music lessons link'). The parent template carries " +
      "the recurrence intent; child bookings inherit it. Omit recurrence for one-off-per-booking links " +
      "(office hours, sales calls).",
    inputSchema: z.object({
      name: z.string()
        .describe("Display name shown in My Bookable Links. E.g. 'Music Lessons', 'Office Hours'. Per-host unique."),
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
          ...(params.recurrence ? { recurrence: params.recurrence } : {}),
          ...(params.guestPicks ? { guestPicks: params.guestPicks } : {}),
        },
      },
    }),
  });

  const bookable_link_update = tool({
    description:
      "Edit an existing bookable link's settings. " +
      "Requires id (the rule ID) — call LOAD_preferences first to get the real ID. " +
      "Do NOT fabricate IDs. Only include fields that are actually changing.",
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
      "Archive a bookable link — hides it from My Bookable Links and the agent's view. " +
      "Existing bookings remain intact. Reversible via bookable_link_unarchive. " +
      "Requires the rule ID from LOAD_preferences.",
    inputSchema: z.object({
      id: z.string().describe("Exact rule ID from LOAD_preferences output."),
    }),
    execute: async (params) => exec("bookable_link_archive", "update_availability_rule", {
      operation: "archive_bookable",
      id: params.id,
    }),
  });

  const bookable_link_unarchive = tool({
    description:
      "Restore a previously archived bookable link. " +
      "Requires the rule ID from LOAD_preferences.",
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
      "Create a GROUP EVENT for multiple specific guests (renamed from group_coordinate). " +
      "Use whenever the host names two or more guests for a single event: " +
      "'team dinner', 'founders sync', 'interview panel', 'group workshop'. " +
      "Do NOT use for one specific guest — use personal_link_create. " +
      "Do NOT use for shareable templates — use bookable_link_create. " +
      "Required: topic (event title), inviteeNames (all participants), windows (date range descriptions). " +
      "Call ONCE after the host confirms. " +
      "Recurrence and autoConfirm are NOT supported on group events in v1.",
    inputSchema: z.object({
      topic: z.string().describe("Event title or occasion (e.g. 'Founder Dinner')."),
      inviteeNames: z.array(z.string()).min(1).describe("Names or emails of all participants."),
      windows: z.array(z.string()).min(1)
        .describe("Candidate date/time windows as natural language strings (e.g. 'weekday evenings May–July')."),
    }),
    execute: async (params) => exec("group_event_create", "create_link", { ...params, type: "group" }),
  });

  const group_event_update = tool({
    description:
      "Edit an existing group event — change topic, invitees, or candidate windows. " +
      "Requires sessionId from LOAD_active_sessions.",
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
    description:
      "Archive a group event — hides it from the host's view. " +
      "Reversible via group_event_unarchive. Requires sessionId.",
    inputSchema: z.object({
      sessionId: z.string(),
    }),
    execute: async (params) =>
      exec("group_event_archive", "cancel", params, { sessionId: params.sessionId }),
  });

  const group_event_unarchive = tool({
    description:
      "Restore a previously archived group event. Requires sessionId.",
    inputSchema: z.object({
      sessionId: z.string(),
    }),
    execute: async (params) =>
      exec("group_event_unarchive", "unarchive", params, { sessionId: params.sessionId }),
  });

  // ---------------------------------------------------------------------------
  // Primary link
  // ---------------------------------------------------------------------------

  const primary_link_update = tool({
    description:
      "Update the host's Primary link — the default 'meet with me' link at /meet/{slug}. " +
      "Single source of truth for Primary's name, format, duration, availability windows, " +
      "buffer, location, phone, video provider, Zoom link, and guestPicks. " +
      "Pass only the fields that change (patch hygiene). " +
      "Renaming Primary is just `name` on this same tool. " +
      "Call LOAD_preferences first to see current values when changing existing fields.",
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
      "Cancel a negotiation session. Sends a cancellation notice to the guest. " +
      "Requires sessionId — call LOAD_active_sessions first to confirm it. " +
      "Strict: irreversible. Do NOT call without explicit host directive.",
    inputSchema: z.object({
      sessionId: z.string().describe("ID of the session to cancel."),
      reason: z.string().optional().describe("Optional cancellation reason (not surfaced to guest)."),
    }),
    execute: async (params) =>
      exec("session_cancel", "cancel", params, { sessionId: params.sessionId }),
  });

  const session_archive = tool({
    description:
      "Archive a single negotiation session (hides it from the active list). " +
      "Use for concluded or stale sessions. Reversible (use session_unarchive). " +
      "Requires sessionId — call LOAD_active_sessions first.",
    inputSchema: z.object({
      sessionId: z.string().describe("ID of the session to archive."),
    }),
    execute: async (params) =>
      exec("session_archive", "archive", params, { sessionId: params.sessionId }),
  });

  const session_unarchive = tool({
    description:
      "Unarchive a previously archived session, making it active again. " +
      "Requires sessionId.",
    inputSchema: z.object({
      sessionId: z.string().describe("ID of the session to unarchive."),
    }),
    execute: async (params) =>
      exec("session_unarchive", "unarchive", params, { sessionId: params.sessionId }),
  });

  const session_archive_bulk = tool({
    description:
      "Archive multiple sessions at once by filter. " +
      "Valid filters: 'unconfirmed' (active/proposed/escalated), 'expired', 'cancelled', 'all'. " +
      "Strict: affects many records. Only call when the host gives an explicit bulk directive " +
      "(e.g. 'clean up all my old sessions', 'archive everything unconfirmed').",
    inputSchema: z.object({
      filter: z.enum(["unconfirmed", "expired", "cancelled", "all"])
        .describe("Which sessions to archive."),
    }),
    execute: async (params) => exec("session_archive_bulk", "archive_bulk", params),
  });

  const session_update_format = tool({
    description:
      "Change the meeting format for a session (video, phone, in-person). " +
      "Requires sessionId. For confirmed sessions, posts a gcal_update_proposal to the feed.",
    inputSchema: z.object({
      sessionId: z.string(),
      format: z.enum(["video", "phone", "in-person"]).describe("New meeting format."),
    }),
    execute: async (params) =>
      exec("session_update_format", "update_format", params, { sessionId: params.sessionId }),
  });

  const session_update_time = tool({
    description:
      "Change the proposed or confirmed time for a session. " +
      "dateTime MUST include UTC offset (e.g. '2026-05-10T14:00:00-07:00'). " +
      "Never compute timezone offsets — use the value from OFFERABLE SLOTS context. " +
      "Requires sessionId. At least one of dateTime or duration must be provided.",
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
      "Set or update the meeting location for a session. " +
      "For confirmed sessions, posts a gcal_update_proposal to the feed.",
    inputSchema: z.object({
      sessionId: z.string(),
      location: z.string().describe("Location string (address, place name, or video URL)."),
    }),
    execute: async (params) =>
      exec("session_update_location", "update_location", params, { sessionId: params.sessionId }),
  });

  const session_hold_slot = tool({
    description:
      "Create a tentative calendar hold for a proposed time slot in a session. " +
      "Use when the host wants to protect a slot while negotiation is in progress. " +
      "Strict: writes to the host's calendar. Requires sessionId, slotStart, slotEnd.",
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
    description:
      "Release a tentative calendar hold created by session_hold_slot. " +
      "Call when the host confirms, cancels, or wants to free the slot.",
    inputSchema: z.object({
      sessionId: z.string(),
    }),
    execute: async (params) =>
      exec("session_release_hold", "release_hold", params, { sessionId: params.sessionId }),
  });

  const session_lock_duration = tool({
    description:
      "Lock the meeting duration for a specific session (overrides link default). " +
      "Use when the host sets a duration mid-negotiation for one meeting.",
    inputSchema: z.object({
      sessionId: z.string(),
      durationMinutes: z.number().int().positive()
        .describe("Duration in minutes to lock for this session."),
    }),
    execute: async (params) =>
      exec("session_lock_duration", "lock_session_duration", params, { sessionId: params.sessionId }),
  });

  const session_lock_buffer = tool({
    description:
      "Lock the buffer (padding) minutes for a specific session. " +
      "Use when the host sets a buffer for one meeting, not globally.",
    inputSchema: z.object({
      sessionId: z.string(),
      bufferMinutes: z.number().int().min(0)
        .describe("Buffer minutes to add around this session."),
    }),
    execute: async (params) =>
      exec("session_lock_buffer", "lock_buffer_minutes", { sessionId: params.sessionId, bufferMinutes: params.bufferMinutes }, { sessionId: params.sessionId }),
  });

  const session_lock_activity_location = tool({
    description:
      "Lock the activity and/or location for a specific session mid-negotiation. " +
      "Use when host picks where to meet for this one meeting (not globally).",
    inputSchema: z.object({
      sessionId: z.string(),
      activity: z.string().optional().describe("Activity name to lock (e.g. 'coffee')."),
      location: z.string().optional().describe("Location to lock (e.g. 'Blue Bottle on Market')."),
    }),
    execute: async (params) =>
      exec("session_lock_activity_location", "lock_activity_location", params, { sessionId: params.sessionId }),
  });

  const session_save_guest_info = tool({
    description:
      "Save guest contact information (name, email, notes) to a session. " +
      "Call when the host provides guest details mid-negotiation.",
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
      "Add a new availability rule (block, protect, allow, buffer, prefer, limit, location, no_in_person). " +
      "Do NOT use for creating bookable links — use bookable_link_create. " +
      "Call LOAD_preferences first to see existing rules and avoid duplicates.",
    inputSchema: z.object({
      rule: ruleBodySchema.describe("Rule body to add."),
    }),
    execute: async (params) =>
      exec("rule_add", "update_availability_rule", { operation: "add", rule: params.rule }),
  });

  const rule_update = tool({
    description:
      "Update an existing availability rule by its ID. " +
      "Call LOAD_preferences first to get the real rule ID — never fabricate IDs.",
    inputSchema: z.object({
      id: z.string().describe("Exact rule ID from LOAD_preferences output."),
      rule: ruleBodySchema.describe("Fields to update on the rule."),
    }),
    execute: async (params) =>
      exec("rule_update", "update_availability_rule", { operation: "update", id: params.id, rule: params.rule }),
  });

  const rule_remove = tool({
    description:
      "Remove an availability rule permanently. " +
      "Strict: irreversible. Call LOAD_preferences first to confirm the ID exists. " +
      "Do NOT remove without explicit host directive.",
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
    description:
      "Update the host's UI appearance preference: theme mode (light, dark, or auto). " +
      "Use when host says 'switch to dark mode', 'use light theme', 'auto theme', etc.",
    inputSchema: z.object({
      themeMode: z.enum(["light", "dark", "auto"])
        .describe("'auto' computes light/dark from local time."),
    }),
    execute: async (params) => exec("prefs_update_appearance", "update_appearance", params),
  });

  const prefs_update_timezone = tool({
    description:
      "Update the host's timezone. Strict: changes how all times render across the system. " +
      "Use only when host explicitly states they're changing timezone (e.g. 'I moved to Berlin', 'set my timezone to Eastern').",
    inputSchema: z.object({
      timezone: z.string()
        .describe("IANA timezone identifier (e.g. 'America/Los_Angeles', 'Europe/Berlin')."),
    }),
    execute: async (params) => exec("prefs_update_timezone", "update_timezone", params),
  });

  const knowledge_write = tool({
    description:
      "Update the host's persistent knowledge or situational notes used by the scheduling agent. " +
      "persistent = long-lived facts about the host (location, preferences, context). " +
      "situational = short-term schedule notes ('in NYC this week', 'light week'). " +
      "blockedWindows = date/time blocks to avoid (conferences, trips). " +
      "currentLocation = where the host is now (auto-clears after 'until' date).",
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
