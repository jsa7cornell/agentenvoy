"use client";

/**
 * Scheduling status chip — pinned at the top of the dashboard feed, summarizes
 * the user's current scheduling posture in a single glanceable line:
 *
 *   ⏰ 8:30am–5:30pm · 30m · no buffer · 0 blocks · 3 links
 *
 * V2 PR1 (2026-04-23): read-only.
 * V2 PR2 (2026-04-23): expand-in-place editor — tap to expand, quick-reply
 * rows for hours/duration/buffer plus freetext composer for custom hours.
 * Each change POSTs to `/api/me/scheduling-defaults` immediately and
 * re-reads the chip state so the collapsed pill always reflects truth.
 *
 * See proposal `2026-04-23_primary-link-config-convergence` §3.2 pattern (a).
 * Block/link counts remain read-only here — blocks chip lands in a later PR,
 * links in its own chip-list (§3.2 pattern b).
 *
 * Source data: GET /api/me/scheduling-defaults (scalars + link/block counts).
 * When `/api/me/scheduling-state` eventually ships, the chip swaps its
 * fetch and nothing else.
 */

import { useCallback, useEffect, useState } from "react";
import { parseBusinessHoursRange } from "@/lib/time-parse";

interface Status {
  businessHoursStartMinutes: number;
  businessHoursEndMinutes: number;
  defaultDuration: number;
  bufferMinutes: number;
  linkCount: number;
  blockCount: number;
}

const HOURS_OPTIONS: { label: string; value: string }[] = [
  { label: "8am–4pm", value: "480-960" },
  { label: "9am–5pm", value: "540-1020" },
  { label: "9am–6pm", value: "540-1080" },
  { label: "10am–6pm", value: "600-1080" },
  { label: "Flexible", value: "0-1440" },
];

const DURATION_OPTIONS = [15, 30, 45, 60, 90];
const BUFFER_OPTIONS = [0, 5, 10, 15, 30];

