"use client";

import { useEffect, useState, type ReactNode } from "react";

interface MatchPulseProps {
  children: ReactNode;
  justMatched: boolean;
  matchCount: number;
  enabled: boolean;
}

export function MatchPulse({
  children,
  justMatched,
  matchCount,
  enabled,
}: MatchPulseProps) {
  const [hasMatched, setHasMatched] = useState(false);
  const [pulseActive, setPulseActive] = useState(false);

  useEffect(() => {
    if (!enabled || !justMatched) return;
    setHasMatched(true);
    setPulseActive(true);
    const t = setTimeout(() => setPulseActive(false), 2000);
    return () => clearTimeout(t);
  }, [enabled, justMatched]);

  const ringClass = !enabled
    ? ""
    : pulseActive
      ? "match-pulse-ring-active"
      : hasMatched
        ? "match-pulse-ring-persistent"
        : "";

  return (
    <div className={`relative rounded-2xl ${ringClass}`}>
      {children}
      {enabled && justMatched && (
        <span className="sr-only" aria-live="polite">
          Calendars matched. {matchCount} {matchCount === 1 ? "day" : "days"} both free.
        </span>
      )}
    </div>
  );
}
