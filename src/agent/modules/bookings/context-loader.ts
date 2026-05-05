/**
 * Bookings module context loader.
 *
 * For `book_with_person`, the composer runs a two-phase tool-calling flow
 * (resolve_contact → intersect_availability → book_time_with_commit), so the
 * system-prompt context is intentionally minimal compared to the schedule-
 * path loader. We inject:
 *   - Host name + email (for the tools to reference)
 *   - Current time + timezone
 *   - The host's preferred format and phone number (used as defaults in the
 *     intersect_availability intent shape)
 *
 * Channel session management (3-day rolling window) is handled at the route
 * layer — NOT here — matching the schedule-path's separation of concerns.
 */
import { prisma } from "@/lib/prisma";
import { getUserTimezone, shortTimezoneLabel } from "@/lib/timezone";
import { readProfileField } from "@/lib/profile-fields";
import type {
  ModuleContext,
  ModuleContextOutput,
  MatchResult,
} from "@/agent/modules/types";
import type { UserPreferences } from "@/lib/scoring";

export interface BookingsContext extends ModuleContextOutput {
  /** Host's preferred phone number (for phone-format fallback). */
  hostPhone: string | null;
  /** Host's timezone string (e.g., "America/Los_Angeles"). */
  hostTimezone: string | null;
  /** Short timezone label (e.g., "PT") for display. */
  tzLabel: string | null;
}

export async function loadBookingsContext(
  moduleContext: ModuleContext,
  matchResult: MatchResult,
  userMessage: string,
): Promise<BookingsContext> {
  void matchResult;
  void userMessage;
  const userId = moduleContext.user.id;

  // Pull the host's preferences JSON from the User row.
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { preferences: true },
  });

  const prefs = (user?.preferences ?? null) as UserPreferences | null;
  const hostTimezone = getUserTimezone(prefs as Record<string, unknown> | null);
  const tzLabel = hostTimezone ? shortTimezoneLabel(hostTimezone) : null;
  const hostPhone = readProfileField(prefs, "phone") ?? null;

  const now = new Date().toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
    ...(hostTimezone ? { timeZone: hostTimezone } : {}),
  });

  const contextLines: string[] = [
    `Host: ${moduleContext.user.name ?? "unknown"} (${moduleContext.user.email})`,
    `Current time: ${now}`,
    hostPhone ? `Host phone: ${hostPhone}` : "Host phone: not set",
  ];

  return {
    contextLines,
    hostPhone,
    hostTimezone,
    tzLabel,
  };
}
