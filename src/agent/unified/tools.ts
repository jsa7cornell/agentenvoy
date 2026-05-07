/**
 * Unified agent tool registry — Day 2.
 *
 * 22 tools in two groups:
 *   LOAD_*  — read-only context fetchers (no side effects)
 *   write   — action wrappers over existing actions.ts handlers
 *
 * buildUnifiedTools(ctx) injects request-scoped context into execute closures.
 * Each tool's description IS its micro-playbook: when to use, when NOT to use,
 * anti-fabrication notes. (Layer 3 of the data-fidelity framework.)
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

export function buildUnifiedTools(ctx: AgentToolContext) {
  const toolCtx: ToolContext = {
    userId: ctx.userId,
    meetSlug: ctx.meetSlug,
  };

  // ---------------------------------------------------------------------------
  // LOAD tools — read-only, no side effects
  // ---------------------------------------------------------------------------

  const LOAD_calendar = tool({
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
      "Load the host's active (non-archived) negotiation sessions. " +
      "Call before any action that references a session — cancel, archive, update_time, " +
      "update_format, update_location, hold_slot, etc. — so you can confirm the session " +
      "exists and resolve its ID. " +
      "Do NOT fabricate sessionIds; always ground in this tool's output.",
    inputSchema: z.object({}),
    execute: async () => loadActiveSessions(ctx.userId),
  });

  const LOAD_preferences = tool({
    description:
      "Load the host's preferences, availability rules, and knowledge fields. " +
      "Call before editing rules (rule_add, rule_update, rule_remove), " +
      "meeting settings (prefs_update), or knowledge (knowledge_write). " +
      "Returns the full rule list with IDs — required to avoid fabricating rule IDs.",
    inputSchema: z.object({}),
    execute: async () => loadPreferences(ctx.userId),
  });

  // ---------------------------------------------------------------------------
  // Write tools — session actions
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
      execAction("cancel", params, { ...toolCtx, sessionId: params.sessionId }),
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
      execAction("archive", params, { ...toolCtx, sessionId: params.sessionId }),
  });

  const session_unarchive = tool({
    description:
      "Unarchive a previously archived session, making it active again. " +
      "Requires sessionId.",
    inputSchema: z.object({
      sessionId: z.string().describe("ID of the session to unarchive."),
    }),
    execute: async (params) =>
      execAction("unarchive", params, { ...toolCtx, sessionId: params.sessionId }),
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
    execute: async (params) => execAction("archive_bulk", params, toolCtx),
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
      execAction("update_format", params, { ...toolCtx, sessionId: params.sessionId }),
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
      execAction("update_time", params, { ...toolCtx, sessionId: params.sessionId }),
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
      execAction("update_location", params, { ...toolCtx, sessionId: params.sessionId }),
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
      execAction("hold_slot", params, { ...toolCtx, sessionId: params.sessionId }),
  });

  const session_release_hold = tool({
    description:
      "Release a tentative calendar hold created by session_hold_slot. " +
      "Call when the host confirms, cancels, or wants to free the slot.",
    inputSchema: z.object({
      sessionId: z.string(),
    }),
    execute: async (params) =>
      execAction("release_hold", params, { ...toolCtx, sessionId: params.sessionId }),
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
      execAction("lock_session_duration", params, { ...toolCtx, sessionId: params.sessionId }),
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
      execAction("lock_buffer_minutes", { sessionId: params.sessionId, bufferMinutes: params.bufferMinutes }, { ...toolCtx, sessionId: params.sessionId }),
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
      execAction("lock_activity_location", params, { ...toolCtx, sessionId: params.sessionId }),
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
      execAction("save_guest_info", params, { ...toolCtx, sessionId: params.sessionId }),
  });

  // ---------------------------------------------------------------------------
  // Write tools — link actions
  // ---------------------------------------------------------------------------

  const link_create = tool({
    description:
      "Create a new bookable scheduling link. " +
      "Call when the host explicitly asks to create a new link or meeting type. " +
      "Do NOT call for edits to an existing link — use link_update instead. " +
      "activity is required (e.g. 'coffee', 'intro call', 'bike ride').",
    inputSchema: z.object({
      activity: z.string().describe("Meeting activity or type (required)."),
      duration: z.number().int().positive().optional()
        .describe("Default duration in minutes."),
      format: z.enum(["video", "phone", "in-person"]).optional(),
      location: z.string().nullable().optional(),
      availability: z.array(availabilityWindowSchema).optional()
        .describe("Time-of-day windows when this link is bookable. Replaces defaults entirely."),
      inviteeName: z.string().optional()
        .describe("Guest name if this link is for a specific person."),
      guestPicks: z.object({
        date: z.boolean().optional(),
        duration: z.boolean().optional(),
        format: z.boolean().optional(),
        location: z.boolean().optional(),
      }).optional().describe("Fields the guest can choose themselves."),
    }),
    execute: async (params) => execAction("create_link", params, toolCtx),
  });

  const link_update = tool({
    description:
      "Edit an existing bookable link's settings. " +
      "Requires code (the link's short code) OR sessionId to identify which link. " +
      "Call LOAD_active_sessions or LOAD_preferences first to get the real code. " +
      "Do NOT fabricate link codes. " +
      "availability[] is a COMPLETE replacement array — always pass all windows, not just changed ones. " +
      "blockedRanges[] is also a complete replacement. " +
      "Only include fields that are actually changing (patch hygiene).",
    inputSchema: z.object({
      code: z.string().optional()
        .describe("Link short code (preferred identifier)."),
      sessionId: z.string().optional()
        .describe("Session ID to resolve the link (alternative to code)."),
      activity: z.string().optional(),
      duration: z.number().int().positive().optional(),
      format: z.enum(["video", "phone", "in-person"]).optional(),
      location: z.string().nullable().optional(),
      availability: z.array(availabilityWindowSchema).optional()
        .describe("Complete replacement availability windows."),
      blockedRanges: z.array(blockedRangeSchema).optional()
        .describe("Complete replacement blocked date ranges."),
      inviteeName: z.string().nullable().optional(),
      guestPicks: z.object({
        date: z.boolean().optional(),
        duration: z.boolean().optional(),
        format: z.boolean().optional(),
        location: z.boolean().optional(),
      }).optional(),
    }),
    execute: async (params) => execAction("update_link", params, toolCtx),
  });

  const link_cancel = tool({
    description:
      "Cancel (deactivate) a bookable link so new sessions can no longer be booked. " +
      "Strict: affects all future bookings. Only call with explicit host directive. " +
      "Requires code or sessionId.",
    inputSchema: z.object({
      code: z.string().optional().describe("Link short code."),
      sessionId: z.string().optional().describe("Session ID to resolve the link."),
      reason: z.string().optional(),
    }),
    execute: async (params) => execAction("cancel", params, toolCtx),
  });

  // ---------------------------------------------------------------------------
  // Write tools — rules
  // ---------------------------------------------------------------------------

  const rule_add = tool({
    description:
      "Add a new availability rule (e.g. 'no meetings on Wednesdays', 'mornings only for calls'). " +
      "Call LOAD_preferences first to see existing rules before adding. " +
      "Do NOT add a rule that duplicates an existing one — update instead.",
    inputSchema: z.object({
      rule: z.object({
        label: z.string().describe("Short human-readable label."),
        description: z.string().optional(),
        availability: z.array(availabilityWindowSchema).optional(),
        blockedDays: z.array(z.number().int().min(0).max(6)).optional()
          .describe("Days to block entirely (0=Sun … 6=Sat)."),
      }).describe("Rule body to add."),
    }),
    execute: async (params) =>
      execAction("update_availability_rule", { operation: "add", rule: params.rule }, toolCtx),
  });

  const rule_update = tool({
    description:
      "Update an existing availability rule by its ID. " +
      "Call LOAD_preferences first to get the real rule ID — never fabricate IDs.",
    inputSchema: z.object({
      id: z.string().describe("Exact rule ID from LOAD_preferences output."),
      rule: z.object({
        label: z.string().optional(),
        description: z.string().optional(),
        availability: z.array(availabilityWindowSchema).optional(),
        blockedDays: z.array(z.number().int().min(0).max(6)).optional(),
      }).describe("Fields to update on the rule."),
    }),
    execute: async (params) =>
      execAction("update_availability_rule", { operation: "update", id: params.id, rule: params.rule }, toolCtx),
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
      execAction("update_availability_rule", { operation: "remove", id: params.id }, toolCtx),
  });

  const primary_rename = tool({
    description:
      "Rename the host's primary scheduling link (the general-purpose 'meet with me' link). " +
      "Use when the host says 'call my main link X' or 'rename my primary link'.",
    inputSchema: z.object({
      name: z.string().describe("New name for the primary link."),
    }),
    execute: async (params) =>
      execAction("update_availability_rule", { operation: "rename_primary", rule: { label: params.name } }, toolCtx),
  });

  // ---------------------------------------------------------------------------
  // Write tools — preferences and knowledge
  // ---------------------------------------------------------------------------

  const prefs_update = tool({
    description:
      "Update the host's global meeting preferences: phone number, video provider, " +
      "Zoom link, or default duration. These apply to ALL future invites. " +
      "Call LOAD_preferences first to see current values before changing.",
    inputSchema: z.object({
      phone: z.string().optional().describe("Host phone number for phone meetings."),
      videoProvider: z.enum(["google-meet", "zoom"]).optional(),
      zoomLink: z.string().optional().describe("Zoom personal link URL."),
      defaultDuration: z.number().int().positive().optional()
        .describe("Default meeting duration in minutes."),
    }),
    execute: async (params) => execAction("update_meeting_settings", params, toolCtx),
  });

  const prefs_update_business_hours = tool({
    description:
      "Update the host's global business hours (earliest start, latest end, buffer between meetings). " +
      "start/end are hours (0-23/1-24). buffer must be 0, 5, 10, 15, or 30 minutes.",
    inputSchema: z.object({
      start: z.number().int().min(0).max(23).optional()
        .describe("Earliest hour to schedule meetings (0-23)."),
      end: z.number().int().min(1).max(24).optional()
        .describe("Latest hour to schedule meetings (1-24)."),
      buffer: z.union([
        z.literal(0), z.literal(5), z.literal(10), z.literal(15), z.literal(30),
      ]).optional().describe("Buffer minutes between meetings."),
    }),
    execute: async (params) => execAction("update_business_hours", params, toolCtx),
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
    execute: async (params) => execAction("update_knowledge", params, toolCtx),
  });

  return {
    // LOAD tools
    LOAD_calendar,
    LOAD_active_sessions,
    LOAD_preferences,
    // Session actions
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
    // Link actions
    link_create,
    link_update,
    link_cancel,
    // Rules
    rule_add,
    rule_update,
    rule_remove,
    primary_rename,
    // Preferences and knowledge
    prefs_update,
    prefs_update_business_hours,
    knowledge_write,
  } as const;
}

export type UnifiedTools = ReturnType<typeof buildUnifiedTools>;
export type UnifiedToolName = keyof UnifiedTools;
