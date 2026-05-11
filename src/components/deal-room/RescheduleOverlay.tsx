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
  // Parent (MeetingCardConfirmedView belowCardSlot wrapper) provides the
  // outer px/pb + max-w-[540px] mx-auto; this component only handles its
  // own internal strips. 2026-05-11 — dropped the duplicate footer "Keep
  // current time" and tightened spacing per John's feedback.
  return (
    <>
      {/* Header strip — "Pick a new time, or  Keep current time" */}
      <div className="flex items-center justify-between mb-2">
        <span className="text-[13px] text-[#6b6458]">Pick a new time, or</span>
        <KeepCurrentTimeButton onCancel={onCancel} />
      </div>

      {/* Picker — stronger border so it doesn't blend into the page bg. */}
      <div className="rounded-2xl overflow-hidden border border-[#dbd5c4] bg-[#faf8f3]">
        {pickerSlot}
      </div>
    </>
  );
}
