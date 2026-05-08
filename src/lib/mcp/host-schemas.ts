/**
 * Zod schemas for host-side MCP tools.
 *
 * Source of truth for the host surface (`/api/mcp/host`).
 * Mirrors the structure of schemas.ts but scoped to host-authenticated tools.
 * Tool descriptors + required scopes live in HOST_MCP_TOOLS.
 *
 * Shipped:
 *   - PR-3a (create_link)               — 2026-04-30 commit da4c8a4
 *   - PR-2  (get_my_availability,
 *            list_my_sessions)          — 2026-04-30 (this file)
 *   - PR-C  (modify_link,
 *            create_link canvas ext.)   — 2026-05-06
 *
 * Pending: PR-3b (post_to_deal_room, confirm_session) — deferred per
 * John's prioritization 2026-04-30.
 *
 * Parent proposal: 2026-04-29_host-side-mcp-act-as-me_*_decided-2026-04-29.md
 *   §5.3 create_link, §5.4 get_my_availability, §5.5 list_my_sessions
 * PR-C proposal: 2026-05-06_link-config-canonical-model-and-unified-edit.md
 *   §8 (Rule 13 parity — host MCP modify_link + create_link canvas extension)
 */
import { z } from "zod";
import type { HostScope } from "@/app/api/mcp/host/auth";
import {
  availabilitySlotSchema,
  sessionStatusSchema,
} from "@/lib/mcp/schemas";
import { availabilityWindowSchema } from "@/lib/link-parameters";

// ---------------------------------------------------------------------------
// Shared primitives (reused from guest surface where identical)
// ---------------------------------------------------------------------------

const formatSchema = z.enum(["video", "phone", "in-person"]);

const eveningsPostureSchema = z.enum(["protected", "vip_only", "open"]);

// ---------------------------------------------------------------------------
// create_link
// ---------------------------------------------------------------------------

export const createLinkInput = z
  .object({
    topic: z.string().min(1).max(200).optional(),
    inviteeNames: z.array(z.string().min(1).max(200)).max(20).optional(),
    kind: z.enum(["bookable", "personalized"]).optional().default("personalized"),
    format: formatSchema.optional(),
    durationMinutes: z.number().int().min(5).max(480).optional(),
    activity: z.string().min(1).max(80).optional(),
    activityIcon: z.string().max(8).optional(),
    hostNote: z.string().min(1).max(280).optional(),
    timingLabel: z.string().min(1).max(80).optional(),
    location: z.string().min(1).max(300).optional(),
    // PR-C: optional canvas fields — seed the new link's Layer 1 canvas
    // instead of snapshotting from user preferences.
    availability: z.array(availabilityWindowSchema).min(1).optional().describe(
      "Canvas windows. When provided, seeds the link with these windows instead of snapshotting from your Primary. " +
      "Each entry: { days: number[] (0=Sun..6=Sat), startMinutes: number, endMinutes: number }. " +
      "Example: [{ days:[1,2,3,4,5], startMinutes:540, endMinutes:1020 }] = Mon–Fri 9–5."
    ),
    bufferMinutes: z.number().int().min(0).optional().describe(
      "Buffer around meetings in minutes. Allowed values: 0, 5, 15, 30."
    ),
  })
  .strict();

export const createLinkOutput = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      linkCode: z.string(),
      slug: z.string(),
      url: z.string(),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      reason: z.enum(["validation_failed", "calendar_not_connected", "no_slug"]),
      message: z.string(),
    })
    .strict(),
]);

// ---------------------------------------------------------------------------
// modify_link  (PR-C, proposal §8 Rule 13 parity)
// ---------------------------------------------------------------------------
//
// Modifies an existing link by applying a partial posture update. The host
// can update canvas windows, duration, buffer, format, eveningsPosture, or
// topic. All fields are optional — only provided fields are written.
//
// Validation parity: same AvailabilityWindow[] schema as the modal and
// action handlers. Structured errors are emitted in the same shape as
// other host tools (ok: false, reason, message).
//
// Rate limits: inherits the same per-user per-minute rate limit as other
// host tools (enforced at the MCP middleware layer).
export const modifyLinkInput = z
  .object({
    linkId: z.string().min(1).describe("The ID of the link to modify."),
    availability: z.array(availabilityWindowSchema).min(1).optional().describe(
      "New canvas windows for the link. Replaces the entire existing availability. " +
      "Each entry: { days: number[] (0=Sun..6=Sat), startMinutes: number, endMinutes: number }."
    ),
    duration: z.number().int().min(5).max(480).optional().describe(
      "Meeting duration in minutes."
    ),
    bufferMinutes: z.number().int().min(0).optional().describe(
      "Buffer around meetings in minutes. Allowed values: 0, 5, 15, 30."
    ),
    format: formatSchema.optional().describe(
      "Default meeting format: video, phone, or in-person."
    ),
    eveningsPosture: eveningsPostureSchema.optional().describe(
      "Evening slot policy: protected (default), vip_only, or open."
    ),
    topic: z.string().min(1).max(200).optional().describe(
      "Link display name shown in the host's links list."
    ),
  })
  .strict();

export const modifyLinkOutput = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      linkId: z.string(),
      fieldsUpdated: z.array(z.string()),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      reason: z.enum(["validation_failed", "link_not_found", "not_authorized"]),
      message: z.string(),
    })
    .strict(),
]);

