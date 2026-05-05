/**
 * /bench-modules runner.
 *
 * Pipes `ModuleFixture[]` through `runModule(...)` with the real Sonnet API
 * (gateway or BENCH_DIRECT). Captures: prose, parsed actions, fired guards,
 * tool calls, retry behavior. Asserts the captured output matches each
 * fixture's `expected` block.
 *
 * Invocation:
 *   op run --env-file=.env.tpl -- npx tsx scripts/bench-modules/run.ts [--module=rule] [--name=F14_reproduction]
 *
 * Env:
 *   - AI_GATEWAY_API_KEY (or BENCH_DIRECT=1 + ANTHROPIC_API_KEY)
 *   - LLM provider keys (BYOK Anthropic via gateway dashboard)
 *
 * Outputs JSON + Markdown summary to scripts/bench-modules/out/.
 */
import { mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { createHash } from "crypto";

import { runModule } from "@/agent/modules";
import type { ModuleGuardRecord } from "@/agent/modules";

import type { BenchOutput, FixtureResult, ModuleFixture } from "./types";

// Eager registry-side-effect import — every module registers at import time
// via `@/agent/modules` index. PR1a registers `chat` smoke only; subsequent
// PRs add the real modules.
import "@/agent/modules";

// Fixture imports — PR1c adds rule (six fixtures from spike).
import { ruleFixtures } from "./fixtures/rule";

const FIXTURES: ModuleFixture[] = [...ruleFixtures];

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

function paramsContainsCheck(
  actual: Record<string, unknown>,
  expected: Record<string, unknown>,
): string[] {
  const failures: string[] = [];
  for (const [k, v] of Object.entries(expected)) {
    if (!(k in actual)) {
      failures.push(`expected params.${k} = ${JSON.stringify(v)}, got <absent>`);
      continue;
    }
    if (typeof v === "object" && v !== null && !Array.isArray(v)) {
      const inner = paramsContainsCheck(
        actual[k] as Record<string, unknown>,
        v as Record<string, unknown>,
      );
      for (const f of inner) failures.push(`params.${k}.${f.replace(/^expected /, "")}`);
    } else if (JSON.stringify(actual[k]) !== JSON.stringify(v)) {
      failures.push(
        `expected params.${k} = ${JSON.stringify(v)}, got ${JSON.stringify(actual[k])}`,
      );
    }
  }
  return failures;
}

function check(fixture: ModuleFixture, captured: {
  text: string;
  parsedActions: ReturnType<typeof Object>;
  moduleGuard: ModuleGuardRecord;
}): string[] {
  const failures: string[] = [];
  const e = fixture.expected;
  const lowerText = captured.text.toLowerCase();

  if (e.actions) {
    for (const exp of e.actions) {
      const matching = (captured.parsedActions as Array<{action: string; params: Record<string, unknown>}>).filter(
        (a) => a.action === exp.action,
      );
      if (matching.length === 0) {
        failures.push(`expected action "${exp.action}" not emitted`);
        continue;
      }
      // Match against ANY emission (modules may emit multiple of the same type).
      const hasMatch = matching.some((a) => {
        const paramFailures = exp.paramsContains
          ? paramsContainsCheck(a.params ?? {}, exp.paramsContains)
          : [];
        const notContainsFailures = exp.paramsNotContains
          ? exp.paramsNotContains.filter((k) => k in (a.params ?? {})).map((k) => `params.${k} should be absent`)
          : [];
        return paramFailures.length === 0 && notContainsFailures.length === 0;
      });
      if (!hasMatch) {
        const reasons: string[] = [];
        const sample = matching[0];
        if (exp.paramsContains) reasons.push(...paramsContainsCheck(sample.params ?? {}, exp.paramsContains));
        if (exp.paramsNotContains) reasons.push(...exp.paramsNotContains.filter((k) => k in (sample.params ?? {})).map((k) => `params.${k} should be absent`));
        failures.push(`action "${exp.action}" emitted but mismatched: ${reasons.join("; ")}`);
      }
    }
  }
  if (e.actionsNotEmitted) {
    for (const banned of e.actionsNotEmitted) {
      if ((captured.parsedActions as Array<{action: string}>).some((a) => a.action === banned)) {
        failures.push(`disallowed action "${banned}" was emitted`);
      }
    }
  }
  if (e.proseContains) {
    for (const phrase of e.proseContains) {
      if (!lowerText.includes(phrase.toLowerCase())) {
        failures.push(`prose missing phrase: "${phrase}"`);
      }
    }
  }
  if (e.proseNotContains) {
    for (const phrase of e.proseNotContains) {
      if (lowerText.includes(phrase.toLowerCase())) {
        failures.push(`prose contains banned phrase: "${phrase}"`);
      }
    }
  }
  if (e.guardsFired) {
    const fired = new Set(captured.moduleGuard.guardsFired.map((g) => g.name));
    for (const exp of e.guardsFired) {
      if (!fired.has(exp.name)) {
        failures.push(`expected guard "${exp.name}" to fire`);
      } else if (exp.phase) {
        const matchingPhase = captured.moduleGuard.guardsFired.find(
          (g) => g.name === exp.name && g.phase === exp.phase,
        );
        if (!matchingPhase) {
          failures.push(`guard "${exp.name}" fired but in wrong phase`);
        }
      }
    }
  }
  if (e.guardsNotFired) {
    const fired = new Set(captured.moduleGuard.guardsFired.map((g) => g.name));
    for (const banned of e.guardsNotFired) {
      if (fired.has(banned)) {
        failures.push(`guard "${banned}" should not have fired`);
      }
    }
  }
  if (typeof e.retryHappened === "boolean") {
    const did = captured.moduleGuard.retryCount > 0;
    if (did !== e.retryHappened) {
      failures.push(`expected retryHappened=${e.retryHappened}, got ${did} (retryCount=${captured.moduleGuard.retryCount})`);
    }
  }
  if (typeof e.exhaustedRetries === "boolean") {
    if (captured.moduleGuard.exhaustedRetries !== e.exhaustedRetries) {
      failures.push(`expected exhaustedRetries=${e.exhaustedRetries}, got ${captured.moduleGuard.exhaustedRetries}`);
    }
  }
  if (typeof e.blockingFallbackShipped === "boolean") {
    const didShip = !!captured.moduleGuard.blockingFallbackShipped;
    if (didShip !== e.blockingFallbackShipped) {
      failures.push(`expected blockingFallbackShipped=${e.blockingFallbackShipped}, got ${didShip}`);
    }
  }
  if (e.toolsCalled) {
    const called = new Set(captured.moduleGuard.toolCalls.map((t) => t.name));
    for (const exp of e.toolsCalled) {
      if (!called.has(exp)) {
        failures.push(`expected tool "${exp}" to be called`);
      }
    }
  }
  if (e.toolsNotCalled) {
    const called = new Set(captured.moduleGuard.toolCalls.map((t) => t.name));
    for (const banned of e.toolsNotCalled) {
      if (called.has(banned)) {
        failures.push(`tool "${banned}" should not have been called`);
      }
    }
  }

  return failures;
}

// ---------------------------------------------------------------------------
// Single fixture run
// ---------------------------------------------------------------------------

async function runFixture(fixture: ModuleFixture): Promise<FixtureResult> {
  const start = Date.now();
  try {
    const result = await runModule({
      surface: fixture.surface,
      intent: fixture.intent,
      moduleContext: fixture.moduleContext,
      matchResult: fixture.matchResult,
      userMessage: fixture.userMessage,
      conversationHistory: fixture.conversationHistory,
      composerInvoker: fixture.composerInvoker,
    });
    if (result.kind !== "buffered") {
      return {
        fixture: fixture.name,
        description: fixture.description,
        passed: false,
        failures: [`runner returned non-buffered result; bench expects buffered`],
        capturedText: "",
        capturedActions: [],
        moduleGuard: { bucket: "?", guardsFired: [], retryCount: 0, retrySucceeded: null, exhaustedRetries: false, toolCalls: [] },
        systemPromptHash: "",
        systemPromptLen: 0,
        durationMs: Date.now() - start,
      };
    }
    const failures = check(fixture, {
      text: result.text,
      parsedActions: result.parsedActions,
      moduleGuard: result.moduleGuard,
    });
    return {
      fixture: fixture.name,
      description: fixture.description,
      passed: failures.length === 0,
      failures,
      capturedText: result.text.length > 600 ? result.text.slice(0, 600) + "..." : result.text,
      capturedActions: result.parsedActions,
      moduleGuard: result.moduleGuard,
      systemPromptHash: createHash("sha1").update(result.systemPrompt).digest("hex").slice(0, 12),
      systemPromptLen: result.systemPrompt.length,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      fixture: fixture.name,
      description: fixture.description,
      passed: false,
      failures: [`runner threw: ${(err as Error).message}`],
      capturedText: "",
      capturedActions: [],
      moduleGuard: { bucket: "?", guardsFired: [], retryCount: 0, retrySucceeded: null, exhaustedRetries: false, toolCalls: [] },
      systemPromptHash: "",
      systemPromptLen: 0,
      durationMs: Date.now() - start,
    };
  }
}

// ---------------------------------------------------------------------------
// Bench orchestration
// ---------------------------------------------------------------------------

interface RunBenchArgs {
  /** Filter by module surface/intent (e.g., "dashboard-host/rule"). */
  module?: string;
  /** Filter by fixture name (substring match). */
  name?: string;
  /** Skip writing files (for tests). */
  skipWrite?: boolean;
  /** Override output dir. */
  outDir?: string;
}

export async function runBench(args: RunBenchArgs = {}): Promise<BenchOutput> {
  let fixtures = FIXTURES;
  if (args.module) {
    fixtures = fixtures.filter((f) => `${f.surface}/${f.intent}` === args.module);
  }
  if (args.name) {
    fixtures = fixtures.filter((f) => f.name.includes(args.name!));
  }

  const results: FixtureResult[] = [];
  for (const fixture of fixtures) {
    process.stdout.write(`[bench-modules] ${fixture.name} ... `);
    const result = await runFixture(fixture);
    results.push(result);
    process.stdout.write(result.passed ? `PASS (${result.durationMs}ms)\n` : `FAIL (${result.durationMs}ms)\n`);
    if (!result.passed) {
      for (const f of result.failures) {
        console.log(`    × ${f}`);
      }
    }
  }

  const summary = {
    total: results.length,
    passed: results.filter((r) => r.passed).length,
    failed: results.filter((r) => !r.passed).length,
    timestampIso: new Date().toISOString(),
    modulesUnderTest: Array.from(new Set(fixtures.map((f) => `${f.surface}/${f.intent}`))),
  };

  const out: BenchOutput = { summary, results };

  if (!args.skipWrite) {
    const here = dirname(fileURLToPath(import.meta.url));
    const outDir = args.outDir ?? join(here, "out");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "latest.json"), JSON.stringify(out, null, 2), "utf-8");
    writeFileSync(join(outDir, "latest.md"), renderMarkdown(out), "utf-8");
  }

  return out;
}

