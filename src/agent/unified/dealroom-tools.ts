/**
 * Deal-room-specific unified-agent tools (Phase A.3).
 *
 * Three new tools that don't exist on the host-channel surface:
 *
 *   - `session_set_status` — flip session status + label. Replaces the
 *     legacy `[STATUS_UPDATE]` text-parsed block from
 *     `negotiate/message/route.ts:31-39, 532-541`. Preserves the
 *     SPEC §2.3.1 invariant (clears `agreedTime`/`agreedFormat` on every
 *     transition since this path never enters `agreed` state).
 *
 *   - `session_confirm_slot` — guest-side commit a slot. Calls
 *     `confirm-pipeline.confirmBooking` (the same function the
 *     `/api/negotiate/confirm` route POST handler uses). Strict grounding
 *     (irreversible: writes GCal event, sends invite).
 *
 *   - `session_request_reschedule` — reset a confirmed meeting back to
 *     active negotiation. Calls `lib/session-state.requestSessionReschedule`
 *     which mirrors the `/api/negotiate/reschedule` route logic exactly.
 *
 * Plus a role-aware tool subset builder — `buildDealroomTools(role, ctx)`
 * — that returns the appropriate tools for `"dealroom-host"` vs.
 * `"dealroom-guest"` per proposal §2.6 (event-scoped surface; account-pref
 * tools excluded).
 *
 * Phase A.3 of the deal-room migration. Wired into the runner by A.4.
 * Phase A.6 flips the route flag to route deal-room traffic through this
 * surface.
 *
 * Refs: proposals/2026-05-11_complete-unified-agent-migration-and-retire-classifier-composer_reviewed-2026-05-11_decided-2026-05-11.md §2.6 + §3.2
 */

import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { confirmBooking } from "@/lib/confirm-pipeline";
import {
  setSessionStatus,
  requestSessionReschedule,
  SESSION_SET_STATUS_VALUES,
} from "@/lib/session-state";

export type DealroomToolContext = {
  /** The session this deal-room turn is bound to. */
  sessionId: string;
  /** Host's user id — used for billing + invalidation. */
  hostId: string;
  /** Speaker role for this turn, used to label reschedule + audit metadata. */
  role: "dealroom-host" | "dealroom-guest";
};

/**
 * Build the three deal-room-specific tool wrappers. Each tool's `execute`
 * closure captures the request-scoped `DealroomToolContext` so the model
 * doesn't need to pass `sessionId` redundantly (it's pinned to the thread).
 *
 * The tool description IS its micro-playbook per the UA's Layer 3 discipline
 * — written for the model, not for humans-reading-code.
 */
export function buildDealroomTools(ctx: DealroomToolContext): ToolSet {
  const session_set_status = tool({
    description:
      "Flip the session's status. Replaces the legacy [STATUS_UPDATE] block. " +
      "Valid statuses: " + SESSION_SET_STATUS_VALUES.join(" | ") + ". " +
      "Do NOT use on a read-only/status-question turn — that's an unnecessary write. " +
      "When status flips, agreedTime + agreedFormat are cleared automatically (SPEC §2.3.1).",
    inputSchema: z.object({
      status: z.enum(SESSION_SET_STATUS_VALUES),
      label: z.string().max(60).optional()
        .describe("Short human-readable note shown on the deal-room card. Max 60 chars."),
    }),
    execute: async (params) => {
      const result = await setSessionStatus({
        sessionId: ctx.sessionId,
        status: params.status,
        label: params.label,
      });
      if (!result.success) {
        return { success: false, message: `Failed to set status: ${result.reason}` };
      }
      return {
        success: true,
        message: `Status set to "${result.status}"${result.statusLabel ? ` — "${result.statusLabel}"` : ""}.`,
        data: { sessionId: ctx.sessionId, status: result.status, statusLabel: result.statusLabel },
      };
    },
  });

  const session_confirm_slot = tool({
    description:
      "Commit the agreed slot. STRICT: writes the GCal event, sends the invite, transitions session to 'agreed'. " +
      "Use ONLY when the guest has clearly agreed to a specific time (e.g. 'yes that works', 'book it', 'sounds good' AFTER you offered a specific slot). " +
      "If email is unknown, call session_save_guest_info first on the same turn. " +
      "dateTime MUST be ISO 8601 — copy from the OFFERABLE SLOTS list with the UTC offset.",
    inputSchema: z.object({
      dateTime: z.string()
        .describe("ISO 8601 datetime with UTC offset, e.g. '2026-05-13T14:00:00-07:00'."),
      duration: z.number().int().positive().optional()
        .describe("Minutes. Defaults to the link's default duration."),
      format: z.enum(["video", "phone", "in-person"]).optional(),
      location: z.string().nullable().optional(),
      guestEmail: z.string().email().optional()
        .describe("Use if the guest provided their email this turn AND it wasn't already saved."),
      guestName: z.string().optional(),
      guestNote: z.string().nullable().optional(),
      wantsReminder: z.boolean().optional(),
    }),
    execute: async (params) => {
      const result = await confirmBooking({
        sessionId: ctx.sessionId,
        dateTime: params.dateTime,
        duration: params.duration,
        format: params.format,
        location: params.location,
        guestEmail: params.guestEmail ?? null,
        guestName: params.guestName ?? null,
        guestNote: params.guestNote ?? null,
        wantsReminder: params.wantsReminder,
        userAgent: null, // tool path; not an HTTP caller
      });
      if (!result.ok) {
        return {
          success: false,
          message: `Confirm failed: ${result.reason ?? "unknown"}`,
          data: { reason: result.reason, sessionId: ctx.sessionId },
        };
      }
      return {
        success: true,
        message: `Booked — ${params.dateTime}.`,
        data: {
          sessionId: ctx.sessionId,
          dateTime: params.dateTime,
          ...(result.warnings && result.warnings.length > 0 ? { warnings: result.warnings } : {}),
        },
      };
    },
  });

  const session_request_reschedule = tool({
    description:
      "Reset a confirmed meeting back to active negotiation. Use when the speaker says 'reschedule', 'move it', or similar on a session in 'agreed' state. " +
      "STRICT: deletes the GCal event (notifying attendees), releases holds, clears the slot. Irreversible without a new confirm. " +
      "Only valid on confirmed (agreed) sessions; will fail with 'not_in_agreed_state' otherwise.",
    inputSchema: z.object({
      reason: z.string().optional()
        .describe("Optional reason for the reschedule, surfaced in the system message."),
    }),
    execute: async () => {
      const result = await requestSessionReschedule({
        sessionId: ctx.sessionId,
        initiator: ctx.role === "dealroom-host" ? "host" : "guest",
      });
      if (!result.success) {
        return {
          success: false,
          message: `Reschedule failed: ${result.reason}`,
          data: { reason: result.reason, sessionId: ctx.sessionId },
        };
      }
      return {
        success: true,
        message: "Reschedule requested. Previous slot released; session reopened.",
        data: {
          sessionId: ctx.sessionId,
          calendarEventCleared: result.calendarEventCleared,
        },
      };
    },
  });

  return {
    session_set_status,
    session_confirm_slot,
    session_request_reschedule,
  };
}

