import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  parseLinkPatch,
  LINK_PATCH_KEYS,
} from "@/lib/link-patch-schema";

describe("parseLinkPatch — create mode", () => {
  it("accepts a minimal create with inviteeNames", () => {
    const r = parseLinkPatch({ inviteeNames: ["Sarah"] }, "create");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.mode).toBe("create");
      expect(r.patch.inviteeNames).toEqual(["Sarah"]);
    }
  });

  it("accepts a minimal create with singular inviteeName", () => {
    const r = parseLinkPatch({ inviteeName: "Bob" }, "create");
    expect(r.ok).toBe(true);
  });

  it("rejects a create with no invitee", () => {
    const r = parseLinkPatch({ topic: "lunch" }, "create");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("invitee");
  });

  it("rejects a create with empty inviteeNames array", () => {
    const r = parseLinkPatch({ inviteeNames: [] }, "create");
    expect(r.ok).toBe(false);
  });

  it("accepts guestPicks at create time (existing behavior)", () => {
    const r = parseLinkPatch(
      { inviteeNames: ["Sarah"], guestPicks: { location: true } },
      "create",
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.patch.guestPicks?.location).toBe(true);
  });
});

describe("parseLinkPatch — update mode (the bug-fix surface)", () => {
  it("accepts guestPicks-only patch (REGRESSION: today's update_link rejects this as 'no field changed')", () => {
    const r = parseLinkPatch(
      { code: "abc", guestPicks: { location: true } },
      "update",
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.patch.guestPicks?.location).toBe(true);
  });

  it("accepts guestGuidance-only patch", () => {
    const r = parseLinkPatch(
      { code: "abc", guestGuidance: { tone: "casual" } },
      "update",
    );
    expect(r.ok).toBe(true);
  });

  it("rejects an empty patch", () => {
    const r = parseLinkPatch({}, "update");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("at least one field");
  });

  it("rejects a routing-only patch (code + sessionId, nothing else)", () => {
    const r = parseLinkPatch({ code: "abc", sessionId: "ses-1" }, "update");
    expect(r.ok).toBe(false);
  });

  it("rejects a steering-only patch (preserves §4.7 split rule)", () => {
    const r = parseLinkPatch(
      { code: "abc", intent: { steering: "open" } },
      "update",
    );
    expect(r.ok).toBe(false);
  });

  it("rejects a bare-steering-only patch", () => {
    const r = parseLinkPatch({ code: "abc", steering: "open" }, "update");
    expect(r.ok).toBe(false);
  });

  it("accepts intent + a real field", () => {
    const r = parseLinkPatch(
      { code: "abc", intent: { steering: "open" }, duration: 60 },
      "update",
    );
    expect(r.ok).toBe(true);
  });

  it("accepts availability.restrictToDays via the new schema", () => {
    const r = parseLinkPatch(
      { code: "abc", availability: { restrictToDays: ["Mon", "Tue"] } },
      "update",
    );
    expect(r.ok).toBe(true);
  });

  it("accepts blockedRanges up to 10 entries", () => {
    const ranges = Array.from({ length: 10 }, (_, i) => ({
      start: `2026-04-${String(20 + i).padStart(2, "0")}T17:00:00-07:00`,
      end: `2026-04-${String(20 + i).padStart(2, "0")}T22:00:00-07:00`,
    }));
    const r = parseLinkPatch({ code: "abc", blockedRanges: ranges }, "update");
    expect(r.ok).toBe(true);
  });

  it("rejects 11+ blockedRanges", () => {
    const ranges = Array.from({ length: 11 }, (_, i) => ({
      start: `2026-04-${String(20 + (i % 9)).padStart(2, "0")}T17:00:00-07:00`,
      end: `2026-04-${String(20 + (i % 9)).padStart(2, "0")}T22:00:00-07:00`,
    }));
    const r = parseLinkPatch({ code: "abc", blockedRanges: ranges }, "update");
    expect(r.ok).toBe(false);
  });
});

