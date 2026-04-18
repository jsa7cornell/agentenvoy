import { describe, it, expect } from "vitest";
import {
  resolveSeedGuestTimezoneForCreate,
  resolveEffectiveGuestTimezone,
} from "@/lib/guest-timezone-seed";

describe("guest-timezone seed — persist on session create", () => {
  it("declared TZ wins over host-browser-TZ on host-first-visit", () => {
    const result = resolveSeedGuestTimezoneForCreate({
      linkInviteeTimezone: "America/New_York",
      observedBrowserTimezone: "America/Los_Angeles", // host's laptop
      isHost: true,
    });
    expect(result).toBe("America/New_York");
  });

  it("no declaration + host-first-visit persists null (isHost guard)", () => {
    const result = resolveSeedGuestTimezoneForCreate({
      linkInviteeTimezone: null,
      observedBrowserTimezone: "America/Los_Angeles",
      isHost: true,
    });
    expect(result).toBeNull();
  });

  it("declared TZ soft-locks against guest's browser TZ on guest-first-visit", () => {
    // Sarah visits from LAX while traveling; host declared ET. Declared wins
    // at persist time — observed mismatch is deferred to the re-render path.
    const result = resolveSeedGuestTimezoneForCreate({
      linkInviteeTimezone: "America/New_York",
      observedBrowserTimezone: "America/Los_Angeles",
      isHost: false,
    });
    expect(result).toBe("America/New_York");
  });

  it("no declaration + guest-first-visit persists browser TZ (unchanged behavior)", () => {
    const result = resolveSeedGuestTimezoneForCreate({
      linkInviteeTimezone: null,
      observedBrowserTimezone: "America/Los_Angeles",
      isHost: false,
    });
    expect(result).toBe("America/Los_Angeles");
  });

  it("no declaration + missing browser TZ + guest-first-visit returns null", () => {
    const result = resolveSeedGuestTimezoneForCreate({
      linkInviteeTimezone: null,
      observedBrowserTimezone: undefined,
      isHost: false,
    });
    expect(result).toBeNull();
  });

  it("empty-string browser TZ is treated as missing", () => {
    const result = resolveSeedGuestTimezoneForCreate({
      linkInviteeTimezone: null,
      observedBrowserTimezone: "",
      isHost: false,
    });
    expect(result).toBeNull();
  });
});

describe("guest-timezone — effective render priority", () => {
  it("declared TZ wins over session-persisted TZ", () => {
    const result = resolveEffectiveGuestTimezone({
      linkInviteeTimezone: "America/New_York",
      sessionGuestTimezone: "America/Los_Angeles",
      observedBrowserTimezone: "America/Chicago",
    });
    expect(result).toBe("America/New_York");
  });

  it("session-persisted TZ wins over browser TZ when no declaration", () => {
    const result = resolveEffectiveGuestTimezone({
      linkInviteeTimezone: null,
      sessionGuestTimezone: "America/Los_Angeles",
      observedBrowserTimezone: "America/Chicago",
    });
    expect(result).toBe("America/Los_Angeles");
  });

  it("browser TZ is last-resort fallback (host preview, nothing persisted)", () => {
    const result = resolveEffectiveGuestTimezone({
      linkInviteeTimezone: null,
      sessionGuestTimezone: null,
      observedBrowserTimezone: "America/Chicago",
    });
    expect(result).toBe("America/Chicago");
  });

  it("returns undefined when all three inputs are missing", () => {
    const result = resolveEffectiveGuestTimezone({
      linkInviteeTimezone: null,
      sessionGuestTimezone: null,
      observedBrowserTimezone: undefined,
    });
    expect(result).toBeUndefined();
  });
});
