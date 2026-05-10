"use client";

/**
 * SeriesPageHeader — title + cadence + 2 header actions.
 *
 * Actions:
 *   ⚙ Change series  → onChangeSeries?.()
 *   📅 Open in Google Calendar → onOpenInGoogleCalendar?.()
 *
 * Visual spec: event-card-FINAL-spec.md § 3.9 + portfolio § 6.
 */

interface SeriesPageHeaderProps {
  title: string;
  cadence: string;
  onChangeSeries?: () => void;
  onOpenInGoogleCalendar?: () => void;
}

export function SeriesPageHeader({
  title,
  cadence,
  onChangeSeries,
  onOpenInGoogleCalendar,
}: SeriesPageHeaderProps) {
  return (
    <div style={{
      background: "#ffffff",
      borderBottom: "1px solid #e7e2d5",
      padding: "18px 16px 14px",
    }}>
      {/* Eyebrow */}
      <div style={{
        fontSize: "10.5px",
        fontWeight: 700,
        letterSpacing: "0.1em",
        textTransform: "uppercase",
        color: "#4f46e5",
        marginBottom: "6px",
      }}>
        🔁 Series
      </div>

      {/* Title */}
      <div style={{
        fontSize: "20px",
        fontWeight: 600,
        color: "#1a1a2e",
        marginBottom: "5px",
        lineHeight: 1.2,
      }}>
        {title}
      </div>

      {/* Cadence sentence */}
      <div style={{
        fontSize: "13.5px",
        color: "#6b6458",
        marginBottom: "14px",
      }}>
        {cadence}
      </div>

      {/* Action row — two text-link actions (Rule 7) */}
      <div style={{ display: "flex", gap: "16px", alignItems: "center" }}>
        <button
          onClick={onChangeSeries}
          style={{
            background: "none",
            border: "none",
            padding: 0,
            cursor: "pointer",
            fontSize: "13px",
            fontWeight: 500,
            color: "#4f46e5",
            display: "flex",
            alignItems: "center",
            gap: "4px",
          }}
        >
          <span>⚙</span>
          <span>Change series</span>
        </button>

        <button
          onClick={onOpenInGoogleCalendar}
          style={{
            background: "none",
            border: "none",
            padding: 0,
            cursor: "pointer",
            fontSize: "13px",
            fontWeight: 500,
            color: "#4f46e5",
            display: "flex",
            alignItems: "center",
            gap: "4px",
          }}
        >
          <span>📅</span>
          <span>Open in Google Calendar</span>
        </button>
      </div>
    </div>
  );
}
