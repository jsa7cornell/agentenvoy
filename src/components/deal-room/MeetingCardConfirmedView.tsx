"use client";

/**
 * MeetingCardConfirmedView — PR2a wrapper that renders the new MeetingCard
 * + EnvoyDock for confirmed deal-room sessions. Replaces the old event-card
 * + sticky header for state === "confirmed" && !isGroupEvent only.
 *
 * All other deal-room states (proposal/matched/group/etc.) are unaffected
 * by this component — see proposal 2026-05-09 PR2a scope.
 *
 * PR2b adds: GCal RSVP status fetched from /api/negotiate/gcal-rsvp-status
 * on mount and passed to MeetingCard as `googleCalendar` prop. 401/403/null
 * responses gracefully suppress the calendar row.
 *
 * Action handlers stubbed for PR2a — wired in PR2c.
 */

import { useEffect, useState } from "react";
import { MeetingCard } from "@/components/MeetingCard/MeetingCard";
import { EnvoyDock } from "@/components/EnvoyDock/EnvoyDock";
import type { MeetingCardProps, GoogleCalendarStatus } from "@/components/MeetingCard/types";
import type { Message as ChatMessage } from "@/components/MeetingCard/types";

interface Props {
  /** NegotiationSession ID — used to fetch GCal RSVP status (PR2b). */
  sessionId: string | null;
  /**
   * NegotiationLink DB id — used to PATCH Link.parameters.tip when the host
   * edits the tip via the pencil affordance. Null for guests or when unknown.
   */
  linkId: string | null;
  cardProps: MeetingCardProps;
  /** Chat thread messages for EnvoyDock — derived from deal-room messages. */
  threadMessages: ChatMessage[];
  /** True when guest has the chat thread expanded. */
  threadExpanded: boolean;
  onExpandThread: () => void;
  onCollapseThread: () => void;
  onSendMessage: (text: string) => void;
  // ── Real action handlers wired from deal-room.tsx (2026-05-10 PR2c-lite) ──
  /** Open the existing cancel-confirmation modal. Wired from deal-room.tsx. */
  onOpenCancelModal?: () => void;
  /** Add to calendar — opens Google Calendar template URL in a new tab. */
  onAddToCalendar?: () => void;
  /** Reschedule — focuses the chat input + prefills text. */
  onRequestReschedule?: () => void;
  /** Edit meeting — focuses the chat input + prefills text. */
  onRequestEdit?: () => void;
  /** Share — copy link to clipboard or native share sheet. */
  onShareLink?: () => void;
  /** Deal-room URL for share fallback. */
  dealRoomUrl?: string;
}

export function MeetingCardConfirmedView({
  sessionId,
  linkId,
  cardProps,
  threadMessages,
  threadExpanded,
  onExpandThread,
  onCollapseThread,
  onSendMessage,
  onOpenCancelModal,
  onAddToCalendar: parentOnAddToCalendar,
  onRequestReschedule,
  onRequestEdit,
  onShareLink,
  dealRoomUrl,
}: Props) {
  // ── GCal RSVP status fetch (PR2b) ────────────────────────────────────────
  // Per spec § 6.1 + AP5c: GUEST-UI ONLY, server-derived from host's stored
  // GCal credentials. 401 = anonymous (silently suppress row); 403 = not
  // a participant; null = no event yet.
  const [gcalStatus, setGcalStatus] = useState<GoogleCalendarStatus | null>(cardProps.googleCalendar ?? null);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    fetch(`/api/negotiate/gcal-rsvp-status?sessionId=${encodeURIComponent(sessionId)}`)
      .then(async (res) => {
        if (!res.ok) return null; // 401/403/etc. — silently suppress
        const body = await res.json();
        return (body?.status ?? null) as GoogleCalendarStatus | null;
      })
      .then((status) => {
        if (!cancelled) setGcalStatus(status);
      })
      .catch(() => {
        // Silent failure — calendar row simply doesn't render
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  // PR2 SEED: host pencil edit — PATCH Link.parameters.tip.
  // Only wired for host viewers (cardProps.viewerRole === "host") with a known linkId.
  const handleEditTip = linkId && cardProps.viewerRole === "host"
    ? async (newText: string) => {
        const res = await fetch(`/api/me/links/${encodeURIComponent(linkId)}/tip`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tip: newText }),
        });
        if (!res.ok) {
          throw new Error(`Failed to save tip (${res.status})`);
        }
      }
    : undefined;

  // ── Real action handlers (2026-05-10 PR2c-lite wire-up) ────────────────────
  // Falls back to a no-op + console warning when parent didn't provide a handler.
  const noop = (label: string) => () => {
    console.warn(`[MeetingCardConfirmedView] no handler wired for: ${label}`);
  };

  // Default share — copy deal-room URL via clipboard with native-share fallback.
  const defaultShare = () => {
    if (!dealRoomUrl) return;
    const nav = typeof navigator !== "undefined" ? navigator : null;
    if (nav && typeof nav.share === "function") {
      nav.share({ url: dealRoomUrl }).catch(() => {
        // User cancelled or share failed — fall back to clipboard
        nav.clipboard?.writeText(dealRoomUrl).catch(() => {});
      });
    } else if (nav?.clipboard) {
      nav.clipboard.writeText(dealRoomUrl).catch(() => {});
    }
  };

  const effectiveGCal = gcalStatus ?? cardProps.googleCalendar;
  const gcalEventUrl = effectiveGCal?.eventUrl;
  const openGcal = gcalEventUrl
    ? () => window.open(gcalEventUrl, "_blank", "noopener")
    : noop("openGoogleCalendar");

  const cardPropsWithStubs: MeetingCardProps = {
    ...cardProps,
    googleCalendar: effectiveGCal ?? undefined,
    // Schedule actions
    onReschedule: onRequestReschedule ?? noop("reschedule"),
    onSkip: noop("skip"),
    onSkipThis: noop("skipThis"),
    // Destructive
    onCancel: onOpenCancelModal ?? noop("cancel"),
    // Share
    onShare: onShareLink ?? defaultShare,
    // Edit (opens chat)
    onEditMeeting: onRequestEdit ?? noop("editMeeting"),
    // Add to calendar — Google template URL via parent
    onAddToCalendar: parentOnAddToCalendar ?? noop("addToCalendar"),
    // GCal links — same handler (open the event URL in a new tab)
    onAcceptInGoogleCalendar: openGcal,
    onOpenInGoogleCalendar: openGcal,
    onViewInGoogleCalendar: openGcal,
    onNudgeOther: noop("nudgeOther"),
    onEditTip: handleEditTip,
  };

  return (
    <div className="flex-1 min-h-0 overflow-y-auto bg-[#f6f3ec]">
      {/* Card section — centered with max-width on both mobile + desktop */}
      <div className="px-4 py-4 lg:px-8 lg:py-8">
        <div className="max-w-[540px] mx-auto">
          <MeetingCard {...cardPropsWithStubs} />
        </div>
      </div>

      {/* Agent dock / chat thread — sits BELOW the card in normal document flow.
          No absolute positioning. Same layout on mobile + desktop. */}
      <div className="px-4 pb-6 lg:px-8 lg:pb-12">
        <div className="max-w-[540px] mx-auto">
          <EnvoyDock
            state={threadExpanded ? "thread" : "resting"}
            cardState="confirmed"
            contextHostFirstName={cardProps.host.firstName}
            messages={threadMessages}
            onExpand={onExpandThread}
            onCollapse={onCollapseThread}
            onSendMessage={onSendMessage}
          />
        </div>
      </div>
    </div>
  );
}
