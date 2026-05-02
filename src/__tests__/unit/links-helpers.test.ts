/**
 * Unit tests for the V1.5 link helpers: `getLinkPosture`,
 * `applyPostureToScope`, `findAffectedVariances`, `snapshotPostureFromUser`,
 * `applyCreateEdits`.
 *
 * Proposal: 2026-05-02_per-link-config-storage-and-scoring-link-scope.
 */

import { describe, it, expect } from "vitest";
import { getLinkPosture, type LinkContext } from "@/lib/links/posture";
import {
  snapshotPostureFromUser,
  applyCreateEdits,
} from "@/lib/links/create";
import type { UserPreferences } from "@/lib/scoring";

const PRIMARY_USER: { preferences: UserPreferences } = {
  preferences: {
    explicit: {
      businessHoursStartMinutes: 9 * 60,
      businessHoursEndMinutes: 17 * 60,
      bufferMinutes: 15,
      defaultDuration: 30,
      defaultLocation: "Office",
      blackoutDays: ["2026-12-25"],
    },
    // compiled is at the top level alongside explicit (non-typed today)
    ...({
      compiled: {
        buffers: [{ beforeMinutes: 5, afterMinutes: 5, eventFilter: "all" }],
        priorityBuckets: [],
        allowWindows: [],
      },
    } as Record<string, unknown>),
  } as UserPreferences,
};

describe("getLinkPosture — Primary path", () => {
  it("resolves from User.preferences when link is null", () => {
    const posture = getLinkPosture(null, PRIMARY_USER);
    expect(posture.hoursStartMinutes).toBe(9 * 60);
    expect(posture.hoursEndMinutes).toBe(17 * 60);
    expect(posture.bufferMinutes).toBe(15);
    expect(posture.defaultDuration).toBe(30);
    expect(posture.defaultLocation).toBe("Office");
    expect(posture.blackoutDays).toEqual(["2026-12-25"]);
  });

  it("resolves from User.preferences when link.type === 'primary'", () => {
    const link: LinkContext = { type: "primary", parameters: {} };
    const posture = getLinkPosture(link, PRIMARY_USER);
    expect(posture.hoursStartMinutes).toBe(9 * 60);
    expect(posture.hoursEndMinutes).toBe(17 * 60);
  });

  it("falls back to legacy hour-fields when *Minutes is missing", () => {
    const legacyUser = {
      preferences: {
        explicit: {
          businessHoursStart: 8,
          businessHoursEnd: 17,
        },
      } as UserPreferences,
    };
    const posture = getLinkPosture(null, legacyUser);
    expect(posture.hoursStartMinutes).toBe(8 * 60);
    expect(posture.hoursEndMinutes).toBe(17 * 60);
  });

  it("uses defaults when user has no preferences", () => {
    const posture = getLinkPosture(null, null);
    expect(posture.hoursStartMinutes).toBe(9 * 60);
    expect(posture.hoursEndMinutes).toBe(18 * 60);
    expect(posture.defaultDuration).toBe(30);
    expect(posture.bufferMinutes).toBe(0);
    expect(posture.format).toBe("video");
    expect(posture.eveningsPosture).toBe("protected");
  });
});

