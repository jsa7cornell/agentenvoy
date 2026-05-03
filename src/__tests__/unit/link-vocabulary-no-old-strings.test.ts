/**
 * CI guard — fails if retired link-vocabulary strings reappear in src/
 * as new code (not as intentional dual-read guards or scoring-band uses).
 *
 * ALLOWLIST — old vocabulary is permitted in:
 *   - Lines tagged TODO(vocab-cleanup)         (dual-read guards)
 *   - The preceding line has TODO(vocab-cleanup) (guard spans two lines)
 *   - Lines using the `as string` cast          (explicit dual-read pattern)
 *   - Files in the scoring-band allowlist       (SlotKind "office_hours")
 *   - Test files under __tests__/              (fixture values for legacy paths)
 *   - prisma/migrations/**                     (WHERE-clause sweeps)
 *   - proposals/**                             (institutional memory)
 *   - this file itself
 */

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

function walkTs(dir: string, acc: string[] = []): string[] {
  const entries = fs.readdirSync(dir);
  for (const name of entries) {
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      walkTs(full, acc);
    } else if (name.endsWith(".ts") || name.endsWith(".tsx")) {
      acc.push(full);
    }
  }
  return acc;
}

const SRC_ROOT = path.resolve(__dirname, "../../");
const REPO_ROOT = path.resolve(__dirname, "../../../../");

const ALLOWLIST_PATH_PATTERNS = [
  /\/migrations\//,
  /\/proposals\//,
  /link-vocabulary-no-old-strings\.test\.ts$/,
  // Test fixtures may reference legacy scoring-band values or dual-read guards
  /src\/__tests__\//,
  // scoring.ts defines SlotKind which includes "office_hours" as a slot band
  /src\/lib\/scoring\.ts$/,
  // bookable-links.ts emits SlotKind "office_hours" for scored slots
  /src\/lib\/bookable-links\.ts$/,
];

const BANNED: Array<{ re: RegExp; label: string }> = [
  { re: /\boffice_hours\b/, label: "office_hours (as link/action type, not scoring band)" },
  { re: /\bReusableLinkKind\b/, label: "ReusableLinkKind" },
  { re: /\bcompileOfficeHoursLinks\b/, label: "compileOfficeHoursLinks" },
  { re: /\bgetOfficeHoursDisplayName\b/, label: "getOfficeHoursDisplayName" },
  { re: /\bisOfficeHoursAction\b/, label: "isOfficeHoursAction" },
  { re: /\bisOfficeHoursLink\b/, label: "isOfficeHoursLink" },
  { re: /\bofficeHoursTitle\b/, label: "officeHoursTitle" },
  { re: /\bofficeHoursFormat\b/, label: "officeHoursFormat" },
  { re: /\bofficeHoursDurationMinutes\b/, label: "officeHoursDurationMinutes" },
];

const files = walkTs(SRC_ROOT).filter(
  (f) => !ALLOWLIST_PATH_PATTERNS.some((p) => p.test(f))
);

describe("link vocabulary — no retired strings in src/", () => {
  for (const { re, label } of BANNED) {
    it(`no '${label}' outside allowlist`, () => {
      const violations: string[] = [];
      for (const file of files) {
        const rel = path.relative(REPO_ROOT, file);
        const lines = fs.readFileSync(file, "utf8").split("\n");
        lines.forEach((line, idx) => {
          if (!re.test(line)) return;
          const trimmed = line.trim();
          // Skip pure comment lines
          if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
          // Skip lines tagged for cleanup
          if (line.includes("TODO(vocab-cleanup)")) return;
          // Skip explicit dual-read guards (the cast pattern marks intentional dual-read)
          if (line.includes("as string")) return;
          // Skip if the preceding line has a TODO(vocab-cleanup) tag
          const prev = idx > 0 ? lines[idx - 1] : "";
          if (prev.includes("TODO(vocab-cleanup)")) return;
          violations.push(`${rel}:${idx + 1}: ${trimmed.slice(0, 120)}`);
        });
      }
      expect(violations, `Retired vocabulary: ${label}`).toEqual([]);
    });
  }
});
