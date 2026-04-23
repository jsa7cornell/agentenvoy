/**
 * /bench-intent runner.
 *
 * Pipes a synthesized adversarial corpus through the real
 * `classifyChatIntent()` with a fixture ClassifyContext. Filters to
 * failures per proposal §9.5.3 and writes JSON + CSV to out/.
 *
 * Not CI-blocking. Invoked from the `/bench-intent` slash-command
 * or directly via `npm run bench:intent -- --scenario=... --axis=... --count=N`.
 *
 * Proposal reference: 2026-04-22 §9.5.
 */

import { mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { classifyChatIntent } from "@/agent/intent-classifier";
import type { ChatIntent } from "@/lib/intent";
import {
  buildFixture,
  fixtureToClassifyContext,
  isPresetName,
  type Fixture,
  type ScenarioSeed,
} from "./fixtures";
import { generateCorpus, isAxis, type Axis, type GeneratedUtterance } from "./corpus-gen";

const HARD_MAX_COUNT = 100;
const DEFAULT_COUNT = 30;
const HIGH_CONFIDENCE_THRESHOLD = 0.6;

const FABRICATION_MARKERS = [
  "as a meeting or",
  "schedule or",
  "unavailable for a",
];

export interface RunBenchArgs {
  scenario: ScenarioSeed;
  axis: Axis;
  count: number;
  scheduling?: boolean;
  /** Override output dir (tests). */
  outDir?: string;
  /** Skip writing files (tests). */
  skipWrite?: boolean;
}

export interface FailureRow {
  utterance: string;
  axis: Axis;
  predictedTier: string;
  expectedTier?: ChatIntent;
  confidence?: number;
  clarifier?: string;
  flagReasons: string[];
  recap: string;
}

export interface BenchResultRow {
  utterance: string;
  axis: Axis;
  expectedTier?: ChatIntent;
  predictedTier: string;
  clarifier?: string;
  latencyMs: number;
  retried: boolean;
  confidence?: number;
  flagReasons: string[];
  passed: boolean;
}

export interface BenchResult {
  summary: {
    total: number;
    passed: number;
    failed: number;
    axis: Axis;
    scenarioRecap: string;
    timestampIso: string;
  };
  rows: BenchResultRow[];
  failures: FailureRow[];
  outputs: { jsonPath: string | null; csvPath: string | null };
}

function hasNamedGuest(fixture: Fixture): boolean {
  return fixture.activeSessionsSummary.length > 0;
}

function fixtureHasTopicHints(fixture: Fixture): boolean {
  return /topic:/i.test(fixture.activeSessionsSummary);
}

// Returns true when the utterance contains an explicit scheduling signal —
// a guest name from the fixture or a clear scheduling verb. Used to
// distinguish "schedule Jon" (should not be unclear) from "move it"
// (legitimately unclear even with context).
function hasExplicitSchedulingSignal(utterance: string, fixture: Fixture): boolean {
  const lower = utterance.toLowerCase();
  // Extract guest names from activeSessionsSummary lines like "- John + Bob — guest: Bob"
  const guestMatches = Array.from(fixture.activeSessionsSummary.matchAll(/guest:\s*(\w+)/gi));
  for (const m of guestMatches) {
    if (lower.includes(m[1].toLowerCase())) return true;
  }
  // Clear scheduling verbs that don't need pronoun resolution
  return /\b(schedule|book|set up|arrange|add)\b/i.test(utterance);
}

function computeFlagReasons(
  row: Omit<BenchResultRow, "flagReasons" | "passed">,
  fixture: Fixture,
): string[] {
  const reasons: string[] = [];
  const predicted = row.predictedTier;
  const expected = row.expectedTier;

  if (expected && predicted !== expected) {
    reasons.push(`expected ${expected}, got ${predicted}`);
  }

  if (
    predicted === "unclear" &&
    hasNamedGuest(fixture) &&
    fixtureHasTopicHints(fixture) &&
    hasExplicitSchedulingSignal(row.utterance, fixture)
  ) {
    reasons.push("predicted unclear despite explicit scheduling signal in utterance");
  }

  if (row.clarifier) {
    const lower = row.clarifier.toLowerCase();
    for (const marker of FABRICATION_MARKERS) {
      if (lower.includes(marker)) {
        reasons.push(`clarifier contains fabrication marker: "${marker}"`);
        break;
      }
    }
  }

  if (
    typeof row.confidence === "number" &&
    row.confidence < HIGH_CONFIDENCE_THRESHOLD &&
    expected
  ) {
    reasons.push(
      `confidence ${row.confidence.toFixed(2)} below ${HIGH_CONFIDENCE_THRESHOLD} on expected-high-confidence fixture`,
    );
  }

  return reasons;
}

function toCsv(rows: BenchResultRow[]): string {
  const header = [
    "utterance",
    "axis",
    "expectedTier",
    "predictedTier",
    "clarifier",
    "latencyMs",
    "retried",
    "confidence",
    "passed",
    "flagReasons",
  ].join(",");
  const escape = (v: unknown): string => {
    if (v === undefined || v === null) return "";
    const s = String(v).replace(/"/g, '""');
    return `"${s}"`;
  };
  const body = rows.map((r) =>
    [
      escape(r.utterance),
      escape(r.axis),
      escape(r.expectedTier ?? ""),
      escape(r.predictedTier),
      escape(r.clarifier ?? ""),
      escape(r.latencyMs),
      escape(r.retried),
      escape(r.confidence ?? ""),
      escape(r.passed),
      escape(r.flagReasons.join("; ")),
    ].join(","),
  );
  return [header, ...body].join("\n");
}

export async function runBench(args: RunBenchArgs): Promise<BenchResult> {
  const count = Math.max(1, Math.min(args.count ?? DEFAULT_COUNT, HARD_MAX_COUNT));
  const axis = args.axis;

  const fixture = await buildFixture(args.scenario);
  const ctx = fixtureToClassifyContext(fixture);

  let corpus: GeneratedUtterance[] = [];
  try {
    corpus = await generateCorpus({ axis, count, fixture });
  } catch (err) {
    console.error("[bench-intent] corpus generation failed:", err);
  }

  const rows: BenchResultRow[] = [];

  for (const item of corpus) {
    try {
      const result = await classifyChatIntent(item.utterance, ctx);
      const predicted = result.intent.kind;
      const clarifier = result.intent.clarifier;
      const confidence: number | undefined = undefined; // classifier doesn't expose one

      const partial = {
        utterance: item.utterance,
        axis: item.axis,
        expectedTier: item.expectedTier,
        predictedTier: predicted,
        clarifier,
        latencyMs: result.latencyMs,
        retried: result.retried,
        confidence,
      } as const;

      const flagReasons = computeFlagReasons(partial, fixture);
      rows.push({ ...partial, flagReasons, passed: flagReasons.length === 0 });
    } catch (err) {
      rows.push({
        utterance: item.utterance,
        axis: item.axis,
        expectedTier: item.expectedTier,
        predictedTier: "error",
        clarifier: undefined,
        latencyMs: 0,
        retried: false,
        confidence: undefined,
        flagReasons: [`classifier threw: ${(err as Error).message}`],
        passed: false,
      });
    }
  }

  const failures: FailureRow[] = rows
    .filter((r) => !r.passed)
    .map((r) => ({
      utterance: r.utterance,
      axis: r.axis,
      predictedTier: r.predictedTier,
      expectedTier: r.expectedTier,
      confidence: r.confidence,
      clarifier: r.clarifier,
      flagReasons: r.flagReasons,
      recap: fixture.recap,
    }));

  const result: BenchResult = {
    summary: {
      total: rows.length,
      passed: rows.filter((r) => r.passed).length,
      failed: failures.length,
      axis,
      scenarioRecap: fixture.recap,
      timestampIso: new Date().toISOString(),
    },
    rows,
    failures,
    outputs: { jsonPath: null, csvPath: null },
  };

  if (!args.skipWrite) {
    const outDir = args.outDir ?? defaultOutDir();
    mkdirSync(outDir, { recursive: true });
    const jsonPath = join(outDir, "latest-results.json");
    const csvPath = join(outDir, "latest-results.csv");
    writeFileSync(jsonPath, JSON.stringify(result, null, 2), "utf-8");
    writeFileSync(csvPath, toCsv(rows), "utf-8");
    result.outputs = { jsonPath, csvPath };
  }

  return result;
}

function defaultOutDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "out");
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): {
  scenarioRaw: string;
  axis: string;
  count: number;
  scheduling: boolean;
} {
  let scenarioRaw = "";
  let axis = "mixed adversarial";
  let count = DEFAULT_COUNT;
  let scheduling = false;

  for (const arg of argv) {
    if (arg.startsWith("--scenario=")) scenarioRaw = arg.slice("--scenario=".length);
    else if (arg.startsWith("--axis=")) axis = arg.slice("--axis=".length);
    else if (arg.startsWith("--count=")) count = Number(arg.slice("--count=".length));
    else if (arg === "--scheduling") scheduling = true;
  }

  return { scenarioRaw, axis, count, scheduling };
}

