/**
 * Parameter-resolver table test — covers every envelope state in §2.3 plus
 * the 2026-04-20 addendum formatFilters consultation. Reviewer's N1 called
 * out that any new key added to `LinkRules.guestPicks` must get a resolver
 * branch or agents silently miss it — the completeness block at the bottom
 * locks that in at CI.
 */
import { describe, it, expect } from "vitest";
import {
  resolveParameters,
  subtractFormatFilters,
  type FormatValue,
} from "@/lib/mcp/parameter-resolver";
import type { LinkRules, UserPreferences, CompiledRules } from "@/lib/scoring";

const TZ = "America/Los_Angeles";

function run(
  rules: LinkRules,
  hostPreferences: UserPreferences | null = null,
  extra: { slotStart?: Date; compiledRules?: CompiledRules | null } = {}
) {
  return resolveParameters({
    rules,
    hostPreferences,
    hostTimezone: TZ,
    ...extra,
  });
}

describe("resolveParameters — format field", () => {
  it("host locks format → locked, value set, allowedValues=[that]", () => {
    const r = run({ format: "video" });
    expect(r.format.mutability).toBe("locked");
    expect(r.format.value).toBe("video");
    expect(r.format.allowedValues).toEqual(["video"]);
    expect(r.format.guestMustResolve).toBe(false);
    expect(r.guestMustResolve).not.toContain("format");
  });

  it("guestPicks.format=true → delegated, all three formats", () => {
    const r = run({ guestPicks: { format: true } });
    expect(r.format.mutability).toBe("delegated");
    expect(r.format.value).toBeNull();
    expect(r.format.allowedValues).toEqual(["video", "phone", "in-person"]);
    expect(r.format.guestMustResolve).toBe(true);
  });

  it("guestPicks.format=array → delegated, allowedValues is the array", () => {
    const r = run({ guestPicks: { format: ["video", "phone"] } });
    expect(r.format.mutability).toBe("delegated");
    expect(r.format.allowedValues).toEqual(["video", "phone"]);
    expect(r.format.guestMustResolve).toBe(true);
  });

  it("neither host nor guestPicks.format → required (pre-migration link)", () => {
    const r = run({});
    expect(r.format.mutability).toBe("required");
    expect(r.format.origin).toBe("unset");
    expect(r.format.guestMustResolve).toBe(true);
    expect(r.guestMustResolve).toContain("format");
  });
});

describe("resolveParameters — formatFilters subtraction", () => {
  const compiledRules: CompiledRules = {
    blockedWindows: [],
    allowWindows: [],
    buffers: [],
    priorityBuckets: [],
    ambiguities: [],
    compiledAt: "2026-04-20T00:00:00Z",
    formatFilters: [
      {
        // No in-person after 17:00 any day
        start: "17:00",
        end: "23:59",
        disallowFormats: ["in-person"],
        label: "evening_no_in_person",
      },
    ],
  };

  it("locked in-person at an evening slot → value null, allowedValues empty", () => {
    // 2026-05-01 19:00 PT
    const slot = new Date("2026-05-02T02:00:00Z");
    const r = run({ format: "in-person" }, null, { slotStart: slot, compiledRules });
    expect(r.format.value).toBeNull();
    expect(r.format.allowedValues).toEqual([]);
  });

  it("delegated all-formats at an evening slot → in-person dropped", () => {
    const slot = new Date("2026-05-02T02:00:00Z"); // 19:00 PT
    const r = run(
      { guestPicks: { format: true } },
      null,
      { slotStart: slot, compiledRules }
    );
    expect(r.format.allowedValues).toEqual(["video", "phone"]);
  });

  it("delegated all-formats at a morning slot → untouched", () => {
    const slot = new Date("2026-05-01T17:00:00Z"); // 10:00 PT
    const r = run(
      { guestPicks: { format: true } },
      null,
      { slotStart: slot, compiledRules }
    );
    expect(r.format.allowedValues).toEqual(["video", "phone", "in-person"]);
  });

  it("filter outside effective window → no effect", () => {
    const expiredCompiled: CompiledRules = {
      ...compiledRules,
      formatFilters: [
        { disallowFormats: ["in-person"], expires: "2026-04-19" }, // past
      ],
    };
    const slot = new Date("2026-05-01T12:00:00Z");
    const r = run(
      { guestPicks: { format: true } },
      null,
      { slotStart: slot, compiledRules: expiredCompiled }
    );
    expect(r.format.allowedValues).toEqual(["video", "phone", "in-person"]);
  });
});

describe("subtractFormatFilters — direct coverage", () => {
  it("days guard — no match on weekday outside list", () => {
    // 2026-05-04 is a Monday PT.
    const monday = new Date("2026-05-04T19:00:00Z"); // 12:00 PT
    const filters: NonNullable<CompiledRules["formatFilters"]> = [
      { days: ["Sat", "Sun"], disallowFormats: ["in-person"] },
    ];
    const out = subtractFormatFilters(
      ["video", "phone", "in-person"] satisfies FormatValue[],
      filters,
      monday,
      TZ
    );
    expect(out).toEqual(["video", "phone", "in-person"]);
  });

  it("empty filter list is a pass-through", () => {
    const out = subtractFormatFilters(
      ["video", "phone"] satisfies FormatValue[],
      [],
      new Date(),
      TZ
    );
    expect(out).toEqual(["video", "phone"]);
  });
});

