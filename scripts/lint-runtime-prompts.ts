/**
 * Rule 27 lint — examples-vs-instructions structural separation.
 *
 * Scans `app/src/agent/runtime-prompts/composers/**\/*.md`,
 * `classifiers/**\/*.md`, and `fragments/**\/*.md` for worked-example shapes
 * (dialogue prefixes, classifier-mapping arrows, good/bad markers, quoted
 * dialogue) that should live in `app/src/agent/modules/<name>/fewshot.ts` or
 * the bench corpus, NOT in the operational system prompt.
 *
 * Per proposal 2026-05-05_examples-vs-instructions-prompt-separation §12.2 +
 * PLAYBOOK Rule 27. Patterns intentionally specific to dialogue-shape — the
 * §12.4 false-positive guards are the design contract (e.g. `> **HARD RULE**`
 * callouts must not trip; only `> "...` actual dialogue does).
 *
 * Usage:
 *   npx tsx scripts/lint-runtime-prompts.ts
 * Exit code: 0 = clean, 1 = unexempted matches found.
 *
 * Exempt paths live in the migration manifest at
 * proposals/2026-05-05_examples-vs-instructions-prompt-separation_decided-2026-05-05/migration-checklist.md.
 * The manifest is read at lint time; exempted files have their matches reported
 * but do NOT fail the lint. Phase 2/3 migrations remove entries one by one.
 */
import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

// ---------------------------------------------------------------------------
// Patterns — single source of truth (proposal §12.4)
// ---------------------------------------------------------------------------

interface Pattern {
  name: string;
  regex: RegExp;
  description: string;
}

const PATTERNS: Pattern[] = [
  {
    name: "speaker-prefix",
    regex: /^\*\*(Host|You):\*\*/,
    description: "Named-speaker dialogue prefix (`**Host:**` / `**You:**`)",
  },
  {
    name: "quoted-dialogue",
    regex: /^>\s+"/,
    description: "Quoted dialogue (`> \"...\"` form, NOT `> **callout**`)",
  },
  {
    name: "classifier-mapping",
    regex: /^[-*]\s+"[^"]+"\s+→\s*\{kind:/,
    description: 'Classifier mapping arrow (`- "utterance" → {kind: ...}`)',
  },
  {
    name: "good-bad-marker",
    regex: /^(❌|✅|Bad|Good):\s/,
    description: "Good/bad narration pair marker",
  },
];

// ---------------------------------------------------------------------------
// File walking
// ---------------------------------------------------------------------------

const APP_ROOT = process.cwd();
const PROMPT_ROOT = join(APP_ROOT, "src/agent/runtime-prompts");
const SCAN_DIRS = [
  join(PROMPT_ROOT, "composers"),
  join(PROMPT_ROOT, "classifiers"),
  join(PROMPT_ROOT, "fragments"),
];

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
      out.push(...walk(full));
    } else if (st.isFile() && entry.endsWith(".md")) {
      out.push(full);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Manifest loader
// ---------------------------------------------------------------------------

const MANIFEST_PATH = join(
  APP_ROOT,
  "..",
  "proposals",
  "2026-05-05_examples-vs-instructions-prompt-separation_decided-2026-05-05",
  "migration-checklist.md",
);

function loadExemptPaths(): Set<string> {
  const out = new Set<string>();
  let content: string;
  try {
    content = readFileSync(MANIFEST_PATH, "utf-8");
  } catch {
    return out; // No manifest → no exemptions, all files lint strictly.
  }
  const start = content.indexOf("<!-- lint-manifest -->");
  const end = content.indexOf("<!-- /lint-manifest -->");
  if (start === -1 || end === -1 || end < start) return out;
  const block = content.slice(start, end);
  for (const line of block.split("\n")) {
    const m = line.match(/^- exempt:\s*(\S+)/);
    if (m) out.add(m[1]);
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
    for (const p of PATTERNS) {
      if (p.regex.test(line)) {
        out.push({
          file: relative(APP_ROOT, absPath),
          line: i + 1,
          pattern: p.name,
          text: line.length > 120 ? line.slice(0, 117) + "..." : line,
        });
      }
    }
  }
  return out;
}

function main() {
  const files: string[] = [];
  for (const dir of SCAN_DIRS) files.push(...walk(dir));

  const exemptPaths = loadExemptPaths();
  let totalFailures = 0;
  let exemptHits = 0;

  for (const file of files) {
    const rel = relative(APP_ROOT, file);
    const matches = lintFile(file);
    if (matches.length === 0) continue;
    const isExempt = exemptPaths.has(rel);
    if (isExempt) {
      exemptHits += matches.length;
      continue;
    }
    for (const m of matches) {
      console.error(
        `[rule-27] ${m.file}:${m.line}  pattern=${m.pattern}  ${m.text}`,
      );
      totalFailures++;
    }
  }

  if (totalFailures > 0) {
    console.error("");
    console.error(
      `Rule 27 lint failed: ${totalFailures} unexempted match(es).`,
    );
    console.error(
      "  Worked-example shapes (dialogue prefixes, classifier mappings, good/bad",
    );
    console.error(
      "  pairs, quoted dialogue) belong in fewshot.ts or bench fixtures, not in",
    );
    console.error("  operational fragments. See PLAYBOOK Rule 27.");
    console.error(
      "  If a fragment is mid-migration, add it to the manifest at:",
    );
    console.error(`    ${relative(APP_ROOT, MANIFEST_PATH)}`);
    process.exit(1);
  }

  console.log(
    `Rule 27 lint: ok (${files.length} files scanned, ${exemptHits} match(es) in ${exemptPaths.size} exempt file(s)).`,
  );
}

main();
