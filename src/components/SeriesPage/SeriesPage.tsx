"use client";

/**
 * SeriesPage — composition root for the series page route.
 *
 * Dedicated route — no card chrome. Card-less surface on warm #f6f3ec background.
 * Structure: SeriesPageHeader (white, bordered) + SessionList (scrollable, warm bg).
 *
 * Anti-clutter rules (Round 8 simplification, binding):
 *  - Past sessions are NEVER rendered — `upcoming` must be forward-only
 *  - "End series" button does NOT appear on this page
 *  - No "Show past sessions" affordance
 *
 * Visual spec: event-card-FINAL-spec.md § 3.9 + portfolio § 6.
 */

import type { SeriesPageProps } from "@/components/MeetingCard/types";
import { SeriesPageHeader } from "./SeriesPageHeader";
import { SessionList } from "./SessionList";

export function SeriesPage({
  title,
  cadence,
  upcoming,
  googleCalendarSeriesUrl,
  onChangeSeries,
  onOpenInGoogleCalendar,
}: SeriesPageProps) {
  function handleOpenInGoogleCalendar() {
    if (onOpenInGoogleCalendar) {
      onOpenInGoogleCalendar();
    } else {
      window.open(googleCalendarSeriesUrl, "_blank", "noopener,noreferrer");
    }
  }

  return (
    <div
      data-testid="series-page"
      style={{
        background: "#f6f3ec",
        minHeight: "100%",
        fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
        color: "#1a1a2e",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <SeriesPageHeader
        title={title}
        cadence={cadence}
        onChangeSeries={onChangeSeries}
        onOpenInGoogleCalendar={handleOpenInGoogleCalendar}
      />

      <div style={{ flex: 1, overflowY: "auto" }}>
        <SessionList upcoming={upcoming} />
      </div>
    </div>
  );
}
