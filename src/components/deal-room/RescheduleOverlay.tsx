"use client";

/**
 * RescheduleOverlay — renders inside confirmed view when reschedulingFromConfirmed=true.
 *
 * Shows the AvailabilityCalendar (passed as pickerSlot from deal-room.tsx) inside
 * a centered container with a "← Cancel reschedule" link at the top.
 *
 * PR2c — 2026-05-10
 */

interface RescheduleOverlayProps {
  /** The AvailabilityCalendar rendered by renderPickerBubble in deal-room.tsx */
  pickerSlot: React.ReactNode;
  onCancel: () => void;
}

export function RescheduleOverlay({ pickerSlot, onCancel }: RescheduleOverlayProps) {
  return (
    <div className="px-4 pb-6 lg:px-8 lg:pb-12">
      <div className="max-w-[540px] mx-auto">
        {/* Section header */}
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-[#1a1a2e]">Pick a new time</h2>
          <button
            type="button"
            onClick={onCancel}
            className="text-xs text-[#9b9480] hover:text-[#6b6458] transition-colors underline underline-offset-2"
          >
            ← Cancel reschedule
          </button>
        </div>

        {/* Picker — rendered from deal-room renderPickerBubble */}
        <div className="rounded-2xl overflow-hidden border border-[#e7e2d5] bg-[#faf8f3]">
          {pickerSlot}
        </div>
      </div>
    </div>
  );
}
