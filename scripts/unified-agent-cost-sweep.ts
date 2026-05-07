/**
 * Unified agent cost dry-sweep — Day 7 pre-launch gate.
 *
 * Runs 20 representative turns through the unified agent pipeline and
 * captures per-turn token usage + USD cost from the response metadata.
 * Compares against static legacy-path baselines to compute cost ratios.
 *
 * Launch gate (per proposal §"Pre-launch gates"):
 *   median cost ratio ≤ 2.0x legacy
 *   p95 cost ratio ≤ 3.0x legacy
 *
 * Usage:
 *   op run --env-file=.env.tpl -- npx tsx scripts/unified-agent-cost-sweep.ts
 *
 * Requires:
 *   - UNIFIED_AGENT_ENABLED=true in env (or set below in override)
 *   - A real user/channel in the DB (or use SWEEP_USER_ID + SWEEP_CHANNEL_ID)
 *   - Anthropic API key via 1Password env template
 *
 * Output: cost-sweep-{timestamp}.json in scripts/out/
 */

import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { prisma } from "@/lib/prisma";
import { runUnifiedAgent, type UnifiedAgentContext } from "@/agent/unified/runner";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SWEEP_USER_ID = process.env.SWEEP_USER_ID ?? "sweep-test-user";
const SWEEP_CHANNEL_ID = process.env.SWEEP_CHANNEL_ID ?? "sweep-test-channel";
const SWEEP_TIMEZONE = "America/Los_Angeles";
const SWEEP_USERNAME = "Sweep Test";

// Legacy path static baselines (USD per turn, from static analysis 2026-05-06).
// These are conservative estimates; real cost varies by history length.
const LEGACY_BASELINES: Record<string, number> = {
  event_action: 0.0000617,  // haiku classifier + calendar-event-composer (Sonnet)
  inquire:       0.0000075,  // haiku classifier + inquire-composer (small Sonnet)
  rule:          0.0000350,  // haiku classifier + calendar-rule-composer (Sonnet)
  manage_setup:  0.0000200,  // haiku classifier + manage-setup-composer (Sonnet)
  chat:          0.0000075,  // haiku classifier + inquire-composer (small Sonnet)
};

// ---------------------------------------------------------------------------
// Fixture turns (20 representative messages)
// ---------------------------------------------------------------------------

type Fixture = {
  message: string;
  category: keyof typeof LEGACY_BASELINES;
  description: string;
};

const FIXTURES: Fixture[] = [
  // --- Readonly / inquire (6) ---
  { message: "What's on my calendar tomorrow?", category: "inquire", description: "calendar query" },
  { message: "How many pending sessions do I have?", category: "inquire", description: "session count" },
  { message: "What are my current booking links?", category: "inquire", description: "link list" },
  { message: "What are my business hours set to?", category: "inquire", description: "prefs query" },
  { message: "Am I free on Friday afternoon?", category: "inquire", description: "availability check" },
  { message: "What does my primary link URL look like?", category: "inquire", description: "link URL recall" },

  // --- Link creation (3) ---
  { message: "Create a 30-minute coffee chat link for weekday mornings 9-11am.", category: "event_action", description: "link create explicit" },
  { message: "Set up a new intro call link, video, 20 minutes.", category: "event_action", description: "link create concise" },
  { message: "I want a coaching link for Tuesday afternoons 2-4pm, 45 minutes, video.", category: "event_action", description: "link create full" },

  // --- Session management (3) ---
  { message: "Show me my active sessions.", category: "event_action", description: "session list" },
  { message: "Archive all my unconfirmed sessions.", category: "event_action", description: "bulk archive" },
  { message: "Move Sarah's coffee chat to Thursday at 3pm.", category: "event_action", description: "session retime" },

  // --- Rule management (3) ---
  { message: "Block every Friday afternoon from 1pm to 5pm.", category: "rule", description: "rule add block" },
  { message: "Set my business hours to 9am to 6pm.", category: "manage_setup", description: "prefs update hours" },
  { message: "Give me 15 minutes of buffer between meetings.", category: "manage_setup", description: "prefs update buffer" },

  // --- Multi-step / complex (3) ---
  { message: "Create a consulting link: 60 minutes, video, Monday and Wednesday mornings 10am to noon.", category: "event_action", description: "link create complex" },
  { message: "I'm usually based in New York but traveling to London this week.", category: "chat", description: "knowledge write" },
  { message: "What's the URL for my coffee chat link?", category: "inquire", description: "link URL named recall" },

  // --- Chat / general (2) ---
  { message: "How does sharing a booking link work?", category: "chat", description: "product question" },
  { message: "What's my default meeting duration?", category: "inquire", description: "prefs query duration" },
];

// ---------------------------------------------------------------------------
// Stream consumer — reads NDJSON response, returns final text + cost metadata
// ---------------------------------------------------------------------------

