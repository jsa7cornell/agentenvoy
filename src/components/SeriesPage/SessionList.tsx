"use client";

/**
 * SessionList — "UP NEXT" section header + scrollable list of SessionRow items.
 *
 * Upcoming-only per Round 8 simplification. Past sessions are never rendered.
 * Visual spec: event-card-FINAL-spec.md § 3.9 + portfolio § 6.
 */

import type { UpcomingSession } from "@/components/MeetingCard/types";
import { SessionRow } from "./SessionRow";

interface SessionListProps {
  upcoming: UpcomingSession[];
}

export function SessionList({ upcoming }: SessionListProps) {
  return (
    <div style={{ padding: "0 16px 24px" }}>
      {/* Section header */}
      <div style={{
        fontSize: "11px",
        fontWeight: 700,
        letterSpacing: "0.1em",
        textTransform: "uppercase",
        color: "#9b9480",
        marginBottom: "12px",
        paddingTop: "4px",
      }}>
        Up next
      </div>

      {/* Session rows */}
      {upcoming.map((session) => (
        <SessionRow key={session.sessionId} session={session} />
      ))}

      {upcoming.length === 0 && (
        <div style={{ fontSize: "13px", color: "#9b9480", textAlign: "center", paddingTop: "24px" }}>
          No upcoming sessions.
        </div>
      )}
    </div>
  );
}
