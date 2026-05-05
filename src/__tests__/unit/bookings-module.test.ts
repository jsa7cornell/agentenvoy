/**
 * Unit tests for the bookings module — booking-phase-discriminator pre-emit check.
 *
 * Per PR4 proposal §4 scenario F: the check must fire (blocking) when
 * book_time_with_commit is emitted without intersect_availability running first.
 */

import { describe, it, expect } from "vitest";
import { bookingPhaseDiscriminator } from "@/agent/modules/bookings/pre-emit-checks/booking-phase-discriminator";
import type { ModuleContext } from "@/agent/modules/types";
import type { BookingsContext } from "@/agent/modules/bookings/context-loader";

const BASE_CONTEXT: BookingsContext = {
  contextLines: ["Host: John (john@example.com)"],
  hostPhone: null,
  hostTimezone: "America/Los_Angeles",
  tzLabel: "PT",
};

const MODULE_CONTEXT: ModuleContext = {
  user: { id: "user-1", name: "John", email: "john@example.com" },
  surface: "dashboard-host",
};

// ---------------------------------------------------------------------------

describe("bookingPhaseDiscriminator", () => {
  it("returns null when no book_time_with_commit action is emitted", async () => {
    const result = await bookingPhaseDiscriminator.check({
      parsedActions: [{ action: "create_link", params: {} }],
      contextOutput: BASE_CONTEXT,
      moduleContext: MODULE_CONTEXT,
    });
    expect(result).toBeNull();
  });

  it("returns null when no toolCallLog is present (lenient — opt-in strictness)", async () => {
    const result = await bookingPhaseDiscriminator.check({
      parsedActions: [{ action: "book_time_with_commit", params: {} }],
      contextOutput: BASE_CONTEXT, // no __toolCallLog
      moduleContext: MODULE_CONTEXT,
    });
    expect(result).toBeNull();
  });

  it("scenario F: fires blocking when book_time_with_commit emitted without intersect_availability", async () => {
    const contextWithLog: BookingsContext & { __toolCallLog: string[] } = {
      ...BASE_CONTEXT,
      __toolCallLog: ["resolve_contact"], // no intersect_availability
    };

    const result = await bookingPhaseDiscriminator.check({
      parsedActions: [{ action: "book_time_with_commit", params: {} }],
      contextOutput: contextWithLog,
      moduleContext: MODULE_CONTEXT,
    });

    expect(result).not.toBeNull();
    expect(result!.flaggedReason).toContain("book_time_with_commit");
    expect(result!.flaggedReason).toContain("intersect_availability");
    expect(result!.hint).toMatch(/resolve_contact/i);
    expect(result!.fallbackProse).toBeDefined();
  });

  it("returns null when both intersect_availability and book_time_with_commit are present", async () => {
    const contextWithLog: BookingsContext & { __toolCallLog: string[] } = {
      ...BASE_CONTEXT,
      __toolCallLog: ["resolve_contact", "intersect_availability"],
    };

    const result = await bookingPhaseDiscriminator.check({
      parsedActions: [{ action: "book_time_with_commit", params: {} }],
      contextOutput: contextWithLog,
      moduleContext: MODULE_CONTEXT,
    });

    expect(result).toBeNull();
  });

  it("has severity: blocking", () => {
    expect(bookingPhaseDiscriminator.severity).toBe("blocking");
  });

  it("has expected name", () => {
    expect(bookingPhaseDiscriminator.name).toBe("booking-phase-discriminator");
  });
});
