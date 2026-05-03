/**
 * OfferCard — the `offer` mode widget per §4 of proposal
 * `2026-04-21_deal-room-widget-state-machine-and-agent-dialog-clarity`.
 *
 * Renders when the deal-room state machine resolves to `offer`: either
 * an exclusive single-slot link or a short (≤3) same-local-day set of
 * slots. Replaces the noisy chooser with a focused confirm card — the
 * collapse itself is the visible "we converged" celebration per §4.4
 * ("the card collapse itself … is the visible 'we converged.'").
 *
 * Copy rules (§4.3):
 *   - Header above card: "Envoy found a mutual time that works." —
 *     single sentence, header-like, not a bubble.
 *   - CTA: "Confirm this time" (green pill, matching existing confirm
 *     styling so tone stays in line with PR #59).
 *   - Escape hatch: "Pick a different time" — text link, not a button,
 *     triggers the transition to `negotiate` per §3.2.
 *   - Subtle ✓ in the card corner is acceptable (§4.4 decision d) — NOT
 *     a badge, NOT a toast. Kept small and dimmed.
 *
 * This component is presentational. It does NOT call the confirm API —
 * callers pass `onConfirm` and handle the pipeline (which lets the
 * existing guest-name / email collection form keep living in
 * `deal-room.tsx` for now). On click, callers expand the existing
 * pendingProposal form so the name/email capture flow is reused.
 *
 * Design-language reuse (§4.2): mirrors the emerald-tinted proposal
 * card already in deal-room.tsx (pendingProposal path) so the visual
 * primitive is shared — same border color, same pill CTA shape.
 */

import React from "react";
import { formatDuration } from "@/lib/format-duration";

export interface OfferCardSlot {
  /** ISO datetime string. */
  start: string;
  /** ISO datetime string. */
  end: string;
}

export interface OfferCardProps {
  slot: OfferCardSlot;
  durationMin: number;
  format: string;
  location?: string | null;
  /**
   * IANA timezone used to format the slot's date/time labels. Typically
   * the viewer's resolved tz (picker-authoritative → browser fallback).
   */
  timezone: string;
  onConfirm: () => void;
  onPickDifferent: () => void;
  /** Optional — disables the confirm CTA while a network call is in flight. */
  isConfirming?: boolean;
}

export function OfferCard({
  slot,
  durationMin,
  format,
  location,
  timezone,
  onConfirm,
  onPickDifferent,
  isConfirming = false,
}: OfferCardProps) {
  const dt = new Date(slot.start);
  const dayLabel = dt.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: timezone,
  });
  const timeLabel = dt.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
    timeZone: timezone,
  });
  const formatLabel = format
    ? format.charAt(0).toUpperCase() + format.slice(1)
    : null;
  // Format-row emoji from canonical set (CODEBASE-CLEANUP §22 / SPEC
  // §3.6): 💻 video, 📱 phone, 👤 in-person, 🕐 fallback.
  const formatEmoji = format === "video" ? "💻"
    : format === "phone" ? "📱"
    : format === "in-person" ? "👤"
    : "🕐";

  return (
    <div className="flex justify-start" data-testid="deal-room-offer-card">
      <div className="max-w-[85%] w-full min-w-0 space-y-2">
        {/* §4.1 header — stands alone above the card, treated as a header not
            a speech bubble. Intentionally restrained ("found a mutual time
            that works") — tone bar lives in §4.3. */}
        <div className="text-xs text-emerald-300/90 font-medium leading-snug px-1">
          Envoy found a mutual time that works.
        </div>
        <div
          className="relative bg-emerald-900/20 border border-emerald-700/50 rounded-xl p-4 space-y-3"
          role="group"
          aria-label="Proposed meeting time"
        >
          {/* Subtle ✓ corner marker per §4.4 — small, dimmed, NOT a badge. */}
          <span
            className="absolute top-2.5 right-3 text-emerald-400/60 text-xs select-none"
            aria-hidden="true"
          >
            ✓
          </span>
          <div className="space-y-1 text-sm text-primary">
            <p>📅 {dayLabel}</p>
            <p>
              🕐 {timeLabel} ({formatDuration(durationMin)})
            </p>
            {formatLabel && <p>{formatEmoji} {formatLabel}</p>}
            {location && <p>📍 {location}</p>}
          </div>
          <button
            type="button"
            onClick={onConfirm}
            disabled={isConfirming}
            className="w-full px-4 py-3 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-sm font-semibold rounded-xl transition"
          >
            {isConfirming ? "Confirming..." : "Confirm this time"}
          </button>
          <button
            type="button"
            onClick={onPickDifferent}
            disabled={isConfirming}
            className="w-full text-center text-xs text-muted hover:text-secondary transition"
          >
            Pick a different time
          </button>
        </div>
      </div>
    </div>
  );
}