function renderMarkdown(out: BenchOutput): string {
  const lines: string[] = [];
  lines.push(`# bench-modules — ${out.summary.timestampIso}`);
  lines.push("");
  lines.push(`**${out.summary.passed}/${out.summary.total} passed.** (${out.summary.failed} failed)`);
  lines.push(`Modules: ${out.summary.modulesUnderTest.join(", ")}`);
  lines.push("");
  for (const r of out.results) {
    lines.push(`## ${r.passed ? "✅" : "❌"} ${r.fixture}`);
    lines.push(`*${r.description}*`);
    lines.push("");
    if (!r.passed) {
      lines.push("**Failures:**");
      for (const f of r.failures) lines.push(`- ${f}`);
      lines.push("");
    }
    lines.push(`- Duration: ${r.durationMs}ms`);
    lines.push(`- System prompt: ${r.systemPromptLen} chars (sha1: \`${r.systemPromptHash}\`)`);
    lines.push(`- Actions emitted: ${r.capturedActions.length === 0 ? "(none)" : r.capturedActions.map((a) => a.action).join(", ")}`);
    lines.push(`- Guards fired: ${r.moduleGuard.guardsFired.length === 0 ? "(none)" : r.moduleGuard.guardsFired.map((g) => `${g.name} [${g.phase}]`).join(", ")}`);
    lines.push(`- Retry count: ${r.moduleGuard.retryCount}${r.moduleGuard.exhaustedRetries ? " (exhausted)" : ""}`);
    if (r.moduleGuard.toolCalls.length > 0) {
      lines.push(`- Tool calls: ${r.moduleGuard.toolCalls.map((t) => `${t.name} (${t.success ? "ok" : "fail"}, ${t.durationMs}ms)`).join(", ")}`);
    }
    if (r.moduleGuard.blockingFallbackShipped) {
      lines.push(`- **Blocking fallback shipped:** ${r.moduleGuard.blockingFallbackShipped.checkName}`);
    }
    if (r.capturedText) {
      lines.push("");
      lines.push("**Composer prose:**");
      lines.push("```");
      lines.push(r.capturedText);
      lines.push("```");
    }
    lines.push("");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): RunBenchArgs {
  const args: RunBenchArgs = {};
  for (const a of argv) {
    if (a.startsWith("--module=")) args.module = a.slice("--module=".length);
    else if (a.startsWith("--name=")) args.name = a.slice("--name=".length);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await runBench(args);
  console.log("");
  console.log(`[bench-modules] Summary: ${result.summary.passed}/${result.summary.total} passed.`);
  if (result.summary.failed > 0) {
    process.exit(1);
  }
}

const isDirect =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("/run.ts") ||
  process.argv[1]?.endsWith("/run.js");

if (isDirect) {
  main().catch((err) => {
    console.error("[bench-modules] fatal:", err);
    process.exit(1);
  });
}
