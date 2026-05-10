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

  // PR2a action stubs — real handlers wired in PR2c.
  const stubAction = (label: string) => () =>
    console.log(`PR2c: wire ${label} handler`);

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

  const cardPropsWithStubs: MeetingCardProps = {
    ...cardProps,
    googleCalendar: gcalStatus ?? cardProps.googleCalendar ?? undefined,
    onReschedule: stubAction("reschedule"),
    onSkip: stubAction("skip"),
    onSkipThis: stubAction("skipThis"),
    onCancel: stubAction("cancel"),
    onShare: stubAction("share"),
    onEditMeeting: stubAction("editMeeting"),
    onAddToCalendar: stubAction("addToCalendar"),
    onAcceptInGoogleCalendar: (gcalStatus ?? cardProps.googleCalendar)?.eventUrl
      ? () => window.open((gcalStatus ?? cardProps.googleCalendar)!.eventUrl, "_blank", "noopener")
      : stubAction("acceptInGoogleCalendar"),
    onOpenInGoogleCalendar: (gcalStatus ?? cardProps.googleCalendar)?.eventUrl
      ? () => window.open((gcalStatus ?? cardProps.googleCalendar)!.eventUrl, "_blank", "noopener")
      : stubAction("openInGoogleCalendar"),
    onViewInGoogleCalendar: (gcalStatus ?? cardProps.googleCalendar)?.eventUrl
      ? () => window.open((gcalStatus ?? cardProps.googleCalendar)!.eventUrl, "_blank", "noopener")
      : stubAction("viewInGoogleCalendar"),
    onNudgeOther: stubAction("nudgeOther"),
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
