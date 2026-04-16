"use client";

/**
 * TimeChipList — renders bilateral availability chips in the deal-room thread,
 * inline below the guest-Envoy's greeting.
 *
 * Privacy: only two colors cross the UI boundary — green (works for both) and
 * orange (works for one side, ambiguous which). The component never exposes
 * raw scores or per-side status. See src/lib/bilateral-availability.ts for
 * the server-side contract.
 *
 * Interaction: clicking a green chip selects it and calls onSelectSlot with
 * an ISO datetime + format hint the deal-room wires into the chat input (or
 * a proposal, per the slice order). Orange chips currently drop a
 * "can you free this up?" template into the input — handled by the parent.
 */

import { useState } from "react";

export interface TimeChipData {
  start: string; // ISO
  end: string;   // ISO
  color: "both" | "one";
}

export interface TimeChipListProps {
  /** Bilateral slots grouped by ISO YYYY-MM-DD (server-computed). */
  bilateralByDay: Record<string, TimeChipData[]>;
  /** Viewer's primary timezone (usually their browser TZ). */
  primaryTimezone: string;
  /** Counterparty's timezone — only shown as secondary when different from primary. */
  counterpartyTimezone?: string;
  /**
   * Called when a chip is clicked. `start` is the ISO datetime.
   * Green click → parent proposes the time.
   * Orange click → parent drops a soft-ask template into the input.
   */
  onSelectSlot: (args: { start: string; end: string; color: "both" | "one" }) => void;
}

export function TimeChipList({
  bilateralByDay,
  primaryTimezone,
  counterpartyTimezone,
  onSelectSlot,
}: TimeChipListProps) {
  const [selectedStart, setSelectedStart] = useState<string | null>(null);

  const days = Object.keys(bilateralByDay).sort();
  if (days.length === 0) return null;

  const showDualTz =
    !!counterpartyTimezone && counterpartyTimezone !== primaryTimezone;

  // Group into "works for both" and "works for one side" buckets per day so
  // we can render them with separate headers like in the mockup.
  const bothDays: Array<{ dayLabel: string; chips: TimeChipData[] }> = [];
  const oneDays: Array<{ dayLabel: string; chips: TimeChipData[] }> = [];

  for (const dayKey of days) {
    const chips = bilateralByDay[dayKey];
    const dayLabel = formatDayLabel(chips[0].start, primaryTimezone);
    const both = chips.filter((c) => c.color === "both");
    const one = chips.filter((c) => c.color === "one");
    if (both.length) bothDays.push({ dayLabel, chips: both });
    if (one.length) oneDays.push({ dayLabel, chips: one });
  }

  const hasBoth = bothDays.some((d) => d.chips.length > 0);
  const hasOne = oneDays.some((d) => d.chips.length > 0);

  return (
    <div className="mt-3 space-y-3" data-testid="time-chip-list">
      {hasBoth && (
        <div>
          <div className="text-[10px] font-bold uppercase tracking-wider text-secondary mb-1.5">
            Works for both of you
          </div>
          <div className="flex flex-wrap gap-1.5">
            {bothDays.flatMap((d) =>
              d.chips.map((chip) => (
                <TimeChip
                  key={chip.start}
                  chip={chip}
                  dayLabel={d.dayLabel}
                  primaryTz={primaryTimezone}
                  secondaryTz={showDualTz ? counterpartyTimezone! : undefined}
                  selected={chip.start === selectedStart}
                  onClick={() => {
                    setSelectedStart(chip.start);
                    onSelectSlot({ start: chip.start, end: chip.end, color: chip.color });
                  }}
                />
              )),
            )}
          </div>
        </div>
      )}

      {hasOne && (
        <div>
          <div className="text-[10px] font-bold uppercase tracking-wider text-secondary mb-1.5">
            Close — one side would need to shift
          </div>
          <div className="flex flex-wrap gap-1.5">
            {oneDays.flatMap((d) =>
              d.chips.map((chip) => (
                <TimeChip
                  key={chip.start}
                  chip={chip}
                  dayLabel={d.dayLabel}
                  primaryTz={primaryTimezone}
                  secondaryTz={showDualTz ? counterpartyTimezone! : undefined}
                  selected={chip.start === selectedStart}
                  onClick={() => {
                    setSelectedStart(chip.start);
                    onSelectSlot({ start: chip.start, end: chip.end, color: chip.color });
                  }}
                />
              )),
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Individual chip ─────────────────────────────────────────────────────────

interface TimeChipProps {
  chip: TimeChipData;
  dayLabel: string;
  primaryTz: string;
  secondaryTz?: string;
  selected: boolean;
  onClick: () => void;
}

function TimeChip({ chip, dayLabel, primaryTz, secondaryTz, selected, onClick }: TimeChipProps) {
  const start = new Date(chip.start);
  const primaryTime = formatTime(start, primaryTz);
  const secondaryTime = secondaryTz ? formatTime(start, secondaryTz) : null;

  const base =
    "inline-flex items-baseline gap-1.5 rounded-full px-3 py-1 text-xs font-medium border transition cursor-pointer";
  const colorClasses =
    chip.color === "both"
      ? "bg-emerald-900/30 border-emerald-600 text-emerald-200 hover:bg-emerald-900/50"
      : "bg-orange-900/30 border-orange-600 text-orange-200 hover:bg-orange-900/50";
  const selectedRing = selected
    ? "ring-2 ring-offset-2 ring-offset-surface ring-blue-500"
    : "";

  const icon = chip.color === "both" ? "✓" : "½";

  return (
    <button
      type="button"
      onClick={onClick}
      className={`${base} ${colorClasses} ${selectedRing}`}
      aria-pressed={selected}
      title={
        chip.color === "both"
          ? "Works for both of you — click to propose this time"
          : "Works for one side — click to ask about shifting"
      }
    >
      <span aria-hidden>{icon}</span>
      <span>
        {dayLabel} · {primaryTime}
        {secondaryTime && (
          <span className="opacity-70 ml-1">· {secondaryTime}</span>
        )}
      </span>
    </button>
  );
}

// ─── Formatters (pre-formatted in code, per TZ contract) ─────────────────────

function formatDayLabel(iso: string, tz: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: tz,
  });
}

function formatTime(d: Date, tz: string): string {
  return d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: tz,
  });
}
