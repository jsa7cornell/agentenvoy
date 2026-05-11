"use client";

/**
 * RescheduleOverlay — renders inside confirmed view when reschedulingFromConfirmed=true.
 *
 * Shows the AvailabilityCalendar (passed as pickerSlot from deal-room.tsx) inside
 * a centered container with "Keep current time" affordances above and below the picker.
 *
 * PR2c — 2026-05-10
 * Polish — 2026-05-10: replaced single ← Cancel link with header strip ("Pick a new
 * time, or" + "Keep current time" link) and repeated footer strip so the dismiss
 * action is always visible even when the picker is tall.
 */

interface RescheduleOverlayProps {
  /** The AvailabilityCalendar rendered by renderPickerBubble in deal-room.tsx */
  pickerSlot: React.ReactNode;
  onCancel: () => void;
}

const keepLinkStyle: React.CSSProperties = {
  background: "transparent",
  border: "none",
  padding: 0,
  fontSize: "13px",
  fontWeight: 500,
  color: "#4f46e5",
  cursor: "pointer",
  textDecoration: "none",
};

function KeepCurrentTimeButton({ onCancel }: { onCancel: () => void }) {
  return (
    <button
      type="button"
      onClick={onCancel}
      style={keepLinkStyle}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLButtonElement).style.textDecoration = "underline";
        (e.currentTarget as HTMLButtonElement).style.color = "#3730a3";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.textDecoration = "none";
        (e.currentTarget as HTMLButtonElement).style.color = "#4f46e5";
      }}
    >
      Keep current time
    </button>
  );
}

export function RescheduleOverlay({ pickerSlot, onCancel }: RescheduleOverlayProps) {
  return (
    <div className="px-4 pb-6 lg:px-8 lg:pb-12">
      <div className="max-w-[540px] mx-auto">
        {/* Header strip */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: "10px",
          }}
        >
          <span style={{ fontSize: "13px", color: "#6b6458" }}>
            Pick a new time, or
          </span>
          <KeepCurrentTimeButton onCancel={onCancel} />
        </div>

        {/* Picker — rendered from deal-room renderPickerBubble */}
        <div className="rounded-2xl overflow-hidden border border-[#e7e2d5] bg-[#faf8f3]">
          {pickerSlot}
        </div>

        {/* Footer strip — repeated so it's visible without scrolling back up */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            marginTop: "10px",
          }}
        >
          <KeepCurrentTimeButton onCancel={onCancel} />
        </div>
      </div>
    </div>
  );
}
