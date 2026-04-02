/**
 * AgentEnvoy Eval Runner
 *
 * Runs test cases against the playbook-composed prompt system.
 * Usage:
 *   npx tsx src/agent/evals/run.ts              # run all cases
 *   npx tsx src/agent/evals/run.ts --dry-run    # validate without API calls
 *   npx tsx src/agent/evals/run.ts --compare sonnet,haiku  # compare models
 */

import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { composeSystemPrompt, getModelForDomain, getPlaybookInfo } from "../composer";
import type { DomainType } from "../composer";

// --- Types ---

interface EvalAssertion {
  type: "contains" | "not_contains" | "contains_any" | "max_length";
  value?: string | number;
  values?: string[];
}

interface EvalCase {
  name: string;
  description: string;
  domain: DomainType;
  context: {
    role?: string;
    hostName: string;
    guestName?: string;
    guestEmail?: string;
    topic?: string;
    rules?: Record<string, unknown>;
    hostPreferences?: Record<string, unknown>;
    availableSlots?: Array<{ start: string; end: string }>;
  };
  trigger: string; // "greeting" | message content
  assertions: EvalAssertion[];
}

interface EvalResult {
  name: string;
  passed: boolean;
  assertions: Array<{
    type: string;
    expected: string;
    passed: boolean;
    detail?: string;
  }>;
  response?: string;
  model: string;
  tokens?: number;
  latencyMs?: number;
}

// --- Load test cases ---

function loadCases(): EvalCase[] {
  const casesDir = join(__dirname, "cases");
  const files = readdirSync(casesDir).filter((f) => f.endsWith(".json"));
  return files.map((f) => JSON.parse(readFileSync(join(casesDir, f), "utf-8")));
}

// --- Check assertions ---

function checkAssertion(response: string, assertion: EvalAssertion): { passed: boolean; detail: string } {
  const lower = response.toLowerCase();

  switch (assertion.type) {
    case "contains":
      return {
        passed: lower.includes(String(assertion.value).toLowerCase()),
        detail: `looking for "${assertion.value}"`,
      };

    case "not_contains":
      return {
        passed: !lower.includes(String(assertion.value).toLowerCase()),
        detail: `should NOT contain "${assertion.value}"`,
      };

    case "contains_any":
      const found = (assertion.values || []).some((v) => lower.includes(v.toLowerCase()));
      return {
        passed: found,
        detail: `looking for any of: ${(assertion.values || []).join(", ")}`,
      };

    case "max_length":
      return {
        passed: response.length <= Number(assertion.value),
        detail: `length ${response.length} vs max ${assertion.value}`,
      };

    default:
      return { passed: false, detail: `unknown assertion type: ${assertion.type}` };
  }
}

// --- Run a single eval case ---

async function runCase(evalCase: EvalCase, modelOverride?: string): Promise<EvalResult> {
  const model = modelOverride || getModelForDomain(evalCase.domain);

  const systemPrompt = composeSystemPrompt({
    domain: evalCase.domain,
    hostName: evalCase.context.hostName,
    hostPreferences: evalCase.context.hostPreferences,
    guestName: evalCase.context.guestName,
    guestEmail: evalCase.context.guestEmail,
    topic: evalCase.context.topic,
    rules: evalCase.context.rules,
    availableSlots: evalCase.context.availableSlots,
    role: evalCase.context.role,
  });

  const userMessage =
    evalCase.trigger === "greeting"
      ? "A new visitor just opened the deal room. Generate your initial greeting following your greeting strategy. Use all context you have — name, topic, format, timing, available slots. Propose specific times if you have calendar data and preferences. Be efficient."
      : evalCase.trigger;

  const start = Date.now();

  const { text, usage } = await generateText({
    model: anthropic(model),
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
  });

  const latencyMs = Date.now() - start;

  const assertionResults = evalCase.assertions.map((a) => {
    const result = checkAssertion(text, a);
    return {
      type: a.type,
      expected: String(a.value || a.values?.join(", ") || ""),
      passed: result.passed,
      detail: result.detail,
    };
  });

  return {
    name: evalCase.name,
    passed: assertionResults.every((a) => a.passed),
    assertions: assertionResults,
    response: text,
    model,
    tokens: usage?.totalTokens,
    latencyMs,
  };
}

// --- Main ---

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const compareIdx = args.indexOf("--compare");
  const compareModels = compareIdx >= 0 ? args[compareIdx + 1]?.split(",") : null;

  const cases = loadCases();
  console.log(`\nLoaded ${cases.length} eval cases`);

  // Show playbook status
  const info = getPlaybookInfo();
  console.log("Playbooks:", Object.entries(info).map(([k, v]) => `${k}: ${v.loaded ? "OK" : "MISSING"} (${v.length} chars)`).join(", "));

  if (dryRun) {
    console.log("\n--- DRY RUN (no API calls) ---\n");
    for (const c of cases) {
      const prompt = composeSystemPrompt({
        domain: c.domain,
        hostName: c.context.hostName,
        hostPreferences: c.context.hostPreferences,
        guestName: c.context.guestName,
        guestEmail: c.context.guestEmail,
        topic: c.context.topic,
        rules: c.context.rules,
        availableSlots: c.context.availableSlots,
        role: c.context.role,
      });
      console.log(`${c.name}`);
      console.log(`  Domain: ${c.domain} | Assertions: ${c.assertions.length} | Prompt: ${prompt.length} chars`);
    }
    console.log("\nAll cases validated. Prompt composition working.");
    return;
  }

  const models = compareModels || [null]; // null = use default per domain

  for (const model of models) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(model ? `Model: ${model}` : "Model: default per domain");
    console.log("=".repeat(60));

    let passed = 0;
    let failed = 0;

    for (const evalCase of cases) {
      const modelId = model
        ? model === "sonnet" ? "claude-sonnet-4-6"
        : model === "haiku" ? "claude-haiku-4-5-20251001"
        : model
        : undefined;

      try {
        const result = await runCase(evalCase, modelId);

        const status = result.passed ? "PASS" : "FAIL";
        const icon = result.passed ? "\u2713" : "\u2717";
        console.log(`\n${icon} [${status}] ${result.name} (${result.latencyMs}ms, ${result.tokens} tokens)`);

        if (!result.passed) {
          for (const a of result.assertions) {
            if (!a.passed) {
              console.log(`    FAILED: ${a.type} — ${a.detail}`);
            }
          }
          // Show first 200 chars of response for debugging
          console.log(`    Response: "${result.response?.slice(0, 200)}..."`);
          failed++;
        } else {
          passed++;
        }
      } catch (e) {
        console.log(`\n\u2717 [ERROR] ${evalCase.name}: ${e}`);
        failed++;
      }
    }

    console.log(`\n--- Score: ${passed}/${passed + failed} passed ---`);
  }
}

main().catch(console.error);