// ---------------------------------------------------------------------------
// get_my_availability  (parent §5.4)
// ---------------------------------------------------------------------------
//
// The host's own scored schedule. Differs from guest get_availability:
//   - No `meetingUrl` — the principal is the host directly via PAT.
//   - No link.parameters → no rules-based filters (no guestPicks.window
//     clamp, no link-driven duration filter, no `rules` passthrough).
//     The host's own raw scored schedule + caller's dateRange clip.
//
// Adopts post-stabilization guest improvements (commit a57dc75):
//   - `limit` default 20 (best-first by score, ties broken by earliest)
//   - `localStart` field on each slot (host-TZ-formatted, no offset)
//   - `dateRange` REQUIRED (per John's call 2026-04-30 — host-side
//     calendars span 8+ weeks; an unbounded query would always max out)
export const getMyAvailabilityInput = z
  .object({
    dateRange: z
      .object({
        start: z.iso.date(),
        end: z.iso.date(),
      })
      .strict(),
    timezone: z
      .string()
      .optional()
      .describe(
        "Display timezone for clipping. Defaults to the host's stored timezone."
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .default(20)
      .describe(
        "Max slots returned. Best-first by score; ties broken by earliest start."
      ),
  })
  .strict();

export const getMyAvailabilityOutput = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      timezone: z.string(),
      slots: z.array(availabilitySlotSchema),
      /**
       * The latest date offered, YYYY-MM-DD in host timezone.
       * "Host didn't offer time after this date." Null when no slots returned.
       */
      slotsThrough: z.iso.date().nullable().optional(),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      reason: z.enum(["calendar_not_connected", "validation_failed"]),
      message: z.string(),
    })
    .strict(),
]);

// ---------------------------------------------------------------------------
// list_my_sessions  (parent §5.5)
// ---------------------------------------------------------------------------
//
// Sessions on links the host owns (host-only per John 2026-04-30 — does
// NOT include sessions where this user is a guest on someone else's link).
// `guestEmailHash` is per-link salted (SPEC §4 invariant 4) — this surface
// NEVER returns plaintext guest emails.
export const listMySessionsInput = z
  .object({
    status: z
      .enum(["active", "agreed", "cancelled", "rescheduled", "expired", "all"])
      .optional()
      .default("active"),
    linkCode: z.string().optional(),
    limit: z.number().int().min(1).max(200).optional().default(50),
  })
  .strict();

export const listMySessionsOutput = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      sessions: z.array(
        z
          .object({
            sessionId: z.string(),
            linkCode: z.string(),
            status: sessionStatusSchema,
            guestName: z.string().nullable(),
            // Per-link salted SHA-256. Never plaintext. Same hash function
            // and salt scheme as the email-hash invariant guest-side uses
            // (`src/lib/mcp/email-hash.ts`). Cross-link correlation infeasible.
            guestEmailHash: z.string().nullable(),
            agreedTime: z.iso.datetime().nullable(),
            lastActivityAt: z.iso.datetime(),
            messageCount: z.number().int(),
          })
          .strict()
      ),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      reason: z.enum(["validation_failed"]),
      message: z.string(),
    })
    .strict(),
]);

// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------

export const HOST_MCP_TOOLS = {
  create_link: {
    input: createLinkInput,
    output: createLinkOutput,
    requiredScope: "schedule" as HostScope,
    description:
      "Mint a new scheduling link for the host. Returns a shareable URL the host can send to the person they want to meet. No email required — the URL is the capability. " +
      "If `activity` is one of {run, walk, bike ride, yoga, workout, swim, breakfast, lunch, dinner, drinks, surf, coffee, hike, brainstorm, intro, interview}, " +
      "omitting `durationMinutes` produces a sensible activity-default (e.g., coffee=30, lunch=60, hike=120). " +
      "Otherwise duration falls back to 30. The activity also seeds the link title and the post-confirm event card icon. " +
      "Pass `availability` to seed the link with specific canvas windows; omit to inherit from the host's Primary.",
  },
  modify_link: {
    input: modifyLinkInput,
    output: modifyLinkOutput,
    requiredScope: "schedule" as HostScope,
    description:
      "Modify an existing scheduling link. Accepts a partial update — only fields you provide are changed. " +
      "Can update: canvas availability windows (availability[]), meeting duration, buffer, format, evenings posture, and topic. " +
      "The link must belong to the authenticated host. " +
      "All writes go through the same validation as the dashboard modal — invalid values return a structured error.",
  },
  get_my_availability: {
    input: getMyAvailabilityInput,
    output: getMyAvailabilityOutput,
    requiredScope: "read" as HostScope,
    description:
      "Read the host's own scored, filtered slot list for a given date range. " +
      "Slots are returned best-first (lowest score is best); `preferred: true` marks host favorites. " +
      "Each slot has `start` (UTC) and `localStart` (host's timezone, no offset suffix) — display in `localStart`. " +
      "No link rules apply — this is the host's raw scored calendar.",
  },
  list_my_sessions: {
    input: listMySessionsInput,
    output: listMySessionsOutput,
    requiredScope: "read" as HostScope,
    description:
      "List sessions on links the host owns. Filter by status (default 'active') or specific link code. " +
      "Returns guestName when the guest typed it in the deal-room; guestEmail is per-link salted hash only — never plaintext. " +
      "Sessions are returned most-recently-active first.",
  },
} as const;

export type HostMcpToolName = keyof typeof HOST_MCP_TOOLS;
