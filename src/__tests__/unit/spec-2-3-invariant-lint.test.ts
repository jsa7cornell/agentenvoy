/**
 * SPEC §2.3.1 + §2.3.2 invariant lint — F15 of proposal
 * 2026-05-04_update-time-action-state-drift §4a(iii).
 *
 * Static grep-style assertions over the source tree:
 *
 *  §2.3.1: agreedTime/agreedFormat are valid only when status === "agreed".
 *    - Any writer that sets agreedTime to a non-null value without also
 *      setting status="agreed" → flagged.
 *    - Any writer that flips status away from "agreed" without clearing
 *      agreedTime → flagged.
 *
 *  §2.3.2: calendarEventId is the live-event truth signal.
 *    - Any writer that sets calendarEventId: null outside the cancel-pipeline
 *      (or its tentative-hold cleanup analogue at confirm-pipeline.ts:846)
 *      → flagged.
 *
 * Heuristic, not a full type-aware analyzer. Catches the specific shape
 * the F15 bug had (status flip + calendarEventId silently preserved while
 * agreedTime cleared was the GOOD shape; the bug was the absent invariant
 * acknowledgement). New writers that don't fit the shape will surface here
 * for explicit review.
 */

import { describe, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

const SRC_ROOT = join(process.cwd(), "src");

// Files allowed to set calendarEventId: null. Cancel-pipeline cancels the
// event; confirm-pipeline's tentative-hold cleanup deletes the event before
// nulling it. The actions.ts archive flow nulls when archiving a cancelled
// session (the event is already gone). Anything outside this list is a
// candidate F15-class bug.
const CALENDAR_EVENT_ID_NULL_ALLOWLIST = new Set<string>([
  "src/lib/cancel-pipeline.ts",
  "src/lib/confirm-pipeline.ts", // tentative-hold cleanup at line ~846
  "src/agent/actions.ts", // archive + release_hold flows; review case-by-case
  // /api/negotiate/reschedule/route.ts is a legitimate "delete event then
  // null the column" path — it calls deleteCalendarEvent before nulling at
  // line ~104, the same shape as cancel-pipeline. Distinct from
  // rescheduleSession() in reschedule-pipeline.ts which patches in place.
  "src/app/api/negotiate/reschedule/route.ts",
]);

// Statuses considered "terminal" — a session in these states is dead and the
// SPEC §2.3.1 invariant is interpreted to allow agreedTime to remain as
// historical record (cancel-pipeline.ts:137 doesn't clear it; we don't want
// to retroactively mandate that). The lint only flags transitions to
// non-terminal statuses where stale agreedTime corrupts live UI reads.
const TERMINAL_STATUSES = new Set(["cancelled", "expired"]);
const NON_TERMINAL_FLIPS = new Set([
  "active",
  "proposed",
  "retime_proposed",
  "escalated",
]);

function* walkTs(dir: string): Generator<string> {
  for (const ent of readdirSync(dir)) {
    const full = join(dir, ent);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (ent === "node_modules" || ent === "__tests__" || ent === ".next") continue;
      yield* walkTs(full);
    } else if (full.endsWith(".ts") || full.endsWith(".tsx")) {
      yield full;
    }
  }
}

