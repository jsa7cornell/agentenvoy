/**
 * `get_matched_availability` — internal tool exposed to the deal-room guest
 * composer (Sonnet) so chat answers about times can ground in the canonical
 * bilateral payload instead of inferring from generic context.
 *
 * Background: 2026-04-29 bilateral+picker bundle, PR-A2. Closes the R2 drift
 * class on the chat surface — Sonnet asks the data layer "what times work
 * for both?" and renders the answer instead of guessing.
 *
 * Privacy posture (load-bearing — Cut 2 from the bundle):
 *   This tool ALWAYS passes `includeConflicts: false` to
 *   `computeBilateralForSession`. The guest's event titles never enter the
 *   tool result. Sonnet's reply lands on the deal-room thread, which is
 *   visible to BOTH host and guest (verified at
 *   `negotiate/message/route.ts:100–101`); naming the guest's conflict in
 *   chat is a cross-party leak the privacy contract bars. The picker's
 *   Detailed tab (PR-B2) renders titles on the guest's own device only.
 *
 * Surface scope:
 *   Registered for the GUEST composer path only. The host composer doesn't
 *   need it — hosts already see their own scoring widget; bilateral compute
 *   from the host POV would be the guest's calendar, which the host is not
 *   entitled to read titles from. Greeting prose path
 *   (`generateAgentResponse` / `negotiate/session/route.ts:808`) is also
 *   out of scope per `proposals/2026-04-29_bilateral-and-picker-unified-execution-plan_decided-2026-04-29.md` §7.
 */

import { tool } from "ai";
import { z } from "zod";
import {
  computeBilateralForSession,
  type BilateralPayload,
} from "@/lib/bilateral-availability";

/**
 * Schema for the LLM-supplied tool input. Keep the surface small — the
 * canonical compute is per-session, so we only expose the optional
 * date-range filter for "what about next week?"-style questions.
 */
const inputSchema = z.object({
  dateRange: z
    .object({
      start: z
        .string()
        .describe("ISO date (YYYY-MM-DD) for the start of the window."),
      end: z
        .string()
        .describe("ISO date (YYYY-MM-DD) for the end of the window."),
    })
    .optional()
    .describe(
      "Optional window. Defaults to the next 14 days from today. Useful when the guest asks about a specific date or week.",
    ),
});

export type GetMatchedAvailabilityInput = z.infer<typeof inputSchema>;

const TOOL_DESCRIPTION = `Look up the host's availability that ALSO works for the guest's connected calendar. Use this BEFORE answering ANY availability question (date/time/window queries). Returns a structured rollup of mutual times and tight windows by day.

When to call:
- Guest asks "what about Tuesday?" / "anything next week?" / "is there room Thursday afternoon?"
- Guest pushes back on a time and asks for alternatives
- Before proposing a time you haven't already grounded in this tool's output

When NOT to call:
- Guest agrees with a time you already proposed ("yes that works")
- Format/location-only turns ("video please", "let's do coffee")
- Acknowledgment turns ("got it", "sure")

The tool returns:
- byDay[].matched — times that work for BOTH calendars (offer these)
- byDay[].looseMutual — times the host prefers but the guest's calendar shows friction. Disclose openly: "{hostFirstName}'s free Tuesday at 1pm — your calendar shows you're busy then. Want to book it anyway, or pick a different time?"
- byDay[].hasHostHours — true iff the host has any working hours that day. Use to render "outside {hostFirstName}'s working hours" without naming which side is busy.
- hostFirstName — what to call the host in chat.

If the tool returns { available: false }, the guest hasn't connected a calendar yet. DO NOT surface this to the guest — fall through to the OFFERABLE SLOTS list and answer about the host's availability as you would if no tool existed.`;

/**
 * Build a tool registry entry for `get_matched_availability` with the given
 * sessionId baked into the execute closure. The agent runner doesn't have
 * access to the session at tool-construction time, so callers
 * (`negotiate/message/route.ts`) construct the registry per-request.
 */
export function buildGetMatchedAvailabilityTool(sessionId: string) {
  return tool({
    description: TOOL_DESCRIPTION,
    inputSchema,
    execute: async (input: GetMatchedAvailabilityInput): Promise<BilateralPayload> => {
      // CUT 2 PRIVACY GATE — never flip this to true on the Sonnet path.
      // The picker's render layer (PR-B2) reads the same compute path with
      // `includeConflicts: true` directly from `computeBilateralForSession`;
      // it is the only caller permitted to surface guest event titles.
      return computeBilateralForSession(sessionId, {
        dateRange: input.dateRange,
        includeConflicts: false,
      });
    },
  });
}
