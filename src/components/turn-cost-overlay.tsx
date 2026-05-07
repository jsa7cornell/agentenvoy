"use client";

/**
 * Admin-only cost telemetry overlay for unified-agent turns.
 *
 * Renders beneath an envoy chat bubble when:
 *   1. The viewer is an admin (isAdmin prop).
 *   2. The message metadata contains a `unifiedTurn` block (written by runner.ts).
 *
 * Display is minimal by design — a single collapsed chip that expands on click.
 * Shows: model tier, tool calls made, duration, and USD cost.
 * Invisible to non-admins and to turns from the legacy pipeline.
 */

import { useState } from "react";

type UnifiedTurnMeta = {
  model: string;
  tier: "fast" | "default" | "deep";
  toolCalls: string[];
  durationMs: number;
  selfCheck: { passed: boolean; flaggedTools?: string[]; reason?: string };
  cost: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    costUsd: number;
  };
};

type Props = {
  metadata: Record<string, unknown> | null | undefined;
  isAdmin: boolean;
};

export function TurnCostOverlay({ metadata, isAdmin }: Props) {
  const [expanded, setExpanded] = useState(false);

  if (!isAdmin) return null;
  const turn = metadata?.unifiedTurn as UnifiedTurnMeta | undefined;
  if (!turn) return null;

  const costStr = turn.cost.costUsd < 0.001
    ? `< $0.001`
    : `$${turn.cost.costUsd.toFixed(4)}`;

  const tierColor =
    turn.tier === "deep"
      ? "text-amber-400"
      : turn.tier === "fast"
      ? "text-emerald-400"
      : "text-sky-400";

  return (
    <div className="mt-1 ml-1">
      <button
        onClick={() => setExpanded((e) => !e)}
        className="flex items-center gap-1.5 text-[10px] text-zinc-500 dark:text-zinc-500 hover:text-zinc-400 transition font-mono"
        aria-label="Toggle turn cost details"
      >
        <span className={`font-semibold ${tierColor}`}>{turn.tier}</span>
        <span>·</span>
        <span>{costStr}</span>
        <span>·</span>
        <span>{turn.durationMs}ms</span>
        {!turn.selfCheck.passed && (
          <>
            <span>·</span>
            <span className="text-red-400 font-semibold">⚠ check</span>
          </>
        )}
        <span className="text-zinc-600 dark:text-zinc-600">{expanded ? "▲" : "▼"}</span>
      </button>

      {expanded && (
        <div className="mt-1 bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-lg p-2 text-[10px] font-mono text-zinc-500 dark:text-zinc-400 space-y-1">
          <Row label="model" value={turn.model} />
          <Row label="in" value={`${turn.cost.inputTokens.toLocaleString()} tok`} />
          <Row label="out" value={`${turn.cost.outputTokens.toLocaleString()} tok`} />
          <Row label="cost" value={costStr} />
          <Row label="ms" value={String(turn.durationMs)} />
          {turn.toolCalls.length > 0 && (
            <Row label="tools" value={turn.toolCalls.join(", ")} />
          )}
          {!turn.selfCheck.passed && (
            <>
              <Row label="flagged" value={(turn.selfCheck.flaggedTools ?? []).join(", ")} />
              <Row label="reason" value={turn.selfCheck.reason ?? ""} />
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <span className="text-zinc-600 dark:text-zinc-600 w-12 shrink-0">{label}</span>
      <span className="break-all">{value}</span>
    </div>
  );
}
