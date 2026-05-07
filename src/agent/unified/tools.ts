/**
 * Unified agent tool registry.
 *
 * Tools fall into two groups:
 *   LOAD_*  — read-only context fetchers (no side effects, always safe to call)
 *   write   — write actions wrapping existing actions.ts handlers
 *
 * Factory function pattern: buildUnifiedTools(ctx) injects request-scoped
 * context (userId, timezone) into tool execute closures.
 *
 * Day 1: LOAD_calendar stub wired end-to-end.
 * Day 2: All 22 write tool wrappers.
 */

import { tool } from "ai";
import { z } from "zod";
import { loadCalendar } from "./tool-impls/load-calendar";

export type AgentToolContext = {
  userId: string;
  timezone: string;
};

export function buildUnifiedTools(ctx: AgentToolContext) {
  // -------------------------------------------------------------------------
  // LOAD_calendar
  // -------------------------------------------------------------------------

  const LOAD_calendar = tool({
    description:
      "Load the host's calendar availability and upcoming events. " +
      "Call this first if the user is asking about available times, scheduling, or their calendar. " +
      "Do NOT call for preference edits, rule changes, or other non-calendar tasks.",
    inputSchema: z.object({
      lookaheadDays: z
        .number()
        .int()
        .min(1)
        .max(60)
        .default(14)
        .describe("How many days of calendar data to load (default 14, max 60)."),
    }),
    execute: async ({ lookaheadDays }) => {
      return loadCalendar({
        lookaheadDays,
        toolCallId: "",
        userId: ctx.userId,
        timezone: ctx.timezone,
      });
    },
  });

  return { LOAD_calendar } as const;
}

export type UnifiedTools = ReturnType<typeof buildUnifiedTools>;
export type UnifiedToolName = keyof UnifiedTools;
