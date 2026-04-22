"use client";

import { useEffect, useState, type ReactNode } from "react";

interface MatchPulseProps {
  /** Wrapper for the Envoy bubble that contains the AvailabilityCalendar. */
  children: ReactNode;
  /**
   * One-shot trigger — true on the render cycle when bilateralByDay flips
   * from empty → non-empty. Parent resets to false on the next tick.
   */
  justMatched: boolean;
  /** Mutual-time count, used in the header badge and SR announcement. */
  matchCount: number;
  /**
   * Off when the viewer is the host (per Q7) or when the bubble shouldn't
   * celebrate (e.g. confirmed sessions). Disables ring + badge entirely.
   */
  enabled: boolean;
  /** Bubble label this badge replaces ("Envoy" today). */
  defaultLabel: string;
}

/**
 * T4 — match-visible widget upgrade.
 *
 * Wraps the Envoy bubble that contains the calendar. When `justMatched`
 * fires, runs a ~2s gradient ring pulse and shows a "Matched · N mutual
 * times" badge in place of the standard "Envoy" header label for ~5s,
 * then crossfades back. After the opening pulse, a subtle persistent
 * ring stays for the lifetime of the matched view as the durable signal.
 *
 * Reduced motion: the ring becomes a static border and the badge appears
 * without the crossfade — both handled in globals.css media query.
 */
export function MatchPulse({
  children,
  justMatched,
  matchCount,
  enabled,
  defaultLabel,
}: MatchPulseProps) {
  // hasMatched stays true once we've ever seen mutual slots so the
  // persistent ring outlives the one-shot justMatched signal.
  const [hasMatched, setHasMatched] = useState(false);
  const [pulseActive, setPulseActive] = useState(false);
  const [badgeVisible, setBadgeVisible] = useState(false);

  useEffect(() => {
    if (!enabled || !justMatched) return;
    setHasMatched(true);
    setPulseActive(true);
    setBadgeVisible(true);
    const ringTimer = setTimeout(() => setPulseActive(false), 2000);
    const badgeTimer = setTimeout(() => setBadgeVisible(false), 5000);
    return () => {
      clearTimeout(ringTimer);
      clearTimeout(badgeTimer);
    };
  }, [enabled, justMatched]);

  const ringClass = !enabled
    ? ""
    : pulseActive
      ? "match-pulse-ring-active"
      : hasMatched
        ? "match-pulse-ring-persistent"
        : "";

  // Header label swap. The label is rendered by deal-room.tsx as a sibling
  // of <AvailabilityCalendar> inside the same bubble; we own it here so the
  // crossfade and the ring share lifecycle.
  const label = enabled && badgeVisible
    ? `Matched · ${matchCount} ${matchCount === 1 ? "day" : "days"} both free`
    : defaultLabel;

  return (
    <div className={`relative rounded-2xl ${ringClass}`}>
      <div className="text-[10px] font-bold uppercase tracking-wider mb-2 text-emerald-400">
        <span
          key={label}
          className={enabled && badgeVisible ? "match-pulse-badge inline-block" : "inline-block"}
        >
          {label}
        </span>
      </div>
      {children}
      {enabled && justMatched && (
        <span className="sr-only" aria-live="polite">
          Calendars matched. {matchCount} {matchCount === 1 ? "day" : "days"} both free.
        </span>
      )}
    </div>
  );
}
