/**
 * `bookings` module — `book_with_person` intent on `dashboard-host`.
 *
 * Implements the two-phase bilateral booking flow:
 *   Phase 1: resolve_contact → intersect_availability → present candidates
 *   Phase 2: host picks a slot → book_time_with_commit
 *
 * Per PR4 proposal (book_time_with proposal) + handoff decisions:
 *   Q1=PAIR   — use PairedSlot scoring (yourScore + theirScore separately)
 *   Q2=REFUSAL-WITH-LIST — return `ambiguous` candidates list for disambiguation
 *   Q3=Option A — idempotency key (callerUserId, guestEmail, slot.start, duration)
 *
 * Privacy invariants (non-negotiable):
 *   - mutuallyOpen: false → nothing identifies which side blocks
 *   - theirScore is null when no AE account (freebusy-only path)
 *   - localStart is in caller's tz only; other party's tz never exposed
 *
 * MCP exposure is deferred to PR6.
 */
import type { IntentModule } from "@/agent/modules/types";
import { loadBookingsContext, type BookingsContext } from "./context-loader";
import { bookingPhaseDiscriminator } from "./pre-emit-checks/booking-phase-discriminator";
import { resolveContactTool } from "@/agent/modules/_shared/tools/resolve-contact";
import { intersectAvailabilityTool } from "@/agent/modules/_shared/tools/intersect-availability";
import { bookTimeWithCommit } from "@/agent/modules/_shared/tools/book-time-with-commit";

export const bookingsModule: IntentModule<BookingsContext> = {
  intent: "book_with_person",
  surface: "dashboard-host",
  description:
    "Book a meeting with a specific named person, checking both calendars for " +
    "mutual availability. Two-phase: resolve identity + find slots in Phase 1, " +
    "commit after host confirms in Phase 2.",

  composerPlaybook: [
    "fragments/voice",
    "composers/calendar-event/base",
    "composers/calendar-event/booking",
  ],

  contextLoader: loadBookingsContext,

  composerTools: [
    resolveContactTool,
    intersectAvailabilityTool,
    bookTimeWithCommit,
  ],

  preEmitChecks: [bookingPhaseDiscriminator],

  postStreamGuards: [],          // defaults Layer 2a/2b/F6 auto-injected

  allowedActions: [
    // The bookings flow mints a link + confirms it — no other action types.
    "create_link",
  ],

  responseStyle: "human-prose",

  moduleGuardBucket: "book_with_person",
};
