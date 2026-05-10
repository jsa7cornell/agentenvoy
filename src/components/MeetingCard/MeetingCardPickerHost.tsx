"use client";

// Renamed from MeetingCardCalendarBlock 2026-05-09 to disambiguate from the new MeetingCardCalendarRow (which displays GCal RSVP status in confirmed states). PickerHost = picker wrapper for proposal/matched. CalendarRow = GCal status display for confirmed.

/**
 * MeetingCardPickerHost — calendar-connect bar + picker host slot.
 *
 * PR1 scope: calendar bar only (disconnected + connected states).
 * Picker host below the bar is a placeholder slot for PR2 to fill.
 *
 * Renders only when card `state === 'proposal' | 'matched'`.
 * Returns null for confirmed/confirming/skipped states.
 *
 * Calendar bar visual spec (from deal-room-card-first-r3.html, calbar class):
 *  Disconnected:
 *    - surface bg, border-bottom border
 *    - 24px icon box (surface-2 bg, border)
 *    - "Connect your calendar" bold + sub-line in text-3
 *    - "Connect →" right-aligned in indigo
 *
 *  Connected:
 *    - emerald-soft bg (#ecfdf5), emerald-line border-bottom (#a7f3d0)
 *    - white icon box with emerald-line border
 *    - "Calendar connected · [email]" with green check on right
 *
 * The outer pick-block wrapper: surface-2 bg, border-2 border, rounded-[13px].
 * Below the bar: children slot or PR2 placeholder.
 */

import type { MeetingCardProps } from "./types";

export function MeetingCardPickerHost({
  state,
  calendar,
  onConnectCalendar,
  children,
}: MeetingCardProps & { children?: React.ReactNode }) {
  // Only render in proposal/matched states
  if (state !== "proposal" && state !== "matched") return null;

  const connected = calendar?.connected ?? false;
  const email = connected && calendar?.connected ? (calendar as { connected: true; email: string }).email : undefined;

  return (
    <div className="mx-[18px] mb-[14px] bg-[#faf8f3] border border-[#dbd5c4] rounded-[13px] overflow-hidden">
      {/* Calendar bar */}
      {connected ? (
        /* Connected state */
        <div className="flex items-center gap-[10px] px-3 py-[9px] bg-[#ecfdf5] border-b border-[#a7f3d0] text-[12px] text-[#065f46] leading-snug">
          {/* Icon box */}
          <div className="w-[24px] h-[24px] rounded-[6px] flex-shrink-0 bg-white border border-[#a7f3d0] flex items-center justify-center text-[12px]">
            📅
          </div>
          {/* Text */}
          <div className="flex-1 min-w-0">
            <span className="font-semibold text-[#064e3b]">Calendar connected</span>
            {email && (
              <span className="text-[#065f46]"> · {email}</span>
            )}
          </div>
          {/* Check */}
          <div className="text-[#065f46] opacity-70 font-medium text-[11.5px] flex-shrink-0">✓</div>
        </div>
      ) : (
        /* Disconnected state */
        <button
          onClick={onConnectCalendar}
          className="w-full flex items-center gap-[10px] px-3 py-[9px] bg-white border-b border-[#e7e2d5] text-[12px] text-[#6b6458] leading-snug text-left hover:bg-[#faf8f3] transition-colors"
        >
          {/* Icon box */}
          <div className="w-[24px] h-[24px] rounded-[6px] flex-shrink-0 bg-[#faf8f3] border border-[#e7e2d5] flex items-center justify-center text-[12px]">
            📅
          </div>
          {/* Text */}
          <div className="flex-1 min-w-0">
            <div className="font-semibold text-[#1a1a2e]">Connect your calendar</div>
            <div className="text-[11px] text-[#9b9480]">I&apos;ll mark conflicts and find your best fit.</div>
          </div>
          {/* Connect action */}
          <div className="text-[11.5px] font-semibold text-indigo-500 flex-shrink-0">
            Connect →
          </div>
        </button>
      )}

      {/* Picker host slot — PR2 fills this */}
      {children ? (
        <div>{children}</div>
      ) : (
        <div className="p-3 text-[12px] text-[#9b9480]">
          Picker renders here in PR2
        </div>
      )}
    </div>
  );
}
