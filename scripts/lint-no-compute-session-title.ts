/**
 * PR1 lint — computeSessionTitle / buildSessionTitle retirement.
 *
 * After PR1 (2026-05-14), `computeSessionTitle` and `buildSessionTitle` are
 * deleted. All title computation routes through `buildEventTitle` (via
 * `getEffectiveMeetingState` for render paths or directly for write paths).
 *
 * This script catches regressions where either function is re-introduced.
 *
 * Usage:
 *   npx tsx scripts/lint-no-compute-session-title.ts
 * Exit code: 0 = clean, 1 = match found.
 *
 * Decision: proposals/2026-05-14_event-record-alignment_reviewed-2026-05-14_decided-2026-05-14.md §PR1
 * PLAYBOOK Rule 19c.
 */

import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

// ---------------------------------------------------------------------------
// Patterns — the two deleted functions and their call-site shapes
// ---------------------------------------------------------------------------

const BANNED_PATTERNS = [
  /\bcomputeSessionTitle\b/,
  /\bbuildSessionTitle\b/,
];

// Skip comment-only lines.
const COMMENT_LINE = /^\s*(\/\/|\/?\*)/;

// ---------------------------------------------------------------------------
// File walking
// ---------------------------------------------------------------------------

const APP_ROOT = process.cwd();
const SRC_ROOT = join(APP_ROOT, "src");
const SCRIPTS_ROOT = join(APP_ROOT, "scripts");

function walk(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry === "__tests__" || entry === "__mocks__") continue;
      out.push(...walk(full));
    } else if (st.isFile() && (entry.endsWith(".ts") || entry.endsWith(".tsx"))) {
      // Skip test files and this lint script itself.
      if (entry.endsWith(".test.ts") || entry.endsWith(".test.tsx") || entry.endsWith(".spec.ts")) continue;
      out.push(full);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface Match {
  file: string;
  line: number;
  pattern: string;
  text: string;
}

function lintFile(absPath: string): Match[] {
  const content = readFileSync(absPath, "utf-8");
  const lines = content.split("\n");
  const out: Match[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (COMMENT_LINE.test(line)) continue;
    for (const pattern of BANNED_PATTERNS) {
      if (pattern.test(line)) {
        out.push({
          file: relative(APP_ROOT, absPath),
          line: i + 1,
          pattern: pattern.source,
          text: line.length > 120 ? line.slice(0, 117) + "..." : line.trimEnd(),
        });
      }
    }
  }
  return out;
}

function main() {
  const files: string[] = [
    ...walk(SRC_ROOT),
    ...walk(SCRIPTS_ROOT),
  ];

  // Self-allowlist: the lint script references the banned names in comments.
  const selfRel = relative(APP_ROOT, join(SCRIPTS_ROOT, "lint-no-compute-session-title.ts"));

  let totalFailures = 0;

  for (const absPath of files) {
    const rel = relative(APP_ROOT, absPath);
    if (rel === selfRel) continue; // skip self

    const matches = lintFile(absPath);
    for (const m of matches) {
      console.error(`[rule-19c-title] ${m.file}:${m.line}  ${m.text}`);
      totalFailures++;
    }
  }

  if (totalFailures > 0) {
    console.error("");
    console.error(`Rule 19c-title lint failed: ${totalFailures} banned reference(s).`);
    console.error("  computeSessionTitle and buildSessionTitle are deleted after PR1 (2026-05-14).");
    console.error("  Use buildEventTitle (write paths) or getEffectiveMeetingState (render paths).");
    process.exit(1);
  }

  console.log(`Rule 19c-title lint: ok (${files.length} files scanned).`);
}

main();