/**
 * Tool-name allowlists per role. The runner enforces these — any tool the
 * model calls that isn't in the role's allowlist is rejected before execute.
 *
 * Per proposal §2.6 (deal-room is event-scoped, NOT account-scoped):
 *
 *   - account-pref tools (`primary_link_update`, `prefs_*`, `knowledge_write`,
 *     `bookable_link_*`, `rule_*`, `group_event_*`) are EXCLUDED from both
 *     deal-room roles. The unified prompt's host-side §"Account-preference
 *     deflection" rule tells the model to redirect to the dashboard chat
 *     instead.
 *
 *   - host-side gets `personal_link_update` scoped to this session's link
 *     only (the runner enforces by overriding `linkCode` in the tool call).
 *
 *   - guest-side does NOT get `personal_link_update` — guests don't edit the
 *     host's link. Per the 2026-04-29 bilateral execution plan §B2,
 *     `get_matched_availability` is GUEST-ONLY.
 */
export const DEALROOM_HOST_ALLOWED_TOOLS = [
  // LOAD reads
  "LOAD_calendar_context",
  "LOAD_active_sessions",
  "LOAD_preferences",
  // Session-scoped writes
  "session_update_time",
  "session_update_format",
  "session_update_location",
  "session_cancel",
  "session_set_archived",
  "session_hold_slot",
  "session_release_hold",
  "session_save_guest_info",
  "session_lock_duration",
  "session_lock_buffer",
  "session_lock_activity_location",
  // Personal-link edits scoped to this session's link
  "personal_link_update",
  // Deal-room new tools
  "session_set_status",
  "session_request_reschedule",
] as const;

export const DEALROOM_GUEST_ALLOWED_TOOLS = [
  // LOAD reads
  "LOAD_calendar_context",
  "LOAD_preferences",
  // Bilateral availability (2026-04-29 §B2 — guest-only)
  "get_matched_availability",
  // Group coordination tools (when session is a group event — out of scope
  // for v1 deal-room migration but listed for forward-compat)
  "record_availability",
  "propose_convergence",
  "collect_suggestion",
  // Deal-room new tools
  "session_set_status",
  "session_confirm_slot",
  "session_request_reschedule",
  // Guest can save their own info before confirming
  "session_save_guest_info",
  // Guest can move (re-time) the meeting too, per 2026-05-12 capability
  // clarification. Constrained to OFFERABLE SLOTS in the prompt — the model
  // only emits dateTime values from the offered list (vs. host who can
  // override their own hours).
  "session_update_time",
] as const;

export type DealroomRole = "dealroom-host" | "dealroom-guest";

export function allowedToolsForRole(role: DealroomRole): readonly string[] {
  return role === "dealroom-host"
    ? DEALROOM_HOST_ALLOWED_TOOLS
    : DEALROOM_GUEST_ALLOWED_TOOLS;
}
