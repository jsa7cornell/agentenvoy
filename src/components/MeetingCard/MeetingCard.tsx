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
  // Discoverability: data attributes preserve agent-platform parity with the
  // legacy OfferCard's `data-testid="deal-room-offer-card"` semantics. External
  // agents that DOM-scrape the deal-room (vs the preferred /agent.json + MCP
  // path) can target stable hooks. AGENT-PLATFORM Rule 13 compliance — the
  // visual surface change must not regress agent-readability.
  const ariaLabel = ariaForState(props);
  return (
    <article
      className="meeting-card rounded-[18px] overflow-hidden"
      data-testid="meeting-card"
      data-event-status={props.state}
      data-viewer-role={props.viewerRole}
      role="region"
      aria-label={ariaLabel}
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
    </article>
  );
}

function ariaForState(props: MeetingCardProps): string {
  const { state, host, guest, title, when, series } = props;
  const dateStr = when.time.toLocaleString("en-US", {
    timeZone: when.tz,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  const sessionPart = series ? ` (session ${series.position} of ${series.total})` : "";
  switch (state) {
    case "confirmed":
      return `Confirmed meeting: ${title} with ${host.firstName} and ${guest.firstName} on ${dateStr}${sessionPart}`;
    case "skipped":
      return `Skipped session: ${title}${sessionPart}`;
    case "matched":
      return `Match found for ${title}: ${dateStr}`;
    case "confirming":
      return `Confirming ${title} for ${dateStr}…`;
    case "proposal":
    default:
      return `Proposed meeting: ${title} with ${host.firstName} and ${guest.firstName}`;
  }
}
