import type { ViewerRole } from "@/components/MeetingCard/types";

export type TipSourceKind =
  | "authored-day-of"
  | "authored-travel"
  | "authored-format"
  | "derived-calendar-overlap"
  | "derived-relationship-history"
  | "derived-series-progress"
  | "derived-guest-picks-location"
  /**
   * 2026-05-12 event-data-model proposal (PR-2):
   * Model-generated tip from `generateMeetingNotes` (Haiku 4.5) at create time
   * or on edit triggers (activity / time / invitee change). Lands in
   * `parameters.generatedTip`. Priority sits BELOW `authored-link-tip` (host
   * pencil edit) so host-authored tips always win. Additive sourceKind value
   * per the MCP-reconciliation §"get_tip" decision — external agents
   * pattern-matching the existing enum fall through to a default branch.
   */
  | "generative-author-time"
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
  /** Host's authored tip from Link.parameters.tip — highest priority. */
  linkAuthoredTip?: string;
  /** Host deferred venue selection to the guest (`guestPicks.location: true`). */
  guestPicksLocation?: boolean;
  /**
   * Model-generated tip from `generateMeetingNotes` (Haiku 4.5), persisted
   * on `Link.parameters.generatedTip` at create time and on edit triggers
   * (activity / time / invitee change). Priority sits below `linkAuthoredTip`
   * but above derived templates. 2026-05-12 event-data-model proposal.
   */
  linkGeneratedTip?: string;
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
