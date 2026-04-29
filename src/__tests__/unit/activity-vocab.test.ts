import { describe, it, expect } from "vitest";
import {
  ACTIVITY_VOCAB,
  GENERIC_TOPICS,
  isGenericTopic,
  findActivity,
  emojiForActivity,
  defaultFormatForActivity,
  naturalWindowForActivity,
  renderActivityVocabMarkdown,
  renderNaturalWindowsMarkdown,
} from "@/lib/activity-vocab";

describe("activity-vocab — module shape", () => {
  it("ACTIVITY_VOCAB has the canonical entries used as backfill anchors", () => {
    const names = ACTIVITY_VOCAB.map((e) => e.name);
    // Subset assertion — these must exist for the backfill SQL in
    // 20260428_add_topic_source/migration.sql to classify correctly.
    for (const required of [
      "coffee", "breakfast", "lunch", "dinner", "drinks",
      "bike ride", "hike", "run", "walk", "surf",
      "yoga", "workout", "swim",
      "brainstorm", "intro", "interview",
    ]) {
      expect(names).toContain(required);
    }
  });

  it("every entry has a non-empty emoji and at least one alias", () => {
    for (const entry of ACTIVITY_VOCAB) {
      expect(entry.emoji.length).toBeGreaterThan(0);
      expect(entry.aliases.length).toBeGreaterThan(0);
      // Canonical name must appear among its own aliases (so findActivity
      // resolves the canonical name as well as the LLM's variants).
      expect(entry.aliases).toContain(entry.name);
    }
  });
});

describe("isGenericTopic", () => {
  it("is true for generic filler words case-insensitively", () => {
    expect(isGenericTopic("meeting")).toBe(true);
    expect(isGenericTopic("Meeting")).toBe(true);
    expect(isGenericTopic("  Sync  ")).toBe(true);
    expect(isGenericTopic("phone call")).toBe(true);
    expect(isGenericTopic("video call")).toBe(true);
  });

  it("is false for activity vocab entries (those are NOT generic)", () => {
    expect(isGenericTopic("bike ride")).toBe(false);
    expect(isGenericTopic("coffee")).toBe(false);
    expect(isGenericTopic("hike")).toBe(false);
  });

  it("is false for custom phrases not in either list", () => {
    expect(isGenericTopic("Q3 review")).toBe(false);
    expect(isGenericTopic("post-mortem")).toBe(false);
    expect(isGenericTopic("")).toBe(false);
    expect(isGenericTopic(null)).toBe(false);
    expect(isGenericTopic(undefined)).toBe(false);
  });

  it("GENERIC_TOPICS includes the entries the duplicates added separately", () => {
    // Drift consolidation: the api/negotiate/session/route.ts duplicate had
    // "quick call" and "phone call" that the actions.ts canonical list lacked.
    // Both should now be in the canonical set.
    expect(GENERIC_TOPICS.has("quick call")).toBe(true);
    expect(GENERIC_TOPICS.has("phone call")).toBe(true);
  });
});

describe("findActivity", () => {
  it("matches by canonical name (case-insensitive)", () => {
    expect(findActivity("Bike Ride")?.name).toBe("bike ride");
    expect(findActivity("coffee")?.name).toBe("coffee");
    expect(findActivity("DINNER")?.name).toBe("dinner");
  });

  it("matches by alias", () => {
    expect(findActivity("biking")?.name).toBe("bike ride");
    expect(findActivity("cycling")?.name).toBe("bike ride");
    expect(findActivity("brunch")?.name).toBe("lunch");
    expect(findActivity("cocktails")?.name).toBe("drinks");
  });

  it("trims whitespace", () => {
    expect(findActivity("  coffee  ")?.name).toBe("coffee");
  });

  it("returns null for non-vocab phrases", () => {
    expect(findActivity("Q3 review")).toBeNull();
    expect(findActivity("standup")).toBeNull();
  });

  it("returns null for empty / null / undefined input", () => {
    expect(findActivity("")).toBeNull();
    expect(findActivity(null)).toBeNull();
    expect(findActivity(undefined)).toBeNull();
    expect(findActivity("   ")).toBeNull();
  });
});