/** Format a minute-of-day value — 510 → "8:30am", 540 → "9am". */
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
  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  // Hours custom-input state — only shown on "Custom…" click.
  const [hoursFreetext, setHoursFreetext] = useState("");
  const [hoursFreetextError, setHoursFreetextError] = useState<string | null>(null);
  const [showHoursFreetext, setShowHoursFreetext] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/me/scheduling-defaults");
      if (!r.ok) return;
      const data = await r.json();
      setStatus({
        businessHoursStartMinutes: data.businessHoursStartMinutes ?? 540,
        businessHoursEndMinutes: data.businessHoursEndMinutes ?? 1020,
        defaultDuration: data.defaultDuration ?? 30,
        bufferMinutes: data.bufferMinutes ?? 0,
        linkCount: data.linkCount ?? 0,
        blockCount: data.blockCount ?? 0,
      });
    } catch {
      /* non-fatal; next load retries */
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await load();
      if (cancelled) return;
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  async function patch(body: Record<string, number>) {
    setSaving(true);
    try {
      const r = await fetch("/api/me/scheduling-defaults", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (r.ok) {
        // Optimistic merge then re-sync from server so counts stay fresh.
        setStatus((prev) => (prev ? { ...prev, ...body } : prev));
        await load();
      }
    } catch {
      /* surface a retry inline if users hit this; not worth a toast today */
    } finally {
      setSaving(false);
    }
  }

  function handleHoursPreset(value: string) {
    const [s, e] = value.split("-").map((n) => parseInt(n, 10));
    if (!Number.isFinite(s) || !Number.isFinite(e)) return;
    setShowHoursFreetext(false);
    void patch({ businessHoursStartMinutes: s, businessHoursEndMinutes: e });
  }

  function handleHoursFreetextSubmit() {
    const parsed = parseBusinessHoursRange(hoursFreetext);
    if (!parsed) {
      setHoursFreetextError(
        'Couldn\'t parse that. Try "8:30 to 5:30" or "9am-6pm" — times must be on the half hour.',
      );
      return;
    }
    setHoursFreetext("");
    setHoursFreetextError(null);
    setShowHoursFreetext(false);
    void patch({
      businessHoursStartMinutes: parsed.startMinutes,
      businessHoursEndMinutes: parsed.endMinutes,
    });
  }

  if (!status) return null;

  // Collapsed — single pill, click to expand.
  if (!expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="self-center inline-flex items-center gap-2 text-xs text-muted bg-black/5 dark:bg-white/[0.05] hover:bg-black/10 dark:hover:bg-white/[0.08] rounded-full px-3 py-1.5 border border-secondary/50 transition"
        title="Tap to edit your scheduling posture"
        aria-label="Scheduling status — tap to edit"
        aria-expanded="false"
      >
        <span aria-hidden="true">⏰</span>
        <span className="tabular-nums">{summaryLine(status)}</span>
        <span aria-hidden="true" className="text-muted/60">▾</span>
      </button>
    );
  }

  // Expanded — editable card. Keep it close to the chip's footprint so it
  // feels like the same object growing, not a dropdown.
  return (
    <div
      className="self-center w-full max-w-md bg-black/[0.03] dark:bg-white/[0.04] rounded-2xl px-4 py-3 border border-secondary/50 flex flex-col gap-3"
      aria-label="Scheduling posture editor"
    >
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted inline-flex items-center gap-2">
          <span aria-hidden="true">⏰</span>
          <span className="tabular-nums">{summaryLine(status)}</span>
        </span>
        <button
          type="button"
          onClick={() => {
            setExpanded(false);
            setShowHoursFreetext(false);
            setHoursFreetext("");
            setHoursFreetextError(null);
          }}
          className="text-xs text-muted hover:text-primary px-2 py-0.5 rounded transition"
          aria-label="Collapse"
        >
          Done
        </button>
      </div>

      {/* Hours */}
      <Row label="Hours">
        <div className="flex flex-wrap gap-1.5">
          {HOURS_OPTIONS.map((opt) => {
            const [s, e] = opt.value.split("-").map((n) => parseInt(n, 10));
            const active =
              status.businessHoursStartMinutes === s &&
              status.businessHoursEndMinutes === e;
            return (
              <Pill
                key={opt.value}
                active={active}
                disabled={saving}
                onClick={() => handleHoursPreset(opt.value)}
              >
                {opt.label}
              </Pill>
            );
          })}
          <Pill
            active={showHoursFreetext}
            disabled={saving}
            onClick={() => {
              setShowHoursFreetext((v) => !v);
              setHoursFreetextError(null);
            }}
          >
            Custom…
          </Pill>
        </div>
        {showHoursFreetext && (
          <form
            onSubmit={(ev) => {
              ev.preventDefault();
              handleHoursFreetextSubmit();
            }}
            className="flex flex-col gap-1.5 mt-2"
          >
            <div className="flex gap-2">
              <input
                type="text"
                autoFocus
                value={hoursFreetext}
                onChange={(ev) => {
                  setHoursFreetext(ev.target.value);
                  if (hoursFreetextError) setHoursFreetextError(null);
                }}
                placeholder="e.g. 8:30 to 5:30"
                className="flex-1 text-xs px-3 py-1.5 rounded-lg border border-indigo-500/30 bg-indigo-500/5 text-primary placeholder:text-primary/40 focus:outline-none focus:border-indigo-500/60"
                disabled={saving}
              />
              <button
                type="submit"
                disabled={saving || !hoursFreetext.trim()}
                className="px-3 py-1.5 bg-purple-600 hover:bg-purple-500 disabled:opacity-40 text-white text-xs font-medium rounded-lg transition"
              >
                Set
              </button>
            </div>
            {hoursFreetextError && (
              <span className="text-[11px] text-rose-400">{hoursFreetextError}</span>
            )}
          </form>
        )}
      </Row>

      {/* Duration */}
      <Row label="Default length">
        <div className="flex flex-wrap gap-1.5">
          {DURATION_OPTIONS.map((d) => (
            <Pill
              key={d}
              active={status.defaultDuration === d}
              disabled={saving}
              onClick={() => void patch({ defaultDuration: d })}
            >
              {d}m
            </Pill>
          ))}
        </div>
      </Row>

      {/* Buffer */}
      <Row label="Buffer">
        <div className="flex flex-wrap gap-1.5">
          {BUFFER_OPTIONS.map((b) => (
            <Pill
              key={b}
              active={status.bufferMinutes === b}
              disabled={saving}
              onClick={() => void patch({ bufferMinutes: b })}
            >
              {b === 0 ? "None" : `${b}m`}
            </Pill>
          ))}
        </div>
      </Row>

      <p className="text-[11px] text-muted">
        Changes save instantly. Tune blocks and links in their own chips
        (coming soon) or via chat.
      </p>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[11px] uppercase tracking-wide text-muted/70">
        {label}
      </span>
      {children}
    </div>
  );
}

function Pill({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={`text-xs px-2.5 py-1 rounded-full border transition ${
        active
          ? "bg-purple-600 text-white border-purple-600"
          : "bg-transparent text-primary border-secondary/60 hover:border-purple-500/60 hover:bg-purple-500/5"
      } ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}
    >
      {children}
    </button>
  );
}
