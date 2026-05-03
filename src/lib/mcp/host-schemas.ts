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
 *
 * Pending: PR-3b (post_to_deal_room, confirm_session) — deferred per
 * John's prioritization 2026-04-30.
 *
 * Parent proposal: 2026-04-29_host-side-mcp-act-as-me_*_decided-2026-04-29.md
 *   §5.3 create_link, §5.4 get_my_availability, §5.5 list_my_sessions
 */
import { z } from "zod";
import type { HostScope } from "@/app/api/mcp/host/auth";
import {
  availabilitySlotSchema,
  sessionStatusSchema,
} from "@/lib/mcp/schemas";

// ---------------------------------------------------------------------------
// Shared primitives (reused from guest surface where identical)
// ---------------------------------------------------------------------------

const formatSchema = z.enum(["video", "phone", "in-person"]);

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
      "Otherwise duration falls back to 30. The activity also seeds the link title and the post-confirm event card icon.",
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