describe("emojiForActivity", () => {
  it("returns the canonical emoji for known activities", () => {
    expect(emojiForActivity("coffee")).toBe("☕");
    expect(emojiForActivity("bike ride")).toBe("🚴");
    expect(emojiForActivity("biking")).toBe("🚴"); // alias
    expect(emojiForActivity("drinks")).toBe("🍻");
    expect(emojiForActivity("hike")).toBe("🥾");
  });

  it("returns null for unknown activities", () => {
    expect(emojiForActivity("standup")).toBeNull();
    expect(emojiForActivity(null)).toBeNull();
    expect(emojiForActivity("")).toBeNull();
  });
});

describe("defaultFormatForActivity", () => {
  it("returns in-person for physical activities", () => {
    expect(defaultFormatForActivity("bike ride")).toBe("in-person");
    expect(defaultFormatForActivity("coffee")).toBe("in-person");
    expect(defaultFormatForActivity("dinner")).toBe("in-person");
    expect(defaultFormatForActivity("hike")).toBe("in-person");
  });

  it("returns video for office-style activities", () => {
    expect(defaultFormatForActivity("brainstorm")).toBe("video");
    expect(defaultFormatForActivity("interview")).toBe("video");
    expect(defaultFormatForActivity("intro")).toBe("video");
  });

  it("returns null for unknown activities", () => {
    expect(defaultFormatForActivity("standup")).toBeNull();
    expect(defaultFormatForActivity(null)).toBeNull();
  });
});

describe("naturalWindowForActivity", () => {
  it("returns morning windows for breakfast / coffee", () => {
    expect(naturalWindowForActivity("coffee")).toEqual({ start: "07:00", end: "10:00" });
    expect(naturalWindowForActivity("breakfast")).toEqual({ start: "07:00", end: "09:00" });
  });

  it("returns evening windows for drinks / dinner", () => {
    expect(naturalWindowForActivity("drinks")).toEqual({ start: "17:00", end: "21:00" });
    expect(naturalWindowForActivity("dinner")).toEqual({ start: "18:00", end: "21:00" });
  });

  it("returns midday window for lunch", () => {
    expect(naturalWindowForActivity("lunch")).toEqual({ start: "11:30", end: "14:00" });
  });

  it("returns null for activities without a natural window (intro, brainstorm)", () => {
    expect(naturalWindowForActivity("intro")).toBeNull();
    expect(naturalWindowForActivity("brainstorm")).toBeNull();
    expect(naturalWindowForActivity("interview")).toBeNull();
  });

  it("returns null for unknown activities", () => {
    expect(naturalWindowForActivity("standup")).toBeNull();
    expect(naturalWindowForActivity(null)).toBeNull();
  });
});

describe("playbook substitution renderers", () => {
  it("renderActivityVocabMarkdown emits a non-empty string with canonical entries", () => {
    const md = renderActivityVocabMarkdown();
    expect(md.length).toBeGreaterThan(0);
    expect(md).toContain("☕ coffee");
    expect(md).toContain("🚴 bike ride");
    expect(md).toContain("🍻 drinks");
    // Source-of-truth pointer in the rendered text — keeps the LLM grounded.
    expect(md).toContain("activity-vocab.ts");
  });

  it("renderNaturalWindowsMarkdown is a markdown table including activities with windows", () => {
    const md = renderNaturalWindowsMarkdown();
    expect(md).toContain("| Activity |");
    expect(md).toContain("☕ coffee");
    expect(md).toContain("07:00–10:00");
    // Must NOT include activities without a natural window — they don't trigger the widening prompt.
    expect(md).not.toContain("brainstorm");
    expect(md).not.toContain("intro");
  });

  it("substitution output is deterministic (rendering twice produces identical output)", () => {
    expect(renderActivityVocabMarkdown()).toEqual(renderActivityVocabMarkdown());
    expect(renderNaturalWindowsMarkdown()).toEqual(renderNaturalWindowsMarkdown());
  });
});
