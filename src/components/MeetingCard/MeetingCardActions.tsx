"use client";

/**
 * MeetingCardActions — vertical stack of indigo text links + ⋯ more-menu.
 *
 * Rule 7: all actions are plain indigo text links, stacked left-aligned.
 * No bordered buttons, no filled CTAs, no gradient primary.
 *
 * Action ordering (§ 3.7):
 *  1. Calendar action — state-driven from GoogleCalendarStatus (§ 3.14)
 *  2. Schedule actions — Reschedule / Reschedule this · Skip this / Undo skip
 *  3. Open in Google Calendar — suppressed when slot 1 is GCal-bound (anti-pattern guard)
 *
 * Anti-pattern guard (binding, § 3.14):
 *  actions.filter(a => a.targetUrl === googleCalendar?.eventUrl).length <= 1
 *  Never render two GCal CTAs simultaneously.
 *
 * ⋯ menu lives top-right of card (rendered by parent positioning).
 * This component renders only the bottom action stack + the more-menu trigger.
 *
 * Visual spec: previews/event-card-FINAL-portfolio.html (§ 12 confirmed states)
 */

import { useState, useRef, useEffect } from "react";
import type { MeetingCardProps, GoogleCalendarStatus, ViewerRole } from "./types";

// ── Text link action item ─────────────────────────────────────────────────────

interface ActionLink {
  icon: string;
  label: string;
  onClick?: () => void;
  /** Set when this link navigates to a GCal URL — used for anti-pattern guard. */
  targetUrl?: string;
}

function TextLink({ icon, label, onClick }: ActionLink) {
  return (
    <button
      onClick={onClick}
      style={{
        background: "transparent",
        border: "none",
        padding: "7px 0",
        textAlign: "left",
        fontSize: "13.5px",
        fontWeight: 500,
        color: "#4f46e5",
        display: "flex",
        alignItems: "center",
        gap: "9px",
        cursor: "pointer",
        width: "100%",
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLButtonElement).style.color = "#3730a3";
        (e.currentTarget as HTMLButtonElement).style.textDecoration = "underline";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.color = "#4f46e5";
        (e.currentTarget as HTMLButtonElement).style.textDecoration = "none";
      }}
    >
      <span style={{ fontSize: "12px", color: "inherit", width: "14px", textAlign: "center", flexShrink: 0 }}>
        {icon}
      </span>
      {label}
    </button>
  );
}

// ── Calendar action derivation (§ 3.14) ──────────────────────────────────────

function deriveCalendarAction(
  googleCalendar: GoogleCalendarStatus | undefined,
  viewerRole: ViewerRole,
  onAcceptInGoogleCalendar?: () => void,
  onOpenInGoogleCalendar?: () => void,
  onAddToCalendar?: () => void,
): ActionLink | null {
  // No event URL = no calendar event yet (or unknown). "Add to calendar"
  // template is the only useful action.
  if (!googleCalendar?.eventUrl) {
    return { icon: "📅", label: "Add to calendar", onClick: onAddToCalendar };
  }

  // We have a real GCal event URL. Host always sees plain "Open" (they're the
  // organizer, no RSVP semantics).
  if (viewerRole === "host") {
    return {
      icon: "📅",
      label: "Open in Google Calendar",
      onClick: onOpenInGoogleCalendar,
      targetUrl: googleCalendar.eventUrl,
    };
  }

  // Guest with known RSVP status — surface the relevant action.
  switch (googleCalendar.viewerStatus) {
    case "needsAction":
      return {
        icon: "📅",
        label: "Accept in Google Calendar",
        onClick: onAcceptInGoogleCalendar,
        targetUrl: googleCalendar.eventUrl,
      };
    case "tentative":
      return {
        icon: "📅",
        label: "Confirm in Google Calendar",
        onClick: onAcceptInGoogleCalendar,
        targetUrl: googleCalendar.eventUrl,
      };
    case "declined":
      return {
        icon: "📅",
        label: "Re-accept in Google Calendar",
        onClick: onAcceptInGoogleCalendar,
        targetUrl: googleCalendar.eventUrl,
      };
    case "accepted":
    case null:
    default:
      // 2026-05-10: when we have an eventUrl but no RSVP status (the async
      // /api/negotiate/gcal-rsvp-status fetch hasn't landed yet, OR returned
      // null because the guest hasn't connected GCal, OR the viewer is the
      // host viewing as guest), surface "Open in Google Calendar" rather
      // than the Add-to-calendar template — the user already has the invite,
      // re-adding from a template is wrong.
      return {
        icon: "📅",
        label: "Open in Google Calendar",
        onClick: onOpenInGoogleCalendar,
        targetUrl: googleCalendar.eventUrl,
      };
  }
}

// ── More menu popover ─────────────────────────────────────────────────────────

interface MoreMenuItem {
  label: string;
  onClick?: () => void;
  rose?: boolean;
  dividerAbove?: boolean;
}

