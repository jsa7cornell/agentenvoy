"use client";

import { useEffect, useState } from "react";
import { computeEditedPillDisplay, EDITED_PILL_DEFAULT_FRESHNESS_MS } from "@/lib/edited-pill-display";

/**
 * "Edited just now — activity, hours" pill.
 *
 * Decided in proposal 2026-04-28_event-edit-handler-and-composer (§3.C).
 * Renders when:
 *  - `lastMaterialEditAt` is non-null AND within `freshnessWindowMs` of now
 *    (default 5 minutes), AND
 *  - `lastEditedFields` contains at least one canonical material field.
 *
 * Otherwise renders nothing. Auto-refreshes via a setInterval so the pill
 * disappears at the freshness boundary without needing a re-render trigger
 * upstream.
 *
 * Display logic — including humanizing field names and rendering the age
 * label — lives in the pure helper at `@/lib/edited-pill-display` so it can
 * be unit-tested without a DOM. This component is the thin React wrapper.
 */
export interface EditedPillProps {
  /** ISO datetime string from the server, or null when no material edit has happened. */
  lastMaterialEditAt: string | null;
  /** Canonical material field names that changed in the last material edit. */
  lastEditedFields: readonly string[] | null | undefined;
  /** Freshness window in milliseconds. Default 5 minutes. */
  freshnessWindowMs?: number;
  /** Optional className override for layout. */
  className?: string;
}

const TICK_INTERVAL_MS = 15 * 1000; // re-evaluate every 15s

export function EditedPill({
  lastMaterialEditAt,
  lastEditedFields,
  freshnessWindowMs = EDITED_PILL_DEFAULT_FRESHNESS_MS,
  className = "",
}: EditedPillProps) {
  const [now, setNow] = useState<number>(() => Date.now());

  // Tick the clock so the pill auto-fades when the freshness window expires
  // without requiring a parent re-render. Only ticks while the pill could
  // plausibly be visible — once we're past the window the effect early-
  // returns and never re-arms.
  useEffect(() => {
    if (!lastMaterialEditAt) return;
    const editedAtMs = Date.parse(lastMaterialEditAt);
    if (Number.isNaN(editedAtMs)) return;
    if (Date.now() - editedAtMs > freshnessWindowMs) return;
    const id = setInterval(() => setNow(Date.now()), TICK_INTERVAL_MS);
    return () => clearInterval(id);
  }, [lastMaterialEditAt, freshnessWindowMs]);

  const display = computeEditedPillDisplay(lastMaterialEditAt, lastEditedFields, {
    nowMs: now,
    freshnessWindowMs,
  });
  if (!display) return null;

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-500 ${className}`}
      role="status"
      aria-label={`Edited ${display.ageLabel} — ${display.fieldList}`}
    >
      <span aria-hidden="true">✎</span>
      <span>
        Edited {display.ageLabel} — {display.fieldList}
      </span>
    </span>
  );
}
