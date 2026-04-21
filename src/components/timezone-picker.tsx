"use client";

/**
 * Calendar-card timezone picker.
 *
 * Shipped with the guest-tz-ux-three-primitives rework (2026-04-21). Renders:
 *
 *   ┌───────────────────────────────────────────────────────┐
 *   │ Showing in Eastern Time · John is in Pacific          │
 *   │ [PT]  [ET*]  [CT]  [MT]  [Other…]                     │
 *   └───────────────────────────────────────────────────────┘
 *
 * Responsibilities:
 *
 *   • First render: if `viewerTimezone` is null on the session, seed it to
 *     the default (detected-guest-tz if ≠ host, else host-tz) and POST. Per
 *     decision #11 this means `viewerTimezone` is never null after first
 *     load, so downstream dual-tz checks in composer.ts are well-defined.
 *
 *   • Picker tap: optimistically swap the active chip, re-fetch slots with
 *     `?tz=` so the widget regroups by the chosen calendar day, and POST to
 *     persist the choice as the picker-authoritative viewer tz.
 *
 *   • "Other…" opens a full IANA browser-native <select>.
 *
 * The component is source-of-truth-free: it owns transient UI state only.
 * The canonical tz lives on NegotiationSession.viewerTimezone in the DB,
 * surfaced back via the session fetch and slot responses.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  longTimezoneLabel,
  shortTimezoneLabel,
  smartQuickPicks,
} from "@/lib/timezone";

interface TimezonePickerProps {
  sessionId: string;
  /** Host's IANA timezone — always present in the chip list. */
  hostTimezone: string;
  /** Host's first name, for the "{host} is in {host-tz}" secondary label. */
  hostFirstName: string;
  /** Whatever the server most recently told us the viewer tz is. Null before
   * first-render seed completes. */
  viewerTimezone: string | null;
  /** Called when the user picks a new tz; parent re-fetches slots and
   * updates its own display tz state. */
  onTimezoneChange: (tz: string) => void;
  /** Optional override for the detected browser tz (useful for tests). */
  detectedBrowserTz?: string | null;
}

/**
 * Stable IANA-prefix list of common user-selectable zones for the "Other…"
 * fallback. Mirrors the full IANA set minus obscure/historical zones.
 */
const OTHER_ZONES: Array<{ tz: string; label: string }> = [
  { tz: "Pacific/Honolulu", label: "Honolulu (HST)" },
  { tz: "America/Anchorage", label: "Anchorage (AKT)" },
  { tz: "America/Los_Angeles", label: "Los Angeles (PT)" },
  { tz: "America/Denver", label: "Denver (MT)" },
  { tz: "America/Phoenix", label: "Phoenix (MST, no DST)" },
  { tz: "America/Chicago", label: "Chicago (CT)" },
  { tz: "America/New_York", label: "New York (ET)" },
  { tz: "America/Halifax", label: "Halifax (AT)" },
  { tz: "America/Sao_Paulo", label: "São Paulo (BRT)" },
  { tz: "Europe/London", label: "London (GMT/BST)" },
  { tz: "Europe/Paris", label: "Paris (CET/CEST)" },
  { tz: "Europe/Athens", label: "Athens (EET/EEST)" },
  { tz: "Africa/Johannesburg", label: "Johannesburg (SAST)" },
  { tz: "Asia/Dubai", label: "Dubai (GST)" },
  { tz: "Asia/Kolkata", label: "Mumbai / Delhi (IST)" },
  { tz: "Asia/Bangkok", label: "Bangkok (ICT)" },
  { tz: "Asia/Shanghai", label: "Shanghai (CST)" },
  { tz: "Asia/Tokyo", label: "Tokyo (JST)" },
  { tz: "Australia/Sydney", label: "Sydney (AEST/AEDT)" },
  { tz: "Pacific/Auckland", label: "Auckland (NZST/NZDT)" },
];

/** Human-friendly long label for the header — "Eastern Time" etc. */
function longLabel(tz: string, now: Date): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      timeZoneName: "long",
    }).formatToParts(now);
    const name = parts.find((p) => p.type === "timeZoneName")?.value;
    if (name) return name.replace(/\s+Time$/, " Time");
    return longTimezoneLabel(tz);
  } catch {
    return longTimezoneLabel(tz);
  }
}

