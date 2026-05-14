/**
 * Rule 19c lint — Link.topic reader retirement.
 *
 * After PR3 (2026-05-14), `NegotiationLink.topic` is write-only; all reads
 * must use `link.customTitle` instead. This script catches regressions where
 * new code reads `.topic` from a link object.
 *
 * It matches `\.topic\b` across `src/**\/*.{ts,tsx}` and fails on any hit
 * outside the allowlist. The allowlist covers:
 *   - write paths that still write to the `topic` column (allowed during the
 *     migration window; column drop ≥3 weeks after PR3 ships)
 *   - files where `.topic` refers to a non-Link type (function args, JSON
 *     parameters blobs, agent context types)
 *
 * Usage:
 *   npx tsx scripts/lint-no-link-topic-read.ts
 * Exit code: 0 = clean, 1 = unexempted match found.
 *
 * Decision: proposals/2026-05-14_event-record-alignment_reviewed-2026-05-14_decided-2026-05-14.md
 * PLAYBOOK Rule 19c.
 */

import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

// ---------------------------------------------------------------------------
// Allowlist — paths relative to app/ (i.e. relative to process.cwd())
// ---------------------------------------------------------------------------

/**
 * Files exempt from this lint, with the reason why.
 *
 * Remove entries only after the corresponding write path is retired or the
 * Link.topic column is dropped.
 */
const ALLOWLIST: Record<string, string> = {
  // ── Write paths (still write Link.topic during migration window) ──────────

  // Write-mirror: reads args.topic (wire input) to write to both Link.topic
  // and Link.customTitle. Not a DB read of Link.topic.
  "src/lib/mcp/host-tools.ts": "write-mirror: args.topic → DB write",

  // Manages topicClearUpdate logic; reads link.topic only on the write path
  // that keeps topic + customTitle in sync during the migration window.
  "src/agent/actions.ts": "write-path: topic ↔ customTitle sync",

  // `topic: topic || parsedRules.topic || null` is a Prisma data write, not a
  // read of the Link.topic column. parsedRules.topic is parsed from
  // LinkParameters JSON, not from Link.topic.
  "src/app/api/negotiate/create/route.ts": "write: topic param → DB write; parsedRules is LinkParameters JSON",

  // Writes args.topic to LinkParameters JSON blob (params.topic), not to
  // the Link.topic DB column.
  "src/app/api/channel/chat/route.ts": "params.topic is LinkParameters JSON, not Link.topic",

  // ── Non-Link .topic accesses (different types) ───────────────────────────

  // context.topic is AgentContext.topic (internal context type, not Link).
  "src/agent/agent-runner.ts": "context.topic is AgentContext, not Link.topic",

  // options.topic is ComposerOptions.topic (internal, not Link).
  "src/agent/composer.ts": "options.topic is ComposerOptions, not Link.topic",

  // evalCase.context.topic / c.context.topic are eval context objects.
  "src/agent/evals/run.ts": "context.topic is EvalContext, not Link.topic",

  // intent.topic is the NegotiationIntent type, not Link.
  "src/agent/modules/_shared/mint-link-and-confirm-invite.ts": "intent.topic is NegotiationIntent, not Link.topic",

  // intent.topic is the NegotiationIntent type, not Link.
  "src/agent/modules/_shared/tools/book-time-with-commit.ts": "intent.topic is NegotiationIntent, not Link.topic",

  // input.topic is runner input object, not Link.
  "src/agent/unified/runner.ts": "input.topic is RunnerInput, not Link.topic",

  // p.topic is a function parameter of the email template, not Link.
  "src/lib/emails/guest-confirmation.ts": "p.topic is email template param, not Link.topic",

  // Bench/eval fixtures — row.topic is a fixture column, not Link.
  "scripts/bench-intent/fixtures.ts": "row.topic is bench fixture data, not Link.topic",

  // ── Meta ─────────────────────────────────────────────────────────────────

  // Lint script itself references the field name as a string/comment.
  "scripts/lint-no-link-topic-read.ts": "this lint script",
};

// ---------------------------------------------------------------------------
// Pattern
// ---------------------------------------------------------------------------

const TOPIC_READ = /\.topic\b/;

// Skip comment-only lines so `// link.topic` docs don't trip the lint.
const COMMENT_LINE = /^\s*(\/\/|\/?\*)/;

// ---------------------------------------------------------------------------
// File walking
// ---------------------------------------------------------------------------

const APP_ROOT = process.cwd();
const SRC_ROOT = join(APP_ROOT, "src");

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
      // Skip test directories and node_modules.
      if (entry === "node_modules" || entry === "__tests__" || entry === "__mocks__") continue;
      out.push(...walk(full));
    } else if (st.isFile() && (entry.endsWith(".ts") || entry.endsWith(".tsx"))) {
      // Skip test files.
      if (entry.endsWith(".test.ts") || entry.endsWith(".test.tsx") || entry.endsWith(".spec.ts")) continue;
      out.push(full);
    }
  }
  return out;
}

// Also scan scripts/ for completeness (self-exempted above).
const SCRIPTS_ROOT = join(APP_ROOT, "scripts");

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface Match {
  file: string;
  line: number;
  text: string;
}

function lintFile(absPath: string): Match[] {
  const content = readFileSync(absPath, "utf-8");
  const lines = content.split("\n");
  const out: Match[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (COMMENT_LINE.test(line)) continue;
    if (TOPIC_READ.test(line)) {
      out.push({
        file: relative(APP_ROOT, absPath),
        line: i + 1,
        text: line.length > 120 ? line.slice(0, 117) + "..." : line.trimEnd(),
      });
    }
  }
  return out;
}

function main() {
  const files: string[] = [
    ...walk(SRC_ROOT),
    ...walk(SCRIPTS_ROOT),
  ];

  let totalFailures = 0;
  let allowlistHits = 0;

  for (const absPath of files) {
    const rel = relative(APP_ROOT, absPath);
    const matches = lintFile(absPath);
    if (matches.length === 0) continue;

    if (rel in ALLOWLIST) {
      allowlistHits += matches.length;
      continue;
    }

    for (const m of matches) {
      console.error(`[rule-19c] ${m.file}:${m.line}  ${m.text}`);
      totalFailures++;
    }
  }

  if (totalFailures > 0) {
    console.error("");
    console.error(`Rule 19c lint failed: ${totalFailures} unallowlisted .topic read(s).`);
    console.error("  Link.topic is write-only after PR3 (2026-05-14). Read link.customTitle instead.");
    console.error("  To add a temporary allowlist entry (write paths only), edit:");
    console.error("    scripts/lint-no-link-topic-read.ts → ALLOWLIST");
    process.exit(1);
  }

  console.log(
    `Rule 19c lint: ok (${files.length} files scanned, ${allowlistHits} match(es) in ${Object.keys(ALLOWLIST).length} allowlisted file(s)).`,
  );
}

main();
