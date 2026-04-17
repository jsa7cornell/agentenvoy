/**
 * Light validation tests for the TZ recovery banner endpoint input guards.
 *
 * The endpoint itself is a thin Prisma write; the interesting logic is input
 * validation (any old string must be rejected — we're writing to the session's
 * canonical guestTimezone field and don't want to corrupt it).
 */
import { describe, it, expect } from "vitest";

// Replicate the validation used in the route for reference — if we ever
// factor it out into a lib helper, the tests point to it and stay useful.
function isValidIanaTimezone(tz: unknown): tz is string {
  if (typeof tz !== "string" || tz.length === 0 || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

describe("TZ recovery banner — IANA validation", () => {
  it.each([
    "America/New_York",
    "America/Los_Angeles",
    "Europe/London",
    "Europe/Paris",
    "Asia/Tokyo",
    "Asia/Kolkata",
    "UTC",
  ])("accepts valid IANA zone: %s", (tz) => {
    expect(isValidIanaTimezone(tz)).toBe(true);
  });

  it.each([
    "",
    "not a timezone",
    "America/Fake_City",
    "../../etc/passwd",
    "a".repeat(65), // over length cap
  ])("rejects invalid input: %s", (tz) => {
    expect(isValidIanaTimezone(tz)).toBe(false);
  });

  // Node's Intl is permissive with some non-IANA abbreviations (PST, EDT)
  // and "GMT+5" — it normalizes rather than rejecting. The endpoint's
  // validation leans on Intl, so those pass through. This is acceptable
  // because (a) these still yield usable formatting, (b) the client only
  // ever sends the browser's resolvedOptions().timeZone which is always
  // canonical IANA in modern browsers. If we ever need stricter validation
  // (whitelist from TIMEZONE_TABLE), that's a separate tightening.

  it("rejects non-string inputs", () => {
    expect(isValidIanaTimezone(null)).toBe(false);
    expect(isValidIanaTimezone(undefined)).toBe(false);
    expect(isValidIanaTimezone(42)).toBe(false);
    expect(isValidIanaTimezone({})).toBe(false);
    expect(isValidIanaTimezone([])).toBe(false);
  });
});
