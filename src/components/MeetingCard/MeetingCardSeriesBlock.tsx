"use client";

// TODO PR1: implement per R4 mockup
// Series strip for recurring meetings — stubbed in Phase 1, implemented in Phase 3.
// Phase 1: this component renders nothing when props.series is present.
// Phase 3 (separate proposal): series strip rethink — possibly calendar mini-view
// or different metaphor per John's "I don't understand the series strip" (R3 review).
//
// When implemented, renders for confirmed/skipped recurring states:
//  - Cadence (Weekly · Wed 4 PM)
//  - Span (Started Mar 8 · ends Aug 15)
//  - Position (10 done · 1 confirmed · 4 ahead)
//  - 9-pill strip
//  - "Series details →" link

import type { MeetingCardProps } from "./types";

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function MeetingCardSeriesBlock(props: MeetingCardProps) {
  // Phase 1: stub — series data flows in but nothing renders.
  // Remove this comment and implement in Phase 3.
  return null;
}