async function consumeStream(stream: ReadableStream<Uint8Array>): Promise<{
  text: string;
  unifiedTurn?: {
    cost: { costUsd: number; inputTokens: number; outputTokens: number };
    durationMs: number;
    toolCalls: string[];
    tier: string;
  };
}> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let text = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const frame = JSON.parse(line) as { type: string; content?: string };
        if (frame.type === "text") text = frame.content ?? "";
      } catch { /* malformed frame */ }
    }
  }

  // Fetch the metadata from the most recent envoy message in the channel.
  const lastEnvoy = await prisma.channelMessage.findFirst({
    where: { channelId: SWEEP_CHANNEL_ID, role: "envoy" },
    orderBy: { createdAt: "desc" },
    select: { metadata: true },
  });

  const meta = lastEnvoy?.metadata as Record<string, unknown> | null;
  const unifiedTurn = meta?.unifiedTurn as {
    cost: { costUsd: number; inputTokens: number; outputTokens: number };
    durationMs: number;
    toolCalls: string[];
    tier: string;
  } | undefined;

  return { text, unifiedTurn };
}

// ---------------------------------------------------------------------------
// Percentile helper
// ---------------------------------------------------------------------------

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(i, sorted.length - 1))];
}

// ---------------------------------------------------------------------------
// Main sweep
// ---------------------------------------------------------------------------

async function main() {
  console.log(`\nUnified Agent Cost Dry-Sweep — ${new Date().toISOString()}`);
  console.log(`User: ${SWEEP_USER_ID} | Channel: ${SWEEP_CHANNEL_ID}\n`);

  // Ensure sweep channel exists (or create a stub user/channel).
  // In a real run this would use a real test account.
  // Here we note that the runner persists messages — clean up after.
  const results: Array<{
    fixture: Fixture;
    costUsd: number;
    legacyBaseline: number;
    ratio: number;
    inputTokens: number;
    outputTokens: number;
    durationMs: number;
    toolCalls: string[];
    tier: string;
    passed: boolean;
  }> = [];

  for (let i = 0; i < FIXTURES.length; i++) {
    const fixture = FIXTURES[i];
    console.log(`[${i + 1}/${FIXTURES.length}] ${fixture.description}`);

    const ctx: UnifiedAgentContext = {
      userId: SWEEP_USER_ID,
      channelId: SWEEP_CHANNEL_ID,
      timezone: SWEEP_TIMEZONE,
      userName: SWEEP_USERNAME,
      message: fixture.message,
      isAdmin: false,
    };

    try {
      const stream = runUnifiedAgent(ctx);
      const { unifiedTurn } = await consumeStream(stream);

      if (!unifiedTurn) {
        console.log(`  ⚠ no unifiedTurn metadata found (pipeline may not be active)`);
        continue;
      }

      const legacyBaseline = LEGACY_BASELINES[fixture.category];
      const ratio = unifiedTurn.cost.costUsd / legacyBaseline;
      const passed = ratio <= 3.0;

      results.push({
        fixture,
        costUsd: unifiedTurn.cost.costUsd,
        legacyBaseline,
        ratio,
        inputTokens: unifiedTurn.cost.inputTokens,
        outputTokens: unifiedTurn.cost.outputTokens,
        durationMs: unifiedTurn.durationMs,
        toolCalls: unifiedTurn.toolCalls,
        tier: unifiedTurn.tier,
        passed,
      });

      console.log(`  cost: $${unifiedTurn.cost.costUsd.toFixed(5)} | ratio: ${ratio.toFixed(2)}x | ${passed ? "✓" : "✗ OVER GATE"}`);
    } catch (err) {
      console.error(`  ✗ error: ${err}`);
    }
  }

  if (results.length === 0) {
    console.log("\nNo results — is UNIFIED_AGENT_ENABLED=true and the DB accessible?\n");
    process.exit(1);
  }

  // --- Summary ---
  const ratios = [...results.map((r) => r.ratio)].sort((a, b) => a - b);
  const median = percentile(ratios, 50);
  const p95 = percentile(ratios, 95);
  const medianOk = median <= 2.0;
  const p95Ok = p95 <= 3.0;
  const gatePassed = medianOk && p95Ok;

  console.log(`\n${"─".repeat(60)}`);
  console.log(`RESULTS: ${results.length} turns`);
  console.log(`  Median cost ratio: ${median.toFixed(2)}x legacy  ${medianOk ? "✓ ≤2.0x" : "✗ OVER GATE (>2.0x)"}`);
  console.log(`  p95 cost ratio:    ${p95.toFixed(2)}x legacy  ${p95Ok ? "✓ ≤3.0x" : "✗ OVER GATE (>3.0x)"}`);
  console.log(`  Launch gate:       ${gatePassed ? "PASSED ✓" : "FAILED ✗"}`);
  console.log(`${"─".repeat(60)}\n`);

  // --- Write JSON output ---
  const outDir = join(import.meta.dirname, "out");
  mkdirSync(outDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = join(outDir, `cost-sweep-${timestamp}.json`);
  writeFileSync(outPath, JSON.stringify({ median, p95, gatePassed, results }, null, 2));
  console.log(`Output written to: ${outPath}\n`);

  process.exit(gatePassed ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
