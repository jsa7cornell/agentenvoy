/**
 * Sentinel test — fails if the load-bearing HARD RULE strings against
 * fabricated ids and reserved-name auto-creation get removed from the
 * `calendar-rule-composer.md` playbook by a future edit.
 *
 * Why this matters: the rule is the floor (Layer 1) under the Layer 2c
 * runtime guard added in the same proposal. If the playbook string
 * disappears, the runtime guard becomes the only defense — fine in
 * principle, but the playbook is where the model learns the *positive*
 * shape (`rule_xxx` ids, the `rename_primary` op for the primary link).
 * Removing it silently degrades model behavior between runtime catches.
 *
 * Failure mode if this test ever fires: an agent edited the playbook
 * (probably trying to compress, refactor, or split the file) and either
 * dropped the rule entirely OR rephrased it in a way that no longer
 * pins the failure-mode words. Either way, re-add the load-bearing
 * substrings or update this test to track the new phrasing.
 *
 * Origin: proposal `2026-05-03_composer-state-aware-fidelity`
 * (decided 2026-05-04). F14 row in COMPOSER.md §2.
 */

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const PLAYBOOK_PATH = path.resolve(
  __dirname,
  "../../agent/runtime-prompts/composers/calendar-rule-composer.md",
);

describe("calendar-rule-composer.md — HARD RULE on fabricated ids (sentinel)", () => {
  const playbook = fs.readFileSync(PLAYBOOK_PATH, "utf8");

  it("contains the never-invent-id HARD RULE header", () => {
    // The exact opening of the new rule. If this string changes the test
    // should be updated to track the new phrasing (and the proposal's
    // §3 file-by-file plan should be amended).
    expect(playbook).toContain(
      "HARD RULE — never invent an `id` for an `update` or `remove` operation",
    );
  });

  it("enumerates the failure-mode words as forbidden ids", () => {
    // Per COMPOSER.md §6 ("negative examples beat positive rules"), the
    // rule must call out the specific words the model has historically
    // reached for. F14's bundle: composer used `id:"general"`. The list
    // covers that case + adjacent reserved names.
    for (const forbidden of [
      `"general"`,
      `"primary"`,
      `"main"`,
      `"default"`,
      `"office_hours"`,
      `"bookable"`,
    ]) {
      expect(
        playbook,
        `expected forbidden-id list to include ${forbidden}`,
      ).toContain(forbidden);
    }
  });

  it("teaches the positive shape (rule_xxx) for valid ids", () => {
    expect(playbook).toContain("rule_a3b9c2d1");
    expect(playbook).toMatch(/`rule_` prefix/);
  });

  it("documents that fresh-create requests use operation:add (not update with a guessed id)", () => {
    expect(playbook).toMatch(
      /never reach for `operation:"update"` with a guessed id/,
    );
    expect(playbook).toContain(`operation:"add"`);
  });

  it("uses rename_primary (not rename_general) as the primary-link rename op", () => {
    expect(playbook).toContain(`rename_primary`);
    expect(playbook).not.toContain("rename_general");
  });

  it("includes paired ❌ Bad / ✅ Good worked examples", () => {
    // The bad/good pair makes the rule readable. If a future edit drops
    // them in favor of prose, the model loses the canonical shape contrast.
    expect(playbook).toMatch(/❌ \*\*Bad\*\*[\s\S]*?"id":"general"/);
    expect(playbook).toMatch(/✅ \*\*Good\*\*[\s\S]*?"id":"rule_a3b9c2d1"/);
  });
});
