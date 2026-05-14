"use client";

/**
 * SessionRow — one row in the series page upcoming-sessions list.
 *
 * Renders: date block (mini calendar tile) + info column (time + meta) + arrow.
 * Status drives badge color + row accent (next → indigo ring, skipped → amber bg).
 * Tap → navigate to session.url via Next.js Link.
 *
 * Visual spec: event-card-FINAL-spec.md § 3.9 + portfolio § 6.
 */

import Link from "next/link";
import type { UpcomingSession, UpcomingSessionStatus } from "@/components/MeetingCard/types";

// ── Date helpers ──────────────────────────────────────────────────────────────

const MONTH_ABBR = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function localDate(d: Date, tz: string): { month: string; day: number; dow: string } {
  // Use Intl to get local parts without manual offset arithmetic
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    month: "numeric",
    day: "numeric",
    weekday: "short",
  }).formatToParts(d);

  const month  = Number(parts.find((p) => p.type === "month")?.value ?? 1);
  const day    = Number(parts.find((p) => p.type === "day")?.value ?? 1);
  const dowStr = parts.find((p) => p.type === "weekday")?.value ?? "";

  return {
    month: MONTH_ABBR[month - 1] ?? "???",
    day,
    dow: dowStr.slice(0, 3),
  };
}

function formatTime(d: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(d);
}

function tzAbbr(d: Date, tz: string): string {
  // Extract timezone abbreviation from a formatted string
  const formatted = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    timeZoneName: "short",
  }).format(d);
  const match = formatted.match(/([A-Z]{2,5})$/);
  return match ? match[1] : tz;
}

// ── Badge config ──────────────────────────────────────────────────────────────

interface BadgeStyle {
  label: string;
  bg: string;
  color: string;
  border: string;
}

const BADGE_MAP: Record<UpcomingSessionStatus, BadgeStyle> = {
  next:      { label: "Next",      bg: "#eef2ff", color: "#4338ca", border: "#c7d2fe" },
  confirmed: { label: "Confirmed", bg: "#ecfdf5", color: "#065f46", border: "#a7f3d0" },
  skipped:   { label: "Skipped",   bg: "#fffbeb", color: "#92400e", border: "#fde68a" },
  moved:     { label: "Moved",     bg: "#ecfdf5", color: "#065f46", border: "#a7f3d0" },
};

// ── Row styles ────────────────────────────────────────────────────────────────

function rowStyle(status: UpcomingSessionStatus): React.CSSProperties {
  const base: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    padding: "11px 12px",
    border: "1px solid",
    borderRadius: "11px",
    background: "#ffffff",
    marginBottom: "5px",
    textDecoration: "none",
    color: "inherit",
    cursor: "pointer",
  };

  if (status === "next") {
    return {
      ...base,
      borderColor: "#6366f1",
      background: "#eef2ff",
      boxShadow: "0 0 0 2px rgba(99,102,241,.12)",
    };
  }
  if (status === "skipped") {
    return {
      ...base,
      borderColor: "#fde68a",
      background: "#fffbeb",
    };
  }
  return {
    ...base,
    borderColor: "#e7e2d5",
  };
}

function dateBlockStyle(status: UpcomingSessionStatus): React.CSSProperties {
  return {
    flexShrink: 0,
    width: "46px",
    height: "46px",
    padding: "4px",
    background: status === "next" ? "#ffffff" : "#f6f3ec",
    border: `1px solid ${status === "next" ? "#c7d2fe" : "#e7e2d5"}`,
    borderRadius: "7px",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: "1px",
  };
}

// ── Channel detail ────────────────────────────────────────────────────────────

function channelDetail(session: UpcomingSession): string {
  const { channel, skipReason } = session;
  if (session.status === "skipped" && skipReason) return skipReason;
  if (channel.kind === "TBD") return "Format TBD";
  if (channel.kind === "in-person") return channel.location;
  if (channel.kind === "video") return channel.platform;
  return "Phone call";
}

// ── Component ─────────────────────────────────────────────────────────────────

export function SessionRow({ session }: { session: UpcomingSession }) {
  const { month, day, dow } = localDate(session.date, session.tz);
  const time = formatTime(session.date, session.tz);
  const abbr = tzAbbr(session.date, session.tz);
  const badge = BADGE_MAP[session.status];
  const detail = channelDetail(session);
  const isSkipped = session.status === "skipped";

  const timeStyle: React.CSSProperties = {
    fontSize: "13.5px",
    fontWeight: 600,
    color: session.status === "next" ? "#4338ca" : isSkipped ? "#d97706" : "#1a1a2e",
    textDecoration: isSkipped ? "line-through" : "none",
    lineHeight: 1.2,
  };

  return (
    <Link href={session.url} style={rowStyle(session.status)}>
      {/* Date block */}
      <div style={dateBlockStyle(session.status)}>
        <span style={{ fontSize: "8.5px", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", color: "#9b9480" }}>
          {month}
        </span>
        <span style={{ fontSize: "18px", fontWeight: 700, color: "#1a1a2e", lineHeight: 1 }}>
          {day}
        </span>
        <span style={{ fontSize: "9px", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", color: "#9b9480" }}>
          {dow}
        </span>
      </div>

      {/* Info column */}
      <div style={{ flex: 1, minWidth: 0 }}>
        {/* Time line */}
        <div style={timeStyle}>
          {time} ({abbr}) · {session.durationMin} min
        </div>
        {/* Meta line — badge + detail */}
        <div style={{ display: "flex", alignItems: "center", gap: "5px", marginTop: "3px" }}>
          <span style={{
            display: "inline-block",
            fontSize: "10px",
            fontWeight: 600,
            padding: "1px 6px",
            borderRadius: "4px",
            background: badge.bg,
            color: badge.color,
            border: `1px solid ${badge.border}`,
            letterSpacing: "0.02em",
          }}>
            {badge.label}
          </span>
          <span style={{ fontSize: "11.5px", color: "#9b9480", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {detail}
          </span>
        </div>
      </div>

      {/* Arrow */}
      <span style={{ fontSize: "14px", color: "#c9c2ae", flexShrink: 0 }}>→</span>
    </Link>
  );
}
