/**
 * Smoke test for the /bench-intent runner.
 *
 * Does NOT exercise the Haiku corpus-gen path or the live classifier —
 * both are mocked. The point of this test is to assert the scaffolding
 * (fixture builder, output files, summary counts) works; real corpus
 * quality is what the manual `/bench-intent` invocation is for.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Mock the LLM-calling corpus generator so the test doesn't hit the Anthropic API.
vi.mock("../../../scripts/bench-intent/corpus-gen", () => ({
  AXES: [
    "short affirmatives after Envoy clarifier",
    "bare-noun continuations",
    "echo of prior envoy reply",
    "multi-intent conjunctions",
    "ambiguous pronouns",
    "off-topic injections",
    "mixed adversarial",
  ],
  isAxis: () => true,
  generateCorpus: vi.fn(async ({ count }: { count: number }) =>
    Array.from({ length: count }, (_, i) => ({
      utterance: `utterance ${i}`,
      expectedTier: "schedule" as const,
      axis: "mixed adversarial" as const,
      rationale: "smoke",
    })),
  ),
}));

// Mock the classifier — don't hit the gateway.
vi.mock("@/agent/intent-classifier", () => ({
  classifyChatIntent: vi.fn(async () => ({
    intent: { kind: "schedule" as const },
    latencyMs: 5,
    retried: false,
    rawKind: "schedule",
  })),
}));

import { runBench } from "../../../scripts/bench-intent/run";

describe("runBench smoke", () => {
  let outDir: string;

  beforeEach(() => {
    outDir = mkdtempSync(join(tmpdir(), "bench-intent-"));
  });

  afterEach(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  it("writes json + csv and produces summary counts matching N", async () => {
    const result = await runBench({
      scenario: { kind: "preset", name: "empty-new-host" },
      axis: "mixed adversarial",
      count: 3,
      outDir,
    });

    expect(result.summary.total).toBe(3);
    expect(result.summary.passed + result.summary.failed).toBe(3);

    expect(result.outputs.jsonPath).toBeTruthy();
    expect(result.outputs.csvPath).toBeTruthy();
    expect(existsSync(result.outputs.jsonPath!)).toBe(true);
    expect(existsSync(result.outputs.csvPath!)).toBe(true);

    const json = JSON.parse(readFileSync(result.outputs.jsonPath!, "utf-8"));
    expect(json.rows).toHaveLength(3);
    expect(json.summary.total).toBe(3);

    const csv = readFileSync(result.outputs.csvPath!, "utf-8");
    expect(csv.split("\n")).toHaveLength(4); // header + 3 rows
  });

  it("does not crash on empty corpus (generator returns zero utterances)", async () => {
    const { generateCorpus } = await import("../../../scripts/bench-intent/corpus-gen");
    (generateCorpus as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

    const result = await runBench({
      scenario: { kind: "preset", name: "empty-new-host" },
      axis: "mixed adversarial",
      count: 3,
      outDir,
    });

    expect(result.summary.total).toBe(0);
    expect(result.summary.failed).toBe(0);
    expect(result.failures).toHaveLength(0);
  });
});
