/**
 * CalendarListCache invalidation-discipline guard.
 * Proposal: 2026-05-02_picker-load-perf §3c
 *
 * Every file that WRITES `activeCalendarIds` must either call
 * `invalidateCalendarListCache` at the write site, or be on the allowlist
 * below with an explanatory comment.
 *
 * This test fails CI when a new writer is added without the corresponding
 * invalidation hook, with a message pointing the author at the proposal.
 */

import { describe, it, expect } from "vitest";
import { execSync } from "child_process";
import { readFileSync } from "fs";
import path from "path";

describe("CalendarListCache invalidation discipline", () => {
  it("every activeCalendarIds writer either invalidates the cache or is on the allowlist", () => {
    // Find every file in app/src that assigns activeCalendarIds.
    // __dirname is app/src/__tests__/unit — two levels up is app/src.
    const srcDir = path.resolve(__dirname, "../../");

    const raw = execSync(
      `grep -rln "activeCalendarIds" "${srcDir}" --include="*.ts"`,
      { encoding: "utf8" },
    )
      .trim()
      .split("\n")
      .filter(Boolean);

    // Allowlist: files that legitimately don't need invalidation at this site.
    // Add new entries here with a comment explaining why.
    const ALLOWLIST = new Set([
      // Initial signup seed — no CalendarListCache row exists yet for a new user.
      path.join(srcDir, "lib/onboarding/seed-defaults.ts"),
      // Type/schema definition (`UserPreferences.explicit.activeCalendarIds`) — not a write site.
      path.join(srcDir, "lib/scoring.ts"),
      // Reads `activeCalendarIds` as a function parameter and for filtering — not a write site.
      path.join(srcDir, "lib/calendar.ts"),
      // Parameter type definition + reads for filtering — not a write site.
      path.join(srcDir, "lib/google-onboarding-seed.ts"),
      // Test files — only reference activeCalendarIds in assertions, not writes.
      path.join(srcDir, "__tests__/unit/onboarding/seed-defaults.test.ts"),
      path.join(srcDir, "__tests__/integration/signIn-merges-guest-flow-account.test.ts"),
      // This test file itself.
      path.join(srcDir, "__tests__/unit/calendar-list-cache-invalidation-coverage.test.ts"),
    ]);

    const writeSites = raw.filter((p) => !ALLOWLIST.has(p));

    for (const filePath of writeSites) {
      const contents = readFileSync(filePath, "utf8");
      expect(
        contents,
        `${filePath} writes activeCalendarIds but does not import or call ` +
          `invalidateCalendarListCache. ` +
          `Add invalidateCalendarListCache(userId) at the write site, ` +
          `or add the file to the ALLOWLIST in ` +
          `src/__tests__/unit/calendar-list-cache-invalidation-coverage.test.ts ` +
          `with a comment explaining why. ` +
          `See proposal 2026-05-02_picker-load-perf §3c for the discipline.`,
      ).toContain("invalidateCalendarListCache");
    }
  });
});