describe("getLinkPosture — variance path", () => {
  const completeVariance: LinkContext = {
    type: "office_hours",
    parameters: {
      hoursStartMinutes: 13 * 60,
      hoursEndMinutes: 16 * 60,
      daysOfWeek: [1, 3, 5],
      duration: 15,
      bufferMinutes: 0,
      format: "phone",
      eveningsPosture: "vip_only",
    },
  };

  it("resolves from link.parameters when variance has complete posture", () => {
    const posture = getLinkPosture(completeVariance, PRIMARY_USER);
    expect(posture.hoursStartMinutes).toBe(13 * 60);
    expect(posture.hoursEndMinutes).toBe(16 * 60);
    expect(posture.daysOfWeek).toEqual([1, 3, 5]);
    expect(posture.defaultDuration).toBe(15);
    // Critical: 0 buffer is preserved (not silently 'corrected' to user value)
    expect(posture.bufferMinutes).toBe(0);
    expect(posture.format).toBe("phone");
    expect(posture.eveningsPosture).toBe("vip_only");
  });

  it("does NOT fall through to user preferences (no inheritance)", () => {
    // User has buffer=15, variance has buffer=0; variance wins.
    const posture = getLinkPosture(completeVariance, PRIMARY_USER);
    expect(posture.bufferMinutes).toBe(0);
    // User has hours 9-17, variance has 13-16; variance wins.
    expect(posture.hoursStartMinutes).toBe(13 * 60);
  });

  it("throws when variance is missing required posture fields", () => {
    const sparseVariance: LinkContext = {
      type: "office_hours",
      parameters: { duration: 30 }, // missing hours, days, buffer, format
    };
    expect(() => getLinkPosture(sparseVariance, PRIMARY_USER)).toThrow(
      /missing required posture fields/
    );
  });

  it("error message names every missing field", () => {
    const sparseVariance: LinkContext = {
      type: "office_hours",
      parameters: {},
    };
    expect(() => getLinkPosture(sparseVariance, PRIMARY_USER)).toThrow(
      /hoursStartMinutes.*hoursEndMinutes.*daysOfWeek/
    );
  });

  it("preserves explicit empty array for daysOfWeek", () => {
    const variance: LinkContext = {
      type: "office_hours",
      parameters: {
        hoursStartMinutes: 9 * 60,
        hoursEndMinutes: 17 * 60,
        daysOfWeek: [], // explicit "no days" — should be preserved
        duration: 30,
        bufferMinutes: 0,
        format: "video",
      },
    };
    const posture = getLinkPosture(variance, PRIMARY_USER);
    expect(posture.daysOfWeek).toEqual([]);
  });
});

describe("snapshotPostureFromUser", () => {
  it("returns complete posture snapshot from user preferences", () => {
    const snap = snapshotPostureFromUser(PRIMARY_USER);
    expect(snap.hoursStartMinutes).toBe(9 * 60);
    expect(snap.hoursEndMinutes).toBe(17 * 60);
    expect(snap.daysOfWeek).toEqual([1, 2, 3, 4, 5]);
    expect(snap.duration).toBe(30);
    expect(snap.bufferMinutes).toBe(15);
    expect(snap.format).toBe("video");
    expect(snap.eveningsPosture).toBe("protected");
    expect(snap.compiled?.buffers?.length).toBe(1);
  });

  it("uses defaults when user has no preferences", () => {
    const snap = snapshotPostureFromUser({});
    expect(snap.hoursStartMinutes).toBe(9 * 60);
    expect(snap.hoursEndMinutes).toBe(18 * 60);
    expect(snap.daysOfWeek).toEqual([1, 2, 3, 4, 5]);
    expect(snap.duration).toBe(30);
    expect(snap.bufferMinutes).toBe(0);
    expect(snap.format).toBe("video");
  });
});

describe("applyCreateEdits — presence-based merge", () => {
  const baseSnapshot = snapshotPostureFromUser(PRIMARY_USER);

  it("replaces fields present in edits, keeps others", () => {
    const result = applyCreateEdits(baseSnapshot, {
      hoursStartMinutes: 13 * 60,
      duration: 60,
    });
    expect(result.hoursStartMinutes).toBe(13 * 60);
    expect(result.duration).toBe(60);
    // Untouched
    expect(result.hoursEndMinutes).toBe(17 * 60);
    expect(result.bufferMinutes).toBe(15);
  });

  it("preserves explicit zero in edits (not treated as missing)", () => {
    const result = applyCreateEdits(baseSnapshot, { bufferMinutes: 0 });
    expect(result.bufferMinutes).toBe(0); // user explicitly cleared buffer
  });

  it("preserves explicit empty array in edits", () => {
    const result = applyCreateEdits(baseSnapshot, { daysOfWeek: [] });
    expect(result.daysOfWeek).toEqual([]);
  });

  it("does not modify the input snapshot", () => {
    const result = applyCreateEdits(baseSnapshot, { duration: 60 });
    expect(baseSnapshot.duration).toBe(30);
    expect(result.duration).toBe(60);
  });
});
