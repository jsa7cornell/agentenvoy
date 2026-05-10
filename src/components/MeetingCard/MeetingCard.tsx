"use client";

/**
 * MeetingCard — composition root for the two-block card grammar.
 *
 * Composes: MeetingCardHero · MeetingCardInfoBlock · MeetingCardPickerHost
 *           · MeetingCardSeriesBlock · MeetingCardActions
 *
 * MeetingCardCalendarBlock renamed → MeetingCardPickerHost (2026-05-09).
 * MeetingCardCalendarRow is rendered inside MeetingCardInfoBlock (peer to channel/series rows).
 *
 * See proposal 2026-05-08 §2.1 for the two-block grammar spec.
 * Visual spec: previews/event-card-FINAL-portfolio.html (confirmed states)
 *              previews/deal-room-card-first-r3.html (proposal/matched states)
 *
 * Phase 1: component tree implemented. PR2 wires into deal-room.tsx.
 * Per-file LOC budget: ≤150 LOC composition (proposal 2026-05-08 §P2).
 */

import type { MeetingCardProps } from "./types";
import { MeetingCardHero } from "./MeetingCardHero";
import { MeetingCardInfoBlock } from "./MeetingCardInfoBlock";
import { MeetingCardPickerHost } from "./MeetingCardPickerHost";
import { MeetingCardSeriesBlock } from "./MeetingCardSeriesBlock";
import { MeetingCardActions } from "./MeetingCardActions";

export function MeetingCard(props: MeetingCardProps) {
  return (
    <div
      className="meeting-card rounded-[18px] overflow-hidden"
      style={{
        background: "#ffffff",
        border: "1px solid #e7e2d5",
        boxShadow: "0 4px 24px rgba(24,24,27,.07), 0 1px 4px rgba(24,24,27,.04)",
      }}
    >
      <MeetingCardHero {...props} />
      <MeetingCardInfoBlock {...props} />
      <MeetingCardSeriesBlock {...props} />
      <MeetingCardPickerHost {...props} />
      <MeetingCardActions {...props} />
    </div>
  );
}
