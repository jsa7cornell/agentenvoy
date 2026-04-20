/**
 * Schema parse tests for the 2026-04-20 preference-signal additions:
 *   - `availabilitySlotSchema.preferred?: boolean`
 *   - `getMeetingParametersOutput.rules.isVip?: boolean`
 *   - `getMeetingParametersOutput.rules.timingPreference?: { anchor: … }`
 *   - `getMeetingParametersOutput.rules.guestPicksWindow?: { startHour, endHour }`
 *
 * All four are optional — backward-compat check: pre-change payloads
 * (without the new fields) still parse clean.
 */
import { describe, it, expect } from "vitest";
import {
  availabilitySlotSchema,
  getMeetingParametersOutput,
} from "@/lib/mcp/schemas";

const baseSlot = {
  start: "2026-04-21T10:00:00.000Z",
  end: "2026-04-21T10:30:00.000Z",
  score: 0,
};

describe("availabilitySlotSchema.preferred", () => {
  it("accepts slot without preferred (backward-compat)", () => {
    expect(availabilitySlotSchema.parse(baseSlot)).toEqual(baseSlot);
  });

  it("accepts preferred: true", () => {
    const parsed = availabilitySlotSchema.parse({
      ...baseSlot,
      score: -1,
      preferred: true,
    });
    expect(parsed.preferred).toBe(true);
  });

  it("accepts preferred: false", () => {
    const parsed = availabilitySlotSchema.parse({ ...baseSlot, preferred: false });
    expect(parsed.preferred).toBe(false);
  });

  it("rejects non-boolean preferred (strict)", () => {
    expect(() =>
      availabilitySlotSchema.parse({ ...baseSlot, preferred: "yes" }),
    ).toThrow();
  });
});

const baseParametersResponse = {
  ok: true as const,
  meetingUrl: "/meet/johnanderson",
  parameters: {
    format: {
      value: null,
      origin: "unset" as const,
      mutability: "open" as const,
      guestMustResolve: false,
    },
    duration: {
      value: 30,
      origin: "host-profile-default" as const,
      mutability: "host-filled" as const,
      guestMustResolve: false,
    },
    location: {
      value: null,
      origin: "unset" as const,
      mutability: "host-filled" as const,
      guestMustResolve: false,
    },
    timezone: {
      value: "America/Los_Angeles",
      origin: "host-profile-default" as const,
      mutability: "locked" as const,
      guestMustResolve: false,
    },
    guestMustResolve: [],
  },
};

describe("getMeetingParametersOutput.rules — new optional echoes", () => {
  it("parses empty rules (backward-compat)", () => {
    const payload = { ...baseParametersResponse, rules: {} };
    expect(() => getMeetingParametersOutput.parse(payload)).not.toThrow();
  });

  it("accepts isVip: true", () => {
    const payload = {
      ...baseParametersResponse,
      rules: { isVip: true },
    };
    const parsed = getMeetingParametersOutput.parse(payload);
    if (parsed.ok) expect(parsed.rules.isVip).toBe(true);
  });

  it("accepts timingPreference with anchor this-week", () => {
    const payload = {
      ...baseParametersResponse,
      rules: { timingLabel: "this week", timingPreference: { anchor: "this-week" } },
    };
    expect(() => getMeetingParametersOutput.parse(payload)).not.toThrow();
  });

  it("accepts timingPreference with anchor null", () => {
    const payload = {
      ...baseParametersResponse,
      rules: { timingLabel: "flexible", timingPreference: { anchor: null } },
    };
    expect(() => getMeetingParametersOutput.parse(payload)).not.toThrow();
  });

  it("rejects timingPreference with invalid anchor enum", () => {
    const payload = {
      ...baseParametersResponse,
      rules: { timingPreference: { anchor: "someday" } },
    };
    expect(() => getMeetingParametersOutput.parse(payload)).toThrow();
  });

  it("accepts guestPicksWindow", () => {
    const payload = {
      ...baseParametersResponse,
      rules: { guestPicksWindow: { startHour: 9, endHour: 17 } },
    };
    expect(() => getMeetingParametersOutput.parse(payload)).not.toThrow();
  });

  it("rejects guestPicksWindow with out-of-range hour", () => {
    const payload = {
      ...baseParametersResponse,
      rules: { guestPicksWindow: { startHour: -1, endHour: 25 } },
    };
    expect(() => getMeetingParametersOutput.parse(payload)).toThrow();
  });
});