function parseScenario(raw: string): ScenarioSeed {
  const trimmed = raw.trim();
  if (!trimmed) return { kind: "preset", name: "empty-new-host" };
  if (isPresetName(trimmed)) return { kind: "preset", name: trimmed };
  // Accept a JSON blob for structured seeds.
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as { preset?: string; text?: string };
      if (parsed.preset && isPresetName(parsed.preset)) {
        return { kind: "preset", name: parsed.preset };
      }
      if (parsed.text) return { kind: "adhoc", text: parsed.text };
    } catch {
      // fall through
    }
  }
  return { kind: "adhoc", text: trimmed };
}

async function main() {
  const { scenarioRaw, axis, count, scheduling } = parseArgs(process.argv.slice(2));
  if (!isAxis(axis)) {
    console.error(`Unknown axis: "${axis}". Falling back to "mixed adversarial".`);
  }
  const chosenAxis: Axis = isAxis(axis) ? axis : "mixed adversarial";
  const scenario = parseScenario(scenarioRaw);

  console.log(
    `[bench-intent] scenario=${JSON.stringify(scenario)} axis="${chosenAxis}" count=${count} scheduling=${scheduling}`,
  );

  if (scheduling) {
    console.warn(
      "[bench-intent] --scheduling pass is a no-op in v1; classifier-only pipeline runs.",
    );
  }

  const result = await runBench({
    scenario,
    axis: chosenAxis,
    count,
    scheduling,
  });

  console.log(
    `[bench-intent] done: ${result.summary.passed}/${result.summary.total} passed, ${result.summary.failed} flagged.`,
  );
  if (result.outputs.jsonPath) {
    console.log(`[bench-intent] json: ${result.outputs.jsonPath}`);
    console.log(`[bench-intent] csv:  ${result.outputs.csvPath}`);
  }
}

// Only run main() when invoked directly (not when imported by tests).
const isDirectInvocation =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("run.ts") ||
  process.argv[1]?.endsWith("run.js");

if (isDirectInvocation) {
  main().catch((err) => {
    console.error("[bench-intent] fatal:", err);
    process.exit(1);
  });
}