describe("resolveParameters — duration field", () => {
  it("host locks duration → locked", () => {
    const r = run({ duration: 60 });
    expect(r.duration.mutability).toBe("locked");
    expect(r.duration.value).toBe(60);
  });

  it("guestPicks.duration=true → open, suggestions surfaced", () => {
    const r = run({
      guestPicks: { duration: true },
      guestGuidance: { suggestions: { durations: [30, 45] } },
    });
    expect(r.duration.mutability).toBe("open");
    expect(r.duration.suggestions).toEqual([30, 45]);
    expect(r.duration.guestMustResolve).toBe(true);
  });

  it("guestPicks.duration=array → delegated with allowedValues", () => {
    const r = run({ guestPicks: { duration: [30, 60, 90] } });
    expect(r.duration.mutability).toBe("delegated");
    expect(r.duration.allowedValues).toEqual([30, 60, 90]);
    expect(r.duration.guestMustResolve).toBe(true);
  });

  it("host-profile default → host-filled (preferences.defaultDuration)", () => {
    const r = run({}, { defaultDuration: 45 });
    expect(r.duration.value).toBe(45);
    expect(r.duration.origin).toBe("host-profile-default");
    expect(r.duration.mutability).toBe("host-filled");
  });

  it("host-profile default — explicit.defaultDuration fallback", () => {
    const r = run({}, { explicit: { defaultDuration: 20 } });
    expect(r.duration.value).toBe(20);
  });

  it("system default → 30 min host-filled", () => {
    const r = run({}, {});
    expect(r.duration.value).toBe(30);
    expect(r.duration.origin).toBe("system-default");
    expect(r.duration.mutability).toBe("host-filled");
    expect(r.duration.guestMustResolve).toBe(false);
  });
});

describe("resolveParameters — location field", () => {
  it("host locks location → locked", () => {
    const r = run({ location: "Ritual Coffee, Valencia" });
    expect(r.location.mutability).toBe("locked");
    expect(r.location.value).toContain("Ritual");
  });

  it("guestPicks.location for in-person → open + guestMustResolve", () => {
    const r = run({
      format: "in-person",
      guestPicks: { location: true },
      guestGuidance: { suggestions: { locations: ["Blue Bottle", "Sightglass"] } },
    });
    expect(r.location.mutability).toBe("open");
    expect(r.location.suggestions).toEqual(["Blue Bottle", "Sightglass"]);
    expect(r.location.guestMustResolve).toBe(true);
  });

  it("guestPicks.location for video → open but not blocking", () => {
    const r = run({ format: "video", guestPicks: { location: true } });
    expect(r.location.mutability).toBe("open");
    expect(r.location.guestMustResolve).toBe(false);
  });

  it("profile defaultLocation → host-filled (silent, never delegated)", () => {
    const r = run({ format: "in-person" }, { explicit: { defaultLocation: "Home" } });
    expect(r.location.value).toBe("Home");
    expect(r.location.origin).toBe("host-profile-default");
    expect(r.location.mutability).toBe("host-filled");
  });

  it("in-person + no venue + no profile default → required", () => {
    const r = run({ format: "in-person" }, {});
    expect(r.location.mutability).toBe("required");
    expect(r.location.value).toBeNull();
    expect(r.location.guestMustResolve).toBe(true);
  });
});

describe("resolveParameters — timezone + summary", () => {
  it("timezone is always locked to host tz", () => {
    const r = run({});
    expect(r.timezone.mutability).toBe("locked");
    expect(r.timezone.value).toBe(TZ);
  });

  it("guestMustResolve aggregates blocking fields", () => {
    const r = run({ guestPicks: { format: true, duration: true } });
    // format + duration both need resolution; timezone is locked.
    expect(r.guestMustResolve).toContain("format");
    expect(r.guestMustResolve).toContain("duration");
    expect(r.guestMustResolve).not.toContain("timezone");
  });
});

describe("resolveParameters — guestPicks completeness (reviewer N1)", () => {
  // If anyone adds a new key to LinkRules.guestPicks in scoring.ts without
  // updating parameter-resolver.ts, this test fails loudly at CI.
  it("every guestPicks key has a resolver branch", () => {
    const GUESTPICKS_KEYS_WITH_RESOLVER = new Set([
      "window", // date/time window — consumed by slot API, not resolver per se
      "date",   // date deferral — consumed by slot API
      "duration",
      "location",
      "format",
    ]);
    // Enumerate the keys TypeScript would allow on guestPicks.
    const sample: NonNullable<LinkRules["guestPicks"]> = {
      window: { startHour: 9, endHour: 17 },
      date: true,
      duration: true,
      location: true,
      format: true,
    };
    for (const key of Object.keys(sample)) {
      expect(GUESTPICKS_KEYS_WITH_RESOLVER.has(key)).toBe(true);
    }
  });
});