describe("parseLinkPatch — field-shape validation", () => {
  it("rejects negative duration", () => {
    const r = parseLinkPatch({ code: "abc", duration: -5 }, "update");
    expect(r.ok).toBe(false);
  });

  it("rejects non-integer duration", () => {
    const r = parseLinkPatch({ code: "abc", duration: 30.5 }, "update");
    expect(r.ok).toBe(false);
  });

  it("rejects unknown format value", () => {
    const r = parseLinkPatch({ code: "abc", format: "carrier-pigeon" }, "update");
    expect(r.ok).toBe(false);
  });

  it("rejects malformed availability.expand window (HH:MM only)", () => {
    const r = parseLinkPatch(
      { code: "abc", availability: { expand: [{ window: { start: "5pm", end: "10pm" } }] } },
      "update",
    );
    expect(r.ok).toBe(false);
  });

  it("accepts valid HH:MM availability.expand window", () => {
    const r = parseLinkPatch(
      { code: "abc", availability: { expand: [{ window: { start: "17:00", end: "22:00" } }] } },
      "update",
    );
    expect(r.ok).toBe(true);
  });

  it("rejects availability.expand entry with neither days nor window", () => {
    const r = parseLinkPatch(
      { code: "abc", availability: { expand: [{}] } },
      "update",
    );
    expect(r.ok).toBe(false);
  });

  it("rejects unknown steering value", () => {
    const r = parseLinkPatch(
      { code: "abc", duration: 60, steering: "supercharged" },
      "update",
    );
    expect(r.ok).toBe(false);
  });
});

describe("parseLinkPatch — schema lockstep with link-parameters.ts (N1 fold)", () => {
  it("guestPicks shape parses the same shape link-parameters accepts", () => {
    // The persisted shape (link-parameters.ts) has these guestPicks keys.
    // Both schemas must accept the same input. If they drift, this test fails.
    const probe = {
      window: { startHour: 17, endHour: 21 },
      date: true,
      duration: [60, 90] as number[],
      location: true,
      format: ["video", "phone"] as ("video" | "phone")[],
    };
    const r = parseLinkPatch(
      { code: "abc", guestPicks: probe },
      "update",
    );
    expect(r.ok).toBe(true);
  });

  it("guestGuidance shape parses the same shape link-parameters accepts", () => {
    const probe = {
      suggestions: { locations: ["Soquel"], durations: [60, 90] },
      tone: "warm",
      preferredFormat: "in-person" as const,
    };
    const r = parseLinkPatch(
      { code: "abc", guestGuidance: probe },
      "update",
    );
    expect(r.ok).toBe(true);
  });
});

describe("LINK_PATCH_KEYS — schema-handler coverage (N3 fold)", () => {
  it("includes every assignable field referenced in actions.ts handleExpandLink", () => {
    // Bounded-false-positive grep test: assert every patch key has at least
    // one read site in actions.ts. Catches the drift case where a field is
    // added to the schema without handler wiring. Routing-only and
    // passthrough fields are excluded from the contract since the handler
    // doesn't gate on them.
    const ROUTING_OR_PASSTHROUGH = new Set([
      "code", "sessionId",       // routing
      "recurrence", "seriesChange", // passthrough validators
      // Create-only fields the update_link handler doesn't yet accept.
      // Tracked as a future symmetry follow-up (the same drift class this
      // proposal is fixing for guestPicks/guestGuidance) — when an edit-
      // time use case for these surfaces, extend the handler and remove
      // from this exclusion.
      "minDuration", "startTime",
    ]);
    const actionsTs = readFileSync(
      join(process.cwd(), "src/agent/actions.ts"),
      "utf-8",
    );
    const missing: string[] = [];
    for (const key of LINK_PATCH_KEYS) {
      if (ROUTING_OR_PASSTHROUGH.has(key)) continue;
      // Look for `params.X` OR `patch.X` OR `existingRules.X` references.
      const patterns = [
        `params.${key}`,
        `patch.${key}`,
        `existingRules.${key}`,
        `params["${key}"]`,
        `patch["${key}"]`,
      ];
      const found = patterns.some((p) => actionsTs.includes(p));
      if (!found) missing.push(key);
    }
    expect(missing).toEqual([]);
  });
});
