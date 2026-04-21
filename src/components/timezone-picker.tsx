"use client";

/**
 * Calendar-card timezone picker — C2 footer pill.
 *
 * Rendered under the slot chips as a single, compact line:
 *
 *   Times in Pacific Time · John's in Eastern.   [ Switch to Eastern Time ▾ ]
 *
 * The bordered pill on the right is a native <select> styled as a dropdown
 * button. Its default option is the suggested zone (the viewer's browser tz
 * if it differs from the current display tz; otherwise the host's tz if it
 * differs; otherwise "Change timezone" with no preselection). The rest of the
 * options are a curated IANA list. Native <select> means the mobile UI is
 * the OS picker — fast, accessible, no layout pressure on the card.
 *
 * Responsibilities:
 *
 *   • First render: if `viewerTimezone` is null on the session, seed it to
 *     the default (detected-guest-tz if ≠ host, else host-tz) and POST. Per
 *     decision #11 this means `viewerTimezone` is never null after first
 *     load, so downstream dual-tz checks in composer.ts are well-defined.
 *
 *   • Pick: optimistically swap the display tz, re-fetch slots with `?tz=`
 *     so the widget regroups by the chosen calendar day, and POST to persist
 *     the choice as the picker-authoritative viewer tz.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { longTimezoneLabel, shortTimezoneLabel } from "@/lib/timezone";

interface TimezonePickerProps {
  sessionId: string;
  /** Host's IANA timezone. */
  hostTimezone: string;
  /** Host's first name, for the "{host}'s in {host-tz}" secondary label. */
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
 * Full IANA picker list. Covers common zones across all regions, same set
 * the old "Other…" dropdown used.
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

/** Human-friendly long label — "Eastern Time" etc. */
function longLabel(tz: string, now: Date): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      timeZoneName: "long",
    }).formatToParts(now);
    const name = parts.find((p) => p.type === "timeZoneName")?.value;
    if (name) return name;
    return longTimezoneLabel(tz);
  } catch {
    return longTimezoneLabel(tz);
  }
}

/** Offset from UTC in minutes for a given IANA tz at the given instant. */
function tzOffsetMinutes(tz: string, date: Date): number {
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const map: Record<string, string> = {};
    for (const p of dtf.formatToParts(date)) map[p.type] = p.value;
    const asUTC = Date.UTC(
      Number(map.year),
      Number(map.month) - 1,
      Number(map.day),
      Number(map.hour),
      Number(map.minute),
      Number(map.second),
    );
    return (asUTC - date.getTime()) / 60000;
  } catch {
    return 0;
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

  const activeTz = useMemo(() => {
    if (viewerTimezone) return viewerTimezone;
    if (browserTz && browserTz !== hostTimezone) return browserTz;
    return hostTimezone;
  }, [viewerTimezone, browserTz, hostTimezone]);

  const [selected, setSelected] = useState(activeTz);

  useEffect(() => {
    setSelected(activeTz);
  }, [activeTz]);

  // First-render seed: persist default immediately so the column is never
  // null from first page view onward.
  useEffect(() => {
    if (viewerTimezone !== null) return;
    if (!sessionId || !activeTz) return;
    void persistViewerTimezone(sessionId, activeTz);
  }, [viewerTimezone, sessionId, activeTz]);

  const now = useMemo(() => new Date(), []);
  const viewerLong = longLabel(selected, now);
  const hostShort = shortTimezoneLabel(hostTimezone, now);

  const sameAsHost = selected === hostTimezone;

  const hostOffsetLabel = useMemo(() => {
    if (sameAsHost) return null;
    const diffHours =
      (tzOffsetMinutes(hostTimezone, now) - tzOffsetMinutes(selected, now)) /
      60;
    if (diffHours === 0) return null;
    const abs = Math.abs(diffHours);
    const hrs = Number.isInteger(abs) ? String(abs) : abs.toFixed(1);
    const unit = abs === 1 ? "hr" : "hrs";
    const dir = diffHours > 0 ? "ahead" : "behind";
    return `${hrs} ${unit} ${dir}`;
  }, [sameAsHost, hostTimezone, selected, now]);

  const handlePick = useCallback(
    (tz: string) => {
      if (!tz || tz === selected) return;
      setSelected(tz);
      onTimezoneChange(tz);
      void persistViewerTimezone(sessionId, tz);
    },
    [selected, onTimezoneChange, sessionId],
  );

  const options = useMemo(() => {
    const out: Array<{ tz: string; label: string }> = [];
    const seen = new Set<string>();
    for (const z of OTHER_ZONES) {
      if (seen.has(z.tz)) continue;
      out.push(z);
      seen.add(z.tz);
    }
    if (!seen.has(selected)) {
      out.unshift({ tz: selected, label: viewerLong });
    }
    return out;
  }, [selected, viewerLong]);

  return (
    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 text-[11px] leading-snug text-muted">
      <div className="min-w-0">
        {sameAsHost ? (
          <>
            <span className="text-primary font-medium">{viewerLong}</span>
            <span className="text-muted"> (you and {hostFirstName})</span>
          </>
        ) : (
          <>
            Times in <span className="text-primary font-medium">{viewerLong}</span>
            <span className="text-muted">
              {" · "}
              {hostFirstName}&rsquo;s in {hostShort}
              {hostOffsetLabel ? `, ${hostOffsetLabel}` : ""}
            </span>
          </>
        )}
      </div>

      <label className="relative inline-flex items-center gap-1.5 self-start sm:self-auto px-2.5 py-1 rounded-md border border-DEFAULT bg-surface-elevated hover:bg-surface-hover hover:border-purple-400/60 text-purple-400 hover:text-purple-300 transition cursor-pointer whitespace-nowrap">
        <span className="sr-only">Change timezone</span>
        <span aria-hidden="true">
          <span className="font-medium">Change timezone</span>
        </span>
        <svg
          aria-hidden="true"
          width="12"
          height="12"
          viewBox="0 0 20 20"
          fill="currentColor"
          className="opacity-80 flex-shrink-0"
        >
          <path d="M5 7l5 6 5-6H5z" />
        </svg>
        <select
          aria-label="Pick a timezone"
          value={selected}
          onChange={(e) => handlePick(e.target.value)}
          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer appearance-none"
        >
          {options.map((z) => (
            <option key={z.tz} value={z.tz}>
              {z.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
