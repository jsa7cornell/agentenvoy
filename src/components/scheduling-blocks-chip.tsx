"use client";

/**
 * Blocks chip — sits with the links chip list under the scheduling
 * status chip. Renders active block-type structured rules and gates
 * deletion behind a confirmation card (proposal
 * `2026-04-23_primary-link-config-convergence` §3.2 + P2: destructive
 * edits confirm, additive edits don't).
 *
 * V2 PR4 (2026-04-23): read + delete only. Creation flows through chat
 * ("block my Fridays after 2") or /dashboard/availability — the LLM
 * parse-rule path already has its own confirmation card, so duplicating
 * it inline here would create drift. In-chip freetext creation is a
 * later PR if it earns its weight.
 *
 * Data source: GET /api/me/blocks, DELETE /api/me/blocks.
 */

import { useCallback, useEffect, useState } from "react";

interface BlockRule {
  id: string;
  originalText: string;
  type: "ongoing" | "recurring" | "temporary" | "one-time";
  action: "block";
  timeStart?: string;
  timeEnd?: string;
  allDay?: boolean;
  daysOfWeek?: number[];
  effectiveDate?: string;
  expiryDate?: string;
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function describe(b: BlockRule): string {
  const bits: string[] = [];
  if (b.daysOfWeek && b.daysOfWeek.length > 0) {
    bits.push(b.daysOfWeek.map((d) => DAY_NAMES[d]).join(" "));
  }
  if (b.allDay) {
    bits.push("all day");
  } else if (b.timeStart && b.timeEnd) {
    bits.push(`${b.timeStart}–${b.timeEnd}`);
  } else if (b.timeStart) {
    bits.push(`after ${b.timeStart}`);
  } else if (b.timeEnd) {
    bits.push(`before ${b.timeEnd}`);
  }
  if (b.expiryDate) {
    bits.push(`until ${b.expiryDate}`);
  }
  return bits.join(" · ") || "unspecified window";
}

export function SchedulingBlocksChip() {
  const [blocks, setBlocks] = useState<BlockRule[] | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/me/blocks");
      if (!r.ok) return;
      const data = await r.json();
      setBlocks(data.blocks ?? []);
    } catch {
      /* non-fatal */
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!blocks) return null;
  // Hide the chip entirely when empty — chip-list should only surface
  // state the user already has. Creation prompts live in chat.
  if (blocks.length === 0) return null;

  async function confirmDelete() {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      const r = await fetch("/api/me/blocks", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ruleId: pendingDelete }),
      });
      if (r.ok) {
        const data = await r.json();
        setBlocks(data.blocks ?? []);
      }
    } catch {
      /* non-fatal */
    } finally {
      setDeleting(false);
      setPendingDelete(null);
    }
  }

  const count = blocks.length;

  return (
    <div
      className="self-center w-full max-w-md rounded-xl border border-secondary/50 bg-black/[0.02] dark:bg-white/[0.03] overflow-hidden"
      aria-label="Scheduling blocks"
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="w-full flex items-center gap-2 text-xs px-3 py-2 hover:bg-black/[0.04] dark:hover:bg-white/[0.04] transition text-left"
      >
        <span aria-hidden="true">🚫</span>
        <span className="flex-1 min-w-0 font-medium text-primary">
          {count} {count === 1 ? "block" : "blocks"}
        </span>
        <span aria-hidden="true" className="text-muted/60">
          {expanded ? "▴" : "▾"}
        </span>
      </button>

      {expanded && (
        <div className="px-3 pb-3 pt-1 flex flex-col gap-2 border-t border-secondary/30">
          {blocks.map((b) => {
            const isPending = pendingDelete === b.id;
            return (
              <div
                key={b.id}
                className="flex flex-col gap-1.5 text-xs rounded-lg bg-black/[0.03] dark:bg-white/[0.03] px-2.5 py-2"
              >
                <div className="flex items-start gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="text-primary truncate" title={b.originalText}>
                      {b.originalText}
                    </div>
                    <div className="text-muted tabular-nums text-[11px] mt-0.5">
                      {describe(b)}
                    </div>
                  </div>
                  {!isPending && (
                    <button
                      type="button"
                      onClick={() => setPendingDelete(b.id)}
                      className="text-[11px] text-rose-400 hover:text-rose-300 px-1.5 py-0.5 rounded transition"
                      aria-label={`Delete block: ${b.originalText}`}
                    >
                      Delete
                    </button>
                  )}
                </div>
                {isPending && (
                  <div className="flex items-center justify-between gap-2 bg-rose-500/5 border border-rose-500/20 rounded-md px-2 py-1.5">
                    <span className="text-[11px] text-rose-300">
                      Delete this block? Availability will reopen.
                    </span>
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => setPendingDelete(null)}
                        disabled={deleting}
                        className="text-[11px] px-2 py-0.5 rounded text-muted hover:text-primary transition"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={confirmDelete}
                        disabled={deleting}
                        className="text-[11px] px-2 py-0.5 rounded bg-rose-500 hover:bg-rose-400 text-white disabled:opacity-50 transition"
                      >
                        {deleting ? "…" : "Delete"}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
          <p className="text-[11px] text-muted mt-1">
            Add a block by telling Envoy in chat — e.g. &ldquo;block my Fridays
            after 2.&rdquo;
          </p>
        </div>
      )}
    </div>
  );
}
