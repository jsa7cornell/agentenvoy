/**
 * Unified agent runner — single Sonnet call per host turn with tools.
 *
 * Replaces the two-stage Classifier (Haiku) → Composer (Sonnet) pipeline.
 * See proposals/2026-05-06_unified-agent-collapse-classifier-composer.md
 *
 * Response format: NDJSON matching the existing channel/chat/route.ts contract:
 *   {"type":"status","stage":"...","copy":"...","seq":N}   — progress frames
 *   {"type":"text","content":"..."}                        — final envoy text
 */

import { streamText, stepCountIs } from "ai";
import { prisma } from "@/lib/prisma";
import { envoyModel } from "@/lib/model";
import { narrateFinalizeError } from "@/agent/action-narration";
import {
  selectModelForTurn,
  computeTurnCost,
  type TurnCost,
} from "./model-policy";
import { buildUnifiedTools } from "./tools";
import { runSelfCheck, type ToolCallSummary } from "./self-check";
import type { Prisma } from "@prisma/client";

import { unifiedAgentSystemPrompt } from "@/agent/runtime-prompts";

// Loaded once at module init — readFileSync inside, so cached across requests.
const SYSTEM_PROMPT = unifiedAgentSystemPrompt();
const MAX_STEPS = 8; // passed as stopCondition: stepCountIs(MAX_STEPS)

export type UnifiedAgentContext = {
  userId: string;
  channelId: string;
  timezone: string;
  userName: string | null;
  meetSlug?: string;
  message: string;
  isAdmin?: boolean;
};

type EnqueueFn = (chunk: string) => void;

/**
 * Main entry point. Returns a ReadableStream<Uint8Array> matching the
 * existing NDJSON protocol so route.ts can return it directly.
 */
export function runUnifiedAgent(ctx: UnifiedAgentContext): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const enqueue: EnqueueFn = (chunk) => {
        controller.enqueue(encoder.encode(chunk));
      };

      try {
        // Persist user message immediately.
        await prisma.channelMessage.create({
          data: { channelId: ctx.channelId, role: "user", content: ctx.message },
        });

        // Emit thinking frame so UI shows activity.
        emitStatus(enqueue, "thinking", 1);

        // Select model tier.
        const modelSelection = selectModelForTurn({ messageLength: ctx.message.length });

        // Build tool surface for this request (with userMessage for Layer 2 grounding).
        const tools = buildUnifiedTools({
          userId: ctx.userId,
          timezone: ctx.timezone,
          meetSlug: ctx.meetSlug,
          userMessage: ctx.message,
        });

        // Load recent conversation history.
        const recentMessages = await loadRecentHistory(ctx.channelId);

        // Stream the unified agent response.
        const startMs = Date.now();
        const result = streamText({
          model: envoyModel(modelSelection.modelId),
          system: SYSTEM_PROMPT,
          messages: [
            ...recentMessages,
            { role: "user", content: ctx.message },
          ],
          tools,
          stopWhen: stepCountIs(MAX_STEPS),
        });

        // Consume stream — await promises after iteration.
        const [fullText, steps, usage] = await Promise.all([
          result.text,
          result.steps,
          result.usage,
        ]);

        const toolCallNames: string[] = steps.flatMap((step) =>
          step.toolCalls.map((tc) => tc.toolName),
        );
        const toolCallSummaries: ToolCallSummary[] = steps.flatMap((step) =>
          step.toolCalls.map((tc) => ({
            toolName: tc.toolName,
            input: tc.input as Record<string, unknown>,
          })),
        );

        // Layer 4 — self-check (post-stream, fast model).
        // Advisory: logs the result but does not retry in v1 (retry path is Day 5).
        const selfCheckResult = await runSelfCheck(
          toolCallSummaries,
          ctx.message,
          recentMessages,
        );
        if (!selfCheckResult.passed) {
          console.warn(
            "[unified-agent] self-check flagged:",
            selfCheckResult.flaggedTools,
            selfCheckResult.reason,
          );
        }

        const durationMs = Date.now() - startMs;
        const turnCost = computeTurnCost(usage, modelSelection.modelId, modelSelection);

        // Persist envoy message with unified turn metadata.
        await prisma.channelMessage.create({
          data: {
            channelId: ctx.channelId,
            role: "envoy",
            content: fullText,
            metadata: buildUnifiedMetadata({
              turnCost,
              toolCallNames,
              modelId: modelSelection.modelId,
              durationMs,
              selfCheck: selfCheckResult,
            }),
          },
        });

        // Emit the text frame.
        emitText(enqueue, fullText);
        controller.close();

      } catch (err) {
        console.error("[unified-agent] stream error:", err);
        try {
          emitText(enqueue, narrateFinalizeError());
          controller.close();
        } catch {
          try { controller.error(err); } catch { /* already closed */ }
        }
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emitStatus(enqueue: EnqueueFn, stage: string, seq: number): void {
  // Minimal status frame — full copy rotation can be added in Day 6.
  const frame = { type: "status", stage, copy: "Working on it…", seq };
  enqueue(JSON.stringify(frame) + "\n");
}

function emitText(enqueue: EnqueueFn, content: string): void {
  enqueue(JSON.stringify({ type: "text", content }) + "\n");
}

async function loadRecentHistory(
  channelId: string,
): Promise<Array<{ role: "user" | "assistant"; content: string }>> {
  const rows = await prisma.channelMessage.findMany({
    where: { channelId },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: { role: true, content: true },
  });
  // Reverse so oldest-first, map envoy → assistant for AI SDK.
  return rows
    .reverse()
    .map((r) => ({
      role: r.role === "envoy" ? ("assistant" as const) : ("user" as const),
      content: r.content,
    }));
}

function buildUnifiedMetadata(params: {
  turnCost: TurnCost;
  toolCallNames: string[];
  modelId: string;
  durationMs: number;
  selfCheck: { passed: boolean; flaggedTools?: string[]; reason?: string };
}): Prisma.InputJsonValue {
  const { turnCost, toolCallNames, modelId, durationMs, selfCheck } = params;

  // Synthesize moduleGuard.bucket from tool names for corpus continuity.
  // Maps tool name prefixes to logical bucket names understood by the dashboard.
  const bucket = inferBucket(toolCallNames);

  return {
    unifiedTurn: {
      model: modelId,
      tier: turnCost.tier,
      toolCalls: toolCallNames,
      durationMs,
      selfCheck,
      cost: {
        inputTokens: turnCost.inputTokens,
        outputTokens: turnCost.outputTokens,
        cacheReadTokens: turnCost.cacheReadTokens,
        cacheWriteTokens: turnCost.cacheWriteTokens,
        costUsd: turnCost.costUsd,
      },
    },
    // Corpus-compatible bucket so dashboard + feedback pipeline work unchanged.
    moduleGuard: {
      bucket,
      emittedActions: toolCallNames,
    },
  } satisfies Prisma.InputJsonValue;
}

function inferBucket(toolCallNames: string[]): string {
  if (toolCallNames.length === 0) return "chat";
  const first = toolCallNames[0];
  if (first.startsWith("LOAD_")) return "chat"; // read-only, no write bucket
  if (first.startsWith("link_")) return "event_action";
  if (first.startsWith("session_")) return "event_action";
  if (first.startsWith("rule_")) return "rule";
  if (first.startsWith("prefs_")) return "manage_setup";
  if (first.startsWith("knowledge_")) return "profile";
  if (first.startsWith("primary_")) return "manage_setup";
  if (first.startsWith("group_coord_")) return "group_coordination";
  return "chat";
}