describe("SPEC §2.3.1 + §2.3.2 invariant lint (F15)", () => {
  it("no writer sets calendarEventId: null outside the allowlist", () => {
    const offenders: Array<{ file: string; line: number; snippet: string }> = [];
    for (const file of walkTs(SRC_ROOT)) {
      const rel = relative(process.cwd(), file);
      if (CALENDAR_EVENT_ID_NULL_ALLOWLIST.has(rel)) continue;
      const text = readFileSync(file, "utf8");
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Catch object-literal writes: `calendarEventId: null` and
        // `calendarEventId: null,` (whitespace-tolerant).
        if (/calendarEventId\s*:\s*null\b/.test(line)) {
          offenders.push({ file: rel, line: i + 1, snippet: line.trim() });
        }
      }
    }
    if (offenders.length > 0) {
      const formatted = offenders
        .map((o) => `  ${o.file}:${o.line}  ${o.snippet}`)
        .join("\n");
      throw new Error(
        `SPEC §2.3.2 violation — calendarEventId: null is only allowed in the cancel-pipeline (or its tentative-hold cleanup analogue). Found writes outside the allowlist:\n${formatted}\n\nIf this is a legitimate new path (e.g. a new cancel-shaped flow), add the file to CALENDAR_EVENT_ID_NULL_ALLOWLIST in this lint with a comment justifying it. If it's a regression of the F15 bug class (handler clears the live-event linkage without going through cancel), fix the writer instead.`,
      );
    }
  });

  it("no writer sets agreedTime to a non-null literal without also setting status=\"agreed\" in the same object literal", () => {
    // Pattern: `agreedTime: <expression that isn't `null`>` followed within
    // the same object literal by a sibling that is NOT `status: "agreed"`.
    // Cheap heuristic — we walk each file and for every line containing
    // `agreedTime:` we look at the surrounding ~10 lines for a sibling
    // status assignment.
    const offenders: Array<{ file: string; line: number; snippet: string }> = [];
    for (const file of walkTs(SRC_ROOT)) {
      const rel = relative(process.cwd(), file);
      const text = readFileSync(file, "utf8");
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const m = line.match(/agreedTime\s*:\s*(.+?)[,}]/);
        if (!m) continue;
        const value = m[1].trim();
        // Allowed: explicit null, undefined, function-arg names that the
        // type system enforces null-checks on (e.g. session.agreedTime
        // pass-through). The lint targets non-null assignments.
        if (value === "null" || value === "undefined") continue;
        // Look at the next ~10 lines for a sibling status assignment.
        const window = lines.slice(i, Math.min(lines.length, i + 12)).join("\n");
        const statusMatch = window.match(/status\s*:\s*"([^"]+)"/);
        if (statusMatch) {
          if (statusMatch[1] !== "agreed") {
            offenders.push({ file: rel, line: i + 1, snippet: line.trim() });
          }
        }
        // No sibling status in the window — likely a partial update; the
        // §2.3.1 invariant is upheld implicitly by the absent-status caller.
        // Not flagged here to avoid noise on legitimate post-confirm patches.
      }
    }
    if (offenders.length > 0) {
      const formatted = offenders
        .map((o) => `  ${o.file}:${o.line}  ${o.snippet}`)
        .join("\n");
      throw new Error(
        `SPEC §2.3.1 violation — agreedTime is being set to a non-null value alongside a status that is not "agreed". This is the failure mode handleUpdateTime had pre-F15 (stale agreedTime + status="proposed" disabling the picker). Fix the writer.\n${formatted}`,
      );
    }
  });

  it("no writer flips status to a non-terminal value without clearing agreedTime in the same object literal", () => {
    // Pattern: `status: "<non-terminal>"` (active / proposed / retime_proposed
    // / escalated) inside a `data: { ... }` object literal of a
    // negotiationSession update, without a sibling `agreedTime: null`.
    // Terminal statuses (cancelled / expired) are exempt — historical
    // agreedTime is preserved as a record of what was agreed before death.
    const offenders: Array<{ file: string; line: number; snippet: string }> = [];
    for (const file of walkTs(SRC_ROOT)) {
      const rel = relative(process.cwd(), file);
      const text = readFileSync(file, "utf8");
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const m = line.match(/^\s*status\s*:\s*"([^"]+)"/);
        if (!m) continue;
        if (!NON_TERMINAL_FLIPS.has(m[1])) continue;
        if (TERMINAL_STATUSES.has(m[1])) continue;
        // Only flag when this is inside a `data: {` block of a session update.
        // Walk back ~15 lines to find the enclosing call.
        const back = lines.slice(Math.max(0, i - 15), i).join("\n");
        // Find the IMMEDIATELY preceding negotiationSession.X( call in the
        // back-window. If it's .create — skip (fresh rows legitimately have
        // status="active" without an agreedTime: null assertion since the
        // default is null). If it's .update or .updateMany — flag.
        const callMatches = [
          ...back.matchAll(/negotiationSession\.(create|update|updateMany|upsert)\s*\(/g),
        ];
        if (callMatches.length === 0) continue;
        const lastCall = callMatches[callMatches.length - 1][1];
        if (lastCall === "create") continue;
        const inSessionDataUpdate =
          /\bdata\s*:\s*\{/.test(back) &&
          !/where\s*:\s*\{[^}]*$/.test(back);
        if (!inSessionDataUpdate) continue;
        // Window the same object literal forward and verify agreedTime: null.
        const window = lines.slice(i, Math.min(lines.length, i + 15)).join("\n");
        if (!/agreedTime\s*:\s*null/.test(window)) {
          offenders.push({ file: rel, line: i + 1, snippet: line.trim() });
        }
      }
    }
    if (offenders.length > 0) {
      const formatted = offenders
        .map((o) => `  ${o.file}:${o.line}  ${o.snippet}`)
        .join("\n");
      throw new Error(
        `SPEC §2.3.1 violation — flipping status to a non-terminal value without clearing agreedTime in the same write. This was the F15 / handleUpdateTime bug pre-2026-04-29 fix; the deal-room reads stale agreedTime as "pending confirm" against the OLD slot, disabling the picker.\n${formatted}\n\nFix: add \`agreedTime: null, agreedFormat: null\` to the update payload.`,
      );
    }
  });
});
