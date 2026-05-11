"use client";

/**
 * MeetingCardCalendarRow — GCal RSVP status row.
 *
 * Per spec § 3.14. Peer to channel row and series row in the meeting info zone.
 * Renders in confirmed states only, for registered viewers.
 *
 * Rendering modes:
 *  1. Connect-prompt: registered guest, no GCal connected → "Calendar not connected · Connect →"
 *  2. Guest viewer: GCal connected → "Google Calendar · {status pill}" + sub-line
 *  3. Host viewer: suppressed (2026-05-11) — the "{Guest}'s RSVP · Awaiting RSVP"
 *     line read as redundant context for hosts; row returns null for viewerRole === "host".
 *
 * Anonymous viewer (googleCalendar === undefined): returns null.
 * Anti-pattern guard: this row renders the status display only.
 * The calendar-action CTA (Accept / Open / etc.) lives in MeetingCardActions (slot 1).
 */

import type { GoogleCalendarStatus, ViewerRole, Participant } from "./types";

// ── Status pill ───────────────────────────────────────────────────────────────

type RsvpStatus = "needsAction" | "accepted" | "tentative" | "declined";

function StatusPill({ status }: { status: RsvpStatus }) {
  const config: Record<RsvpStatus, { label: string; bg: string; text: string; border: string }> = {
    needsAction: {
      label: "Awaiting RSVP",
      bg: "bg-amber-50",
      text: "text-amber-800",
      border: "border-amber-200",
    },
    tentative: {
      label: "Maybe",
      bg: "bg-amber-50",
      text: "text-amber-800",
      border: "border-amber-200",
    },
    accepted: {
      label: "Accepted ✓",
      bg: "bg-emerald-50",
      text: "text-emerald-700",
      border: "border-emerald-200",
    },
    declined: {
      label: "Declined",
      bg: "bg-rose-50",
      text: "text-rose-700",
      border: "border-rose-200",
    },
  };

  const { label, bg, text, border } = config[status];

  return (
    <span
      className={`inline-block text-[10.5px] font-semibold px-[7px] py-[2px] rounded-[5px] border ${bg} ${text} ${border}`}
    >
      {label}
    </span>
  );
}

// ── Guest sub-line copy ───────────────────────────────────────────────────────

function guestSubLine(status: RsvpStatus): string | null {
  switch (status) {
    case "needsAction":
      return "Accept the invite to add it to your day view";
    case "tentative":
      return "You've marked yourself as maybe — confirm when you're sure";
    case "accepted":
      return "This meeting is on your Google Calendar";
    case "declined":
      return "You declined — re-accept to add it back";
    default:
      return null;
  }
}

// ── Host mode ─────────────────────────────────────────────────────────────────
// Removed 2026-05-11: HostRow rendered "{Guest}'s RSVP · Awaiting RSVP" but
// felt confusing alongside the rest of the event-page context. The export
// below short-circuits host viewers to null. If we reintroduce a host-side
// calendar signal, do it in a fresh shape rather than reviving this.
// `hoursSince` helper was removed with HostRow (was only used for the
// "Invite sent Nh ago" / stale-nudge sub-line).

// ── Guest mode ────────────────────────────────────────────────────────────────

function GuestRow({ status }: { status: RsvpStatus }) {
  const subLine = guestSubLine(status);
  return (
    <div className="flex items-start gap-[9px] text-[13px] text-zinc-600 pt-2">
      <span className="text-[14px] w-5 text-center flex-shrink-0 text-zinc-400 leading-[1.45]">
        📅
      </span>
      <div className="flex-1 min-w-0 leading-[1.45]">
        <div className="flex items-center gap-[7px] flex-wrap">
          <span className="font-semibold text-zinc-700">Google Calendar</span>
          <StatusPill status={status} />
        </div>
        {subLine && (
          <div className="text-[11.5px] text-zinc-400 mt-[2px]">{subLine}</div>
        )}
      </div>
    </div>
  );
}

// ── Connect prompt ────────────────────────────────────────────────────────────

function ConnectPromptRow() {
  return (
    <div className="flex items-start gap-[9px] text-[13px] text-zinc-600 pt-2">
      <span className="text-[14px] w-5 text-center flex-shrink-0 text-zinc-400 leading-[1.45]">
        📅
      </span>
      <div className="flex-1 min-w-0 leading-[1.45]">
        <span className="text-zinc-500">Calendar not connected</span>
        <span className="text-zinc-400"> · </span>
        <button className="text-indigo-600 font-medium hover:text-indigo-800 hover:underline bg-transparent border-none p-0 cursor-pointer text-[13px]">
          Connect →
        </button>
      </div>
    </div>
  );
}

// ── Export ────────────────────────────────────────────────────────────────────

export interface MeetingCardCalendarRowProps {
  googleCalendar: GoogleCalendarStatus | undefined;
  viewerRole: ViewerRole;
  /** Retained for API compatibility — callers still pass these. They were
   *  consumed by HostRow (removed 2026-05-11); leaving them on the props
   *  keeps call sites working and lets us reintroduce a host-side row
   *  without churning every caller. */
  guest: Participant;
  onNudgeOther?: () => void;
}

export function MeetingCardCalendarRow({
  googleCalendar,
  viewerRole,
}: MeetingCardCalendarRowProps) {
  // Anonymous viewer — no signal to show
  if (!googleCalendar) return null;

  // Host viewer: the "{Guest}'s RSVP — Awaiting RSVP" line was confusing
  // (John feedback 2026-05-11). The guest's calendar status is implicit in
  // the broader card state, so we suppress the row for hosts entirely.
  if (viewerRole === "host") {
    return null;
  }

  // Guest viewer
  if (googleCalendar.viewerStatus) {
    return <GuestRow status={googleCalendar.viewerStatus} />;
  }

  if (googleCalendar.connectPromptEligible) {
    return <ConnectPromptRow />;
  }

  return null;
}
