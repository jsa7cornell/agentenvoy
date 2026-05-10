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
 */

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
}: Props) {
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
  };

  return (
    <div className="flex-1 min-h-0 overflow-y-auto bg-[#f6f3ec]">
      {/* Card section — centered with max-width on both mobile + desktop */}
      <div className="px-4 py-4 lg:px-8 lg:py-8">
        <div className="max-w-[540px] mx-auto">
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
            onSendMessage={onSendMessage}
          />
        </div>
      </div>
    </div>
  );
}
