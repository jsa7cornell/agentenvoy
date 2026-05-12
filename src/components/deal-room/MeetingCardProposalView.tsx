"use client";

/**
 * MeetingCardProposalView — PR2c wrapper for proposal/matched/skipped/confirming
 * deal-room states. Mirrors MeetingCardConfirmedView but:
 *
 *  - No GCal RSVP fetch (no event yet)
 *  - No reschedule/skip actions on the card
 *  - Renders the AvailabilityCalendar BELOW the card via pickerSlot prop
 *  - Same EnvoyDock at the bottom
 *
 * PR2c — 2026-05-10
 * 2026-05-11: `showDashboardLink` prop — same pattern as MeetingCardConfirmedView.
 */

import { useRouter } from "next/navigation";
import { MeetingCard } from "@/components/MeetingCard/MeetingCard";
import { EnvoyDock } from "@/components/EnvoyDock/EnvoyDock";
import type { MeetingCardProps } from "@/components/MeetingCard/types";
import type { Message as ChatMessage } from "@/components/MeetingCard/types";

interface Props {
  cardProps: MeetingCardProps;
  /** Chat thread messages for EnvoyDock — derived from deal-room messages. */
  threadMessages: ChatMessage[];
  /** True when guest has the chat thread expanded. */
  threadExpanded: boolean;
  onExpandThread: () => void;
  onCollapseThread: () => void;
  onSendMessage: (text: string) => void;
  /**
   * The rendered AvailabilityCalendar (stripped of chat-bubble chrome).
   * Passed as a ReactNode so all picker props (slotsByDay, schedulingMode, etc.)
   * stay in deal-room — no prop drilling.
   */
  pickerSlot?: React.ReactNode;
  /**
   * The rendered confirm card (name/email/phone form + Confirm button) —
   * shown below the picker when a slot is picked or Envoy proposes a time.
   * Without this slot wired, picking a slot does nothing because the legacy
   * confirm card lives in a sibling render tree this view never reaches.
   */
  confirmSlot?: React.ReactNode;
  /**
   * Called when a guest-picks affordance (venue or format deferral) is tapped.
   * Expands the EnvoyDock thread and prefills the chat input with `prefill`.
   * Wired from deal-room.tsx — same pattern as onRequestEdit in ConfirmedView.
   * Optional: affordance renders even without it (visual-only mode).
   */
  onFocusChat?: (prefill: string) => void;
  /**
   * When true, renders a subtle ✕ button at top-right of the card section
   * that navigates the logged-in user back to /dashboard. Anonymous viewers
   * have no dashboard, so the button is never rendered for them.
   */
  showDashboardLink?: boolean;
  /**
   * First initial of the active viewer (host's or guest's). Propagated into
   * EnvoyDockThread so host and guest messages each show the right initial.
   */
  hostInitial?: string;
  guestInitial?: string;
  /** Admin flag — propagated into EnvoyDockThread for TurnCostOverlay +
   *  ThumbsDownFeedback under agent bubbles. */
  isAdmin?: boolean;
  /** NegotiationSession id — propagated into EnvoyDockThread so the
   *  ThumbsDownFeedback button under agent bubbles knows which thread to
   *  file against. */
  sessionId?: string | null;
}

export function MeetingCardProposalView({
  cardProps,
  threadMessages,
  threadExpanded,
  onExpandThread,
  onCollapseThread,
  onSendMessage,
  pickerSlot,
  confirmSlot,
  onFocusChat,
  showDashboardLink,
  hostInitial,
  guestInitial,
  isAdmin,
  sessionId,
}: Props) {
  const router = useRouter();
  // Stub out action handlers that don't apply pre-confirmation.
  // The MeetingCard component may render action slots — we silence any that
  // would be misleading in a proposal state.
  const noop = () => {};

  const cardPropsWithStubs: MeetingCardProps = {
    ...cardProps,
    // No calendar actions before confirmation
    onReschedule: noop,
    onSkip: noop,
    onSkipThis: noop,
    onCancel: noop,
    onShare: noop,
    onEditMeeting: noop,
    onAddToCalendar: noop,
    onAcceptInGoogleCalendar: noop,
    onOpenInGoogleCalendar: noop,
    onViewInGoogleCalendar: noop,
    onNudgeOther: noop,
    onEditTip: undefined,
    // Guest-picks affordances: focus EnvoyDock + prefill when tapped
    onFocusChat: onFocusChat,
  };

  return (
    <div className="flex-1 min-h-0 overflow-y-auto bg-[#f6f3ec]">
      {/* Card section — centered with max-width on both mobile + desktop */}
      <div className="px-4 py-4 lg:px-8 lg:py-8">
        <div className="max-w-[540px] mx-auto relative">
          {/* Dashboard back-button — logged-in users only (Bug 1 fix 2026-05-11).
              Same pattern and styling as MeetingCardConfirmedView. */}
          {showDashboardLink && (
            <button
              type="button"
              onClick={() => router.push("/dashboard")}
              aria-label="Back to dashboard"
              className="absolute top-3 right-3 z-10 w-8 h-8 flex items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80 transition-colors backdrop-blur-sm"
            >
              <span aria-hidden className="text-[15px] font-bold leading-none">✕</span>
            </button>
          )}
          <MeetingCard {...cardPropsWithStubs} />
        </div>
      </div>

      {/* Picker slot — AvailabilityCalendar rendered from deal-room.tsx.
          Shown below the card; skipped when null (e.g. confirming state).
          Background dropped here — the picker brings its own canvas. */}
      {pickerSlot && (
        <div className="px-4 pb-4 lg:px-8">
          <div className="max-w-[540px] mx-auto">
            <div className="rounded-2xl overflow-hidden border border-[#e7e2d5] bg-white">
              {pickerSlot}
            </div>
          </div>
        </div>
      )}

      {/* Confirm slot — name/email/phone form + Confirm button. Renders
          when a slot is picked (pendingProposal) or Envoy proposes a time.
          Without it, picking a slot can't actually book the meeting. */}
      {confirmSlot && (
        <div className="px-4 pb-4 lg:px-8">
          <div className="max-w-[540px] mx-auto">{confirmSlot}</div>
        </div>
      )}

      {/* Agent dock / chat thread — sits BELOW picker in normal document flow */}
      <div className="px-4 pb-6 lg:px-8 lg:pb-12">
        <div className="max-w-[540px] mx-auto">
          <EnvoyDock
            state={threadExpanded ? "thread" : "resting"}
            cardState={cardProps.state === "confirming" ? "confirming" : "proposal"}
            contextHostFirstName={cardProps.host.firstName}
            messages={threadMessages}
            onExpand={onExpandThread}
            onCollapse={onCollapseThread}
            hostInitial={hostInitial}
            guestInitial={guestInitial}
            isAdmin={isAdmin}
            sessionId={sessionId}
            onSendMessage={onSendMessage}
          />
        </div>
      </div>
    </div>
  );
}