function MoreMenu({
  items,
  onClose,
  anchorRef,
}: {
  items: MoreMenuItem[];
  onClose: () => void;
  anchorRef: React.RefObject<HTMLDivElement | null>;
}) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (
        menuRef.current &&
        !menuRef.current.contains(e.target as Node) &&
        anchorRef.current &&
        !anchorRef.current.contains(e.target as Node)
      ) {
        onClose();
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [onClose, anchorRef]);

  return (
    <div
      ref={menuRef}
      className="absolute bottom-[calc(100%+8px)] right-0 z-50 min-w-[200px] rounded-[13px] bg-white border border-zinc-200 py-1 overflow-hidden"
      style={{
        boxShadow:
          "0 24px 48px rgba(24,24,27,.10), 0 8px 16px rgba(24,24,27,.06)",
      }}
    >
      {items.map((item, i) => (
        <div key={i}>
          {item.dividerAbove && (
            <div className="my-1 border-t border-zinc-100" />
          )}
          <button
            onClick={() => {
              item.onClick?.();
              onClose();
            }}
            className="w-full text-left px-4 py-[9px] text-[13px] font-medium hover:bg-zinc-50 transition-colors cursor-pointer"
            style={item.rose ? { color: "#e11d48" } : { color: "#3f3f46" }}
          >
            {item.label}
          </button>
        </div>
      ))}
    </div>
  );
}

// ── Export ────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function MeetingCardActions(props: MeetingCardProps) {
  const {
    state,
    viewerRole,
    series,
    googleCalendar,
    onReschedule,
    onRescheduleThis,
    onRescheduleSession,
    onSkip,
    onSkipThis,
    onUndoSkip,
    onShare,
    onEditMeeting,
    onCancel,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    onEndSeries,
    onAcceptInGoogleCalendar,
    onOpenInGoogleCalendar,
    onAddToCalendar,
    onViewInGoogleCalendar,
  } = props;

  const [menuOpen, setMenuOpen] = useState(false);
  const moreAnchorRef = useRef<HTMLDivElement>(null);

  // No action stack for pre-confirmation states
  if (state === "proposal" || state === "matched" || state === "confirming") {
    return null;
  }

  const isRecurring = !!series;
  const isSkipped = state === "skipped";

  // ── Calendar action (slot 1) ────────────────────────────────────────────────
  const calendarAction = deriveCalendarAction(
    googleCalendar,
    viewerRole,
    onAcceptInGoogleCalendar,
    onOpenInGoogleCalendar ?? onViewInGoogleCalendar,
    onAddToCalendar,
  );

  // Anti-pattern guard: Open in GCal (slot 3) only renders when slot 1 is NOT GCal-bound.
  // A slot is GCal-bound when its targetUrl equals the eventUrl.
  const calendarActionIsGCalBound = !!calendarAction?.targetUrl && calendarAction.targetUrl === googleCalendar?.eventUrl;
  // When slot 1 is "Add to calendar" (no eventUrl), also suppress Open (no event exists yet for non-Connected viewers)
  const showStandaloneOpen = !calendarActionIsGCalBound && googleCalendar?.eventUrl && calendarAction?.targetUrl === googleCalendar.eventUrl;

  // ── More menu items ─────────────────────────────────────────────────────────
  // Per spec § 3.8: View on GCal moves to action stack (slot 1 handles it state-aware).
  const moreItems: MoreMenuItem[] = isRecurring
    ? [
        { label: "Edit meeting", onClick: onEditMeeting },
        { label: "Share", onClick: onShare },
        { label: "Cancel", onClick: onCancel, rose: true, dividerAbove: true },
      ]
    : [
        { label: "Edit meeting", onClick: onEditMeeting },
        {
          label: "Cancel meeting",
          onClick: onCancel,
          rose: true,
          dividerAbove: true,
        },
      ];

  // ── Build action list ───────────────────────────────────────────────────────
  const actions: ActionLink[] = [];

  // Slot 1: Calendar action
  if (calendarAction) {
    actions.push(calendarAction);
  }

  // Slot 2: Schedule actions
  if (isSkipped) {
    if (onUndoSkip) actions.push({ icon: "↩", label: "Undo skip", onClick: onUndoSkip });
    if (onShare) actions.push({ icon: "↗", label: "Share", onClick: onShare });
  } else if (isRecurring) {
    const rescheduleThis = onRescheduleThis ?? onRescheduleSession ?? onReschedule;
    if (rescheduleThis) actions.push({ icon: "↻", label: "Reschedule this", onClick: rescheduleThis });
    const skipThis = onSkipThis ?? onSkip;
    if (skipThis) actions.push({ icon: "⤫", label: "Skip this", onClick: skipThis });
  } else {
    if (onReschedule) actions.push({ icon: "↻", label: "Reschedule", onClick: onReschedule });
  }

  // Slot 3: Standalone "Open in Google Calendar" — only when slot 1 is NOT GCal-bound
  // Per anti-pattern guard: suppress when slot 1 already covers GCal.
  // Also suppress when no event URL exists (Add-to-calendar case means no event yet).
  if (showStandaloneOpen && (onOpenInGoogleCalendar ?? onViewInGoogleCalendar)) {
    actions.push({
      icon: "↗",
      label: "Open in Google Calendar",
      onClick: onOpenInGoogleCalendar ?? onViewInGoogleCalendar,
      targetUrl: googleCalendar?.eventUrl,
    });
  }

  return (
    <div className="border-t pt-2 mx-5 mb-3.5 relative">
      <div className="flex flex-col">
        {actions.map((action, i) => (
          <TextLink key={i} {...action} />
        ))}
      </div>

      {/* ⋯ more menu — top-right of the action zone */}
      <div ref={moreAnchorRef} className="absolute top-2 right-0">
        <button
          onClick={() => setMenuOpen((v) => !v)}
          className="text-zinc-400 hover:text-zinc-600 cursor-pointer bg-transparent border-none text-[16px] font-bold leading-none px-1"
          aria-label="More options"
        >
          ⋯
        </button>
        {menuOpen && (
          <MoreMenu
            items={moreItems}
            onClose={() => setMenuOpen(false)}
            anchorRef={moreAnchorRef}
          />
        )}
      </div>
    </div>
  );
}
