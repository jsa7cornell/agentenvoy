/**
 * Zod schemas for host-side MCP tools.
 *
 * Source of truth for the host surface (`/api/mcp/host`).
 * Mirrors the structure of schemas.ts but scoped to host-authenticated tools.
 * Tool descriptors + required scopes live in HOST_MCP_TOOLS.
 *
 * PR-3a scope: `create_link` only.
 * `post_to_deal_room` and `confirm_session` ship in PR-3b.
 *
 * Proposal: 2026-04-29_host-side-mcp-act-as-me_reviewed-2026-04-29_decided-2026-04-29.md §5.3
 */
import { z } from "zod";
import type { HostScope } from "@/app/api/mcp/host/auth";

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
    kind: z.enum(["reusable", "contextual"]).optional().default("contextual"),
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
} as const;

export type HostMcpToolName = keyof typeof HOST_MCP_TOOLS;
