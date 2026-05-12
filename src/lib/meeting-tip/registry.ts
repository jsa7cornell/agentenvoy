import type { TipInput, TipTemplate } from "./types";
import { authoredLinkTip } from "./templates/authored-link-tip";
import { authoredDayOf } from "./templates/authored-day-of";
import { authoredTravel } from "./templates/authored-travel";
import { authoredFormat } from "./templates/authored-format";
import { derivedCalendarOverlap } from "./templates/derived-calendar-overlap";
import { derivedRelationshipHistory } from "./templates/derived-relationship-history";
import { derivedSeriesProgress } from "./templates/derived-series-progress";
import { derivedGuestPicksLocation } from "./templates/derived-guest-picks-location";
import { generativeFallback } from "./templates/generative-fallback";

const TEMPLATES: TipTemplate[] = [
  authoredLinkTip,
  authoredDayOf,
  authoredTravel,
  authoredFormat,
  derivedCalendarOverlap,
  derivedRelationshipHistory,
  derivedSeriesProgress,
  derivedGuestPicksLocation,
  generativeFallback,
].sort((a, b) => b.priority - a.priority);

export function selectTip(input: TipInput): TipTemplate | null {
  return TEMPLATES.find((t) => t.applies(input)) ?? null;
}

export const ALL_TEMPLATES = TEMPLATES;
