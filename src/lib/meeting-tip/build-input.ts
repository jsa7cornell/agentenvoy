import type { TipInput } from "./types";

export interface BuildTipInputArgs {
  hostName: string;
  inviteeName: string;
  linkFormat: string;
  linkActivity: string | null;
  linkLocation: string | null;
  isRecurring?: boolean;
  recurringPosition?: number;
  recurringTotal?: number;
  tipDayOf?: string | null;
  tipTravel?: string | null;
  tipFormat?: string | null;
  isAnonymousLink?: boolean;
  hasPriorSessions?: boolean;
  bothCalendarsConnected?: boolean;
  linkAuthoredTip?: string | null;
  guestPicksLocation?: boolean | null;
}

export function buildTipInput(args: BuildTipInputArgs): TipInput {
  return {
    hostFirstName: args.hostName?.split(" ")[0] ?? "your host",
    guestFirstName: args.inviteeName?.split(" ")[0] ?? "you",
    meetingFormat: (args.linkFormat as TipInput["meetingFormat"]) ?? "video",
    linkActivity: args.linkActivity ?? undefined,
    linkLocation: args.linkLocation ?? undefined,
    tipDayOf: args.tipDayOf ?? undefined,
    tipTravel: args.tipTravel ?? undefined,
    tipFormat: args.tipFormat ?? undefined,
    isAnonymousLink: args.isAnonymousLink ?? false,
    hasPriorSessions: args.hasPriorSessions ?? false,
    isRecurring: args.isRecurring ?? false,
    recurringPosition: args.recurringPosition,
    recurringTotal: args.recurringTotal,
    bothCalendarsConnected: args.bothCalendarsConnected,
    linkAuthoredTip: args.linkAuthoredTip ?? undefined,
    guestPicksLocation: args.guestPicksLocation ?? false,
  };
}
