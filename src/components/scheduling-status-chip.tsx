"use client";

/**
 * Scheduling status chip — pinned at the top of the dashboard feed, summarizes
 * the user's current scheduling posture in a single glanceable line:
 *
 *   ⏰ 8:30am–5:30pm · 30m · no buffer · 0 blocks · 3 links
 *
 * V2 PR1 (2026-04-23): read-only. Expand-in-place editing lands in a later
 * PR per proposal `2026-04-23_primary-link-config-convergence` §3.2 pattern (a).
 * Source data: GET /api/me/scheduling-defaults (returns scalars + link/block
 * counts). When the eventual `/api/me/scheduling-state` endpoint ships (V2
 * endpoint refactor), the chip swaps its fetch and nothing else.
 */

import { useEffect, useState } from "react";

interface Status {
  businessHoursStartMinutes: number;
  businessHoursEndMinutes: number;
  defaultDuration: number;
  bufferMinutes: number;
  linkCount: number;
  blockCount: number;
}

/** Format a minute-of-day value — 510 → "8:30am", 540 → "9am". Mirrors the
 *  helper in primary-link-flow.tsx; kept local to avoid a shared util until
 *  a second caller shows up. */
function formatMinutes(m: number): string {
  const h = Math.floor(m / 60);
  const min = m % 60;
  const suffix = h < 12 || h === 24 ? "am" : "pm";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return min === 0
    ? `${h12}${suffix}`
    : `${h12}:${String(min).padStart(2, "0")}${suffix}`;
}

function summaryLine(s: Status): string {
  const hours = `${formatMinutes(s.businessHoursStartMinutes)}–${formatMinutes(s.businessHoursEndMinutes)}`;
  const duration = `${s.defaultDuration}m`;
  const buffer = s.bufferMinutes === 0 ? "no buffer" : `${s.bufferMinutes}m buffer`;
  const blocks = `${s.blockCount} ${s.blockCount === 1 ? "block" : "blocks"}`;
  const links = `${s.linkCount} ${s.linkCount === 1 ? "link" : "links"}`;
  return `${hours} · ${duration} · ${buffer} · ${blocks} · ${links}`;
}

export function SchedulingStatusChip() {
  const [status, setStatus] = useState<Status | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/me/scheduling-defaults")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        setStatus({
          businessHoursStartMinutes: data.businessHoursStartMinutes ?? 540,
          businessHoursEndMinutes: data.businessHoursEndMinutes ?? 1020,
          defaultDuration: data.defaultDuration ?? 30,
          bufferMinutes: data.bufferMinutes ?? 0,
          linkCount: data.linkCount ?? 0,
          blockCount: data.blockCount ?? 0,
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  if (!status) return null;

  return (
    <div
      className="self-center inline-flex items-center gap-2 text-xs text-muted bg-black/5 dark:bg-white/[0.05] rounded-full px-3 py-1.5 border border-secondary/50"
      title="Your current scheduling posture. Tune via the 🔗 primary-link card."
      aria-label="Scheduling status"
    >
      <span aria-hidden="true">⏰</span>
      <span className="tabular-nums">{summaryLine(status)}</span>
    </div>
  );
}
