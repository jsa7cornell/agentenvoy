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
 *
 * 2026-05-11: `showDashboardLink` prop — renders a subtle ✕ at top-right
 * of the card section for logged-in users (isHost || isGuest). Navigates
 * to /dashboard. Anonymous viewers never see it (no dashboard to go to).
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { MeetingCard } from "@/components/MeetingCard/MeetingCard";
import { EnvoyDock } from "@/components/EnvoyDock/EnvoyDock";
import { SendFeedbackLink } from "@/components/send-feedback";
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
  /**
   * Optional render slot inserted BETWEEN the card and the agent dock.
   * Used in reschedule mode to render the picker overlay so the agent
   * appears below the picker, matching user instruction 2026-05-10.
   */
  belowCardSlot?: React.ReactNode;
  /**
   * When true, renders a subtle ✕ button at the top-right of the card
   * section that navigates the user back to /dashboard. Set only when the
   * viewer is logged in (isHost || isGuest). Anonymous viewers have no
   * dashboard, so we never render the button for them.
   */
  showDashboardLink?: boolean;
  /**
   * NegotiationLink.code used to file a feedback report for this deal-room.
   * Should be `feedbackCode ?? code` from deal-room.tsx — for non-bookable
   * visits, the URL code IS the child code; for bookable visits feedbackCode
   * is the minted child. Missing in the legacy → new card cutover (2026-05-11
   * regression) meant guests couldn't file feedback from the new surface.
   */
  feedbackLinkCode?: string;
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
  belowCardSlot,
  showDashboardLink,
  feedbackLinkCode,
}: Props) {
  const router = useRouter();
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

  // 2026-05-11 layout: card always at its natural size at the top; thread
  // grows vertically beneath it, never covering it. The whole surface
  // page-scrolls when card + thread exceed viewport. Thread carries its
  // own max-h with internal message-list scroll so the composer doesn't
  // get pushed too far below the fold on long threads.
  return (
    <div className="flex-1 min-h-0 overflow-y-auto bg-[#f6f3ec]">
      {/* Card section — centered with max-width on both mobile + desktop.
          2026-05-11: tightened so the card + chat fit on a normal-sized
          desktop viewport. Bottom padding further trimmed when a
          belowCardSlot (reschedule picker) is rendered. */}
      <div className={`px-4 lg:px-8 ${belowCardSlot ? "pt-2 pb-2 lg:pt-3 lg:pb-2" : "py-2 lg:py-4"}`}>
        <div className="max-w-[540px] mx-auto relative">
          {/* Dashboard back-button — logged-in users only (Bug 1 fix 2026-05-11).
              Positioned absolute top-right so it doesn't crowd the card's own
              ⋯ menu (which lives inside the MeetingCard article). Uses the same
              visual weight as the ⋯ button — small, circular hover target. */}
          {showDashboardLink && (
            <button
              type="button"
              onClick={() => router.push("/dashboard")}
              aria-label="Back to dashboard"
              className="absolute top-0 right-0 z-10 w-8 h-8 flex items-center justify-center rounded-full text-[#9b9480] hover:text-[#1a1a2e] hover:bg-black/5 transition-colors"
            >
              <span aria-hidden className="text-[18px] leading-none">✕</span>
            </button>
          )}
          <MeetingCard {...cardPropsWithStubs} />
        </div>
      </div>

      {/* Optional slot between card and dock — used in reschedule mode to
          render the picker so the agent dock appears BELOW the picker
          (per user instruction 2026-05-10). */}
      {belowCardSlot && (
        <div className="px-4 pb-3 lg:px-8 lg:pb-4">
          <div className="max-w-[540px] mx-auto">{belowCardSlot}</div>
        </div>
      )}

      {/* Agent dock / chat thread — sits BELOW the card in page flow.
          Never overlaps the card; grows vertically with internal scroll
          inside the thread (EnvoyDockThread carries its own max-h). */}
      <div className="px-4 pb-3 lg:px-8 lg:pb-4">
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
          {/* Send-feedback affordance — restored to the new card surface
              (2026-05-11). Anchored under the dock so it's reachable
              regardless of whether the thread is expanded. */}
          {feedbackLinkCode && (
            <div className="mt-2 flex justify-end">
              <SendFeedbackLink
                mode={cardProps.viewerRole === "host" ? "host-deal-room" : "guest-deal-room"}
                linkCode={feedbackLinkCode}
                sessionId={sessionId ?? undefined}
                className="text-[10px]"
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
