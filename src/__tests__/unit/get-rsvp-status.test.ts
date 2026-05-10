/**
 * Tests for getRsvpStatus — single source of truth for GoogleCalendarStatus.
 *
 * Per spec § 6.1 + AP5c pre-commit: this function is the future MCP
 * derivation point. Tests assert pure-function behavior so a future MCP
 * exposure proposal can rely on the same helper without re-deriving.
 */

import { describe, expect, it } from "vitest";
import { getRsvpStatus, type RsvpStatusInput } from "@/lib/gcal/getRsvpStatus";

const baseEventStatus = {
  eventExists: true,
  guestEmail: "sarah@example.com",
  guestOnInvite: true,
  guestResponseStatus: "needsAction" as const,
  allAttendees: [
    { email: "john@host.com", responseStatus: "accepted" as const, self: true },
    { email: "sarah@example.com", responseStatus: "needsAction" as const, self: false },
  ],
  htmlLink: "https://calendar.google.com/event?eid=abc",
};

describe("getRsvpStatus", () => {
  it("returns null when event does not exist", () => {
    const input: RsvpStatusInput = {
      eventStatus: { ...baseEventStatus, eventExists: false, htmlLink: null },
      viewerEmail: "sarah@example.com",
      viewerRole: "guest",
      connectPromptEligible: false,
    };
    expect(getRsvpStatus(input)).toBeNull();
  });

  it("returns null when htmlLink missing", () => {
    const input: RsvpStatusInput = {
      eventStatus: { ...baseEventStatus, htmlLink: null },
      viewerEmail: "sarah@example.com",
      viewerRole: "guest",
      connectPromptEligible: false,
    };
    expect(getRsvpStatus(input)).toBeNull();
  });

  describe("guest viewer", () => {
    it("populates viewerStatus from attendee list, leaves otherPartyStatus undefined", () => {
      const result = getRsvpStatus({
        eventStatus: baseEventStatus,
        viewerEmail: "sarah@example.com",
        viewerRole: "guest",
        connectPromptEligible: false,
      });
      expect(result).toEqual({
        eventUrl: "https://calendar.google.com/event?eid=abc",
        viewerStatus: "needsAction",
        otherPartyStatus: undefined,
        connectPromptEligible: false,
      });
    });

    it("matches viewerEmail case-insensitively", () => {
      const result = getRsvpStatus({
        eventStatus: baseEventStatus,
        viewerEmail: "SARAH@EXAMPLE.COM",
        viewerRole: "guest",
        connectPromptEligible: false,
      });
      expect(result?.viewerStatus).toBe("needsAction");
    });

    it("returns null viewerStatus when viewer not in attendee list", () => {
      const result = getRsvpStatus({
        eventStatus: baseEventStatus,
        viewerEmail: "stranger@example.com",
        viewerRole: "guest",
        connectPromptEligible: true,
      });
      expect(result?.viewerStatus).toBeNull();
      expect(result?.connectPromptEligible).toBe(true);
    });

    it("returns null viewerStatus when viewerEmail is null", () => {
      const result = getRsvpStatus({
        eventStatus: baseEventStatus,
        viewerEmail: null,
        viewerRole: "guest",
        connectPromptEligible: false,
      });
      expect(result?.viewerStatus).toBeNull();
    });

    it("propagates accepted status correctly", () => {
      const result = getRsvpStatus({
        eventStatus: {
          ...baseEventStatus,
          allAttendees: [
            ...baseEventStatus.allAttendees.map((a) =>
              a.email === "sarah@example.com"
                ? { ...a, responseStatus: "accepted" as const }
                : a
            ),
          ],
        },
        viewerEmail: "sarah@example.com",
        viewerRole: "guest",
        connectPromptEligible: false,
      });
      expect(result?.viewerStatus).toBe("accepted");
    });
  });

  describe("host viewer", () => {
    it("populates otherPartyStatus from guestResponseStatus, viewerStatus null", () => {
      const inviteSentAt = new Date("2026-05-08T10:00:00Z");
      const result = getRsvpStatus({
        eventStatus: baseEventStatus,
        viewerEmail: "john@host.com",
        viewerRole: "host",
        inviteSentAt,
        connectPromptEligible: false,
      });
      expect(result).toEqual({
        eventUrl: "https://calendar.google.com/event?eid=abc",
        viewerStatus: null,
        otherPartyStatus: "needsAction",
        inviteSentAt,
        connectPromptEligible: false,
      });
    });

    it("forces connectPromptEligible to false even when input is true (host always has cal)", () => {
      const result = getRsvpStatus({
        eventStatus: baseEventStatus,
        viewerEmail: "john@host.com",
        viewerRole: "host",
        connectPromptEligible: true,
      });
      expect(result?.connectPromptEligible).toBe(false);
    });

    it("returns undefined otherPartyStatus when guest hasn't responded and isn't on invite", () => {
      const result = getRsvpStatus({
        eventStatus: { ...baseEventStatus, guestResponseStatus: null },
        viewerEmail: "john@host.com",
        viewerRole: "host",
        connectPromptEligible: false,
      });
      expect(result?.otherPartyStatus).toBeUndefined();
    });
  });

  describe("AP5c parity readiness", () => {
    it("returns the same eventUrl regardless of viewer role", () => {
      const guestResult = getRsvpStatus({
        eventStatus: baseEventStatus,
        viewerEmail: "sarah@example.com",
        viewerRole: "guest",
        connectPromptEligible: false,
      });
      const hostResult = getRsvpStatus({
        eventStatus: baseEventStatus,
        viewerEmail: "john@host.com",
        viewerRole: "host",
        connectPromptEligible: false,
      });
      expect(guestResult?.eventUrl).toBe(hostResult?.eventUrl);
    });

    it("is a pure function — same input produces same output", () => {
      const input: RsvpStatusInput = {
        eventStatus: baseEventStatus,
        viewerEmail: "sarah@example.com",
        viewerRole: "guest",
        connectPromptEligible: false,
      };
      const a = getRsvpStatus(input);
      const b = getRsvpStatus(input);
      expect(a).toEqual(b);
    });
  });
});