function detectBrowserTimezone(): string | null {
  if (typeof Intl === "undefined") return null;
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

async function persistViewerTimezone(
  sessionId: string,
  tz: string,
): Promise<void> {
  try {
    await fetch("/api/negotiate/session/viewer-timezone", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, timezone: tz }),
    });
  } catch {
    // Best-effort — UI state is already updated optimistically.
  }
}

export function TimezonePicker({
  sessionId,
  hostTimezone,
  hostFirstName,
  viewerTimezone,
  onTimezoneChange,
  detectedBrowserTz,
}: TimezonePickerProps) {
  const browserTz = useMemo(
    () => detectedBrowserTz ?? detectBrowserTimezone(),
    [detectedBrowserTz],
  );

  // Resolved "current viewer tz" — prefer server state, fall back to
  // detect-and-default. Stable within a render pass.
  const activeTz = useMemo(() => {
    if (viewerTimezone) return viewerTimezone;
    if (browserTz && browserTz !== hostTimezone) return browserTz;
    return hostTimezone;
  }, [viewerTimezone, browserTz, hostTimezone]);

  const [selected, setSelected] = useState(activeTz);

  // Keep internal `selected` in sync with external viewerTimezone changes.
  useEffect(() => {
    setSelected(activeTz);
  }, [activeTz]);

  // First-render seed (decision #11 / B1 fix): when the server reports
  // viewerTimezone === null, persist the default immediately so the column
  // is never null from the first page view onward. This removes the silent
  // dual-tz-trigger ambiguity the reviewer caught.
  useEffect(() => {
    if (viewerTimezone !== null) return;
    if (!sessionId || !activeTz) return;
    void persistViewerTimezone(sessionId, activeTz);
  }, [viewerTimezone, sessionId, activeTz]);

  const chips = useMemo(
    () => smartQuickPicks(hostTimezone, browserTz),
    [hostTimezone, browserTz],
  );

  const now = useMemo(() => new Date(), []);
  const viewerLong = longLabel(selected, now);
  const hostShort = shortTimezoneLabel(hostTimezone, now);

  const sameAsHost = selected === hostTimezone;

  const handlePick = useCallback(
    (tz: string) => {
      if (tz === selected) return;
      setSelected(tz);
      onTimezoneChange(tz);
      void persistViewerTimezone(sessionId, tz);
    },
    [selected, onTimezoneChange, sessionId],
  );

  return (
    <div className="flex flex-col gap-2 text-[11px] leading-snug">
      <div className="text-secondary">
        {sameAsHost ? (
          <>
            {viewerLong} (you and {hostFirstName})
          </>
        ) : (
          <>
            Showing in <span className="text-primary font-medium">{viewerLong}</span>
            {" · "}
            {hostFirstName} is in {hostShort}
          </>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Timezone picker">
        {chips.map((tz) => {
          const active = tz === selected;
          const label = shortTimezoneLabel(tz, now);
          return (
            <button
              key={tz}
              type="button"
              onClick={() => handlePick(tz)}
              aria-pressed={active}
              className={[
                "px-2 py-1 rounded-full border text-[11px] transition-colors",
                active
                  ? "bg-accent text-on-accent border-transparent"
                  : "bg-surface-elevated border-DEFAULT text-primary hover:bg-surface-hover",
              ].join(" ")}
            >
              {label}
            </button>
          );
        })}
        <label className="relative">
          <span className="sr-only">Other timezone</span>
          <select
            aria-label="Pick another timezone"
            value={chips.includes(selected) ? "" : selected}
            onChange={(e) => {
              const v = e.target.value;
              if (v) handlePick(v);
            }}
            className="px-2 py-1 rounded-full border border-DEFAULT bg-surface-elevated text-[11px] text-primary hover:bg-surface-hover appearance-none cursor-pointer"
          >
            <option value="">Other…</option>
            {OTHER_ZONES.map((z) => (
              <option key={z.tz} value={z.tz}>
                {z.label}
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
}
