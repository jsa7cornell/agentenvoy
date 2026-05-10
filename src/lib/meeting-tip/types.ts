import type { ViewerRole } from "@/components/MeetingCard/types";

export type TipSourceKind =
  | "authored-day-of"
  | "authored-travel"
  | "authored-format"
  | "derived-calendar-overlap"
  | "derived-relationship-history"
  | "derived-series-progress"
  | "generative-fallback";

export interface TipInput {
  hostFirstName: string;
  guestFirstName: string;
  meetingFormat: "video" | "phone" | "in-person";
  linkActivity?: string;
  linkLocation?: string;
  tipDayOf?: string;
  tipTravel?: string;
  tipFormat?: string;
  isAnonymousLink: boolean;
  hasPriorSessions: boolean;
  isRecurring: boolean;
  recurringPosition?: number;
  recurringTotal?: number;
  bothCalendarsConnected?: boolean;
}

export interface RenderedTip {
  text: string;
  source: string;
  sourceKind: TipSourceKind;
  templateId: string;
  generatedAt: string;
}

export interface TipTemplate {
  id: string;
  sourceKind: TipSourceKind;
  /** Source label — supports {host} substitution. */
  sourceLabel: string;
  applies: (input: TipInput) => boolean;
  /** Higher = checked first */
  priority: number;
  render: (input: TipInput, viewerRole: ViewerRole) => string;
}

export type { ViewerRole };
