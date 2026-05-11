"use client";

import React, { useState, useRef, useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import {
  resolveTimeOfDayTheme,
  hasNoStoredThemePreference,
} from "@/lib/time-of-day-theme";
import { AvailabilityCalendar } from "./availability-calendar";
import { MatchPulse } from "./match-pulse";
import { CelebrationBanner } from "./celebration-banner";
import { DashboardHeader } from "./dashboard-header";
import { PublicHeader } from "./public-header";
import { DealRoomConnectCtas } from "./oauth/deal-room-connect-ctas";
import { formatDeferralFieldsList, type DeferralFieldNoun } from "@/agent/greetings/registry";
import { TimezonePicker } from "./timezone-picker";
import { useOAuthSignIn } from "./oauth/use-oauth-signin";
import { onboardingCallbackUrl } from "@/lib/onboarding/return-to";
import type { TimeChipData } from "./time-chip-list";
import { OfferCard } from "./deal-room/offer-card";
import { ExternalAgentPrimer } from "./deal-room/external-agent-primer";
import { SendFeedbackLink } from "./send-feedback";
import { formatDuration } from "@/lib/format-duration";
import { stripRendererOnlyBlocks } from "@/lib/message-render";
import { mergePollResult, type LiveSyncMessage } from "@/lib/deal-room-live-sync";
import { emojiForActivity } from "@/lib/activity-vocab";
import { hostFirstName as resolveHostFirstName } from "@/lib/host-naming";
import { EditedPill } from "@/components/edited-pill";
import { deriveMode, type DealRoomMode } from "@/lib/deal-room-mode";
import {
  hasSeenPrimer,
  markPrimerSeen,
  cleanupPrimersForSession,
} from "@/lib/primer-state";
import {
  isExternalAgentMetaNarration,
  agentIdentityFrom,
} from "@/lib/external-agent-meta";
import {
  getRoleStyles,
  computeExternalAgentSender,
} from "./deal-room-role-dispatch";
import { ThumbsDownFeedback } from "./thumbs-down-feedback";
// PR2a — confirmed-state MeetingCard + EnvoyDock wire-in
import { MeetingCardConfirmedView } from "./deal-room/MeetingCardConfirmedView";
import { MeetingCardErrorBoundary } from "./deal-room/MeetingCardErrorBoundary";
import { dealRoomToMeetingCardProps } from "./deal-room/dealRoomToMeetingCardProps";
import type { Message as ChatMessage } from "@/components/MeetingCard/types";
// PR2c — proposal/matched/skipped states + reschedule overlay
import { MeetingCardProposalView } from "./deal-room/MeetingCardProposalView";
import { RescheduleOverlay } from "./deal-room/RescheduleOverlay";

interface DelegateSpeaker {
  kind: "human_assistant" | "ai_agent" | "unknown";
  name?: string;
}

interface Message {
  id: string;
  role: string;
  content: string;
  // Per-message metadata — used for proxy attribution (Slice 9) and other
  // per-message signals. Loose shape intentionally.
  metadata?: {
    delegateSpeaker?: DelegateSpeaker;
    [key: string]: unknown;
  } | null;
  createdAt?: string;
}

// ─── MESSAGE_ROLE_DISPATCH ─────────────────────────────────────────────────
// Searchable anchor (banner micro-spec B2/N6). The style lookup and pure
// sender-line computation live in deal-room-role-dispatch.ts — a plain
// .ts file so unit tests can import without running through the JSX
// parser. Grep for MESSAGE_ROLE_DISPATCH across the repo to jump between
// the dispatch helper, this JSX wrapper, and the render site below.

/**
 * Renders the sender line for an `external_agent` message. JSX wrapper
 * around computeExternalAgentSender.
 *
 * The 🤖 badge is a SINGLE DOM node with role="img" and
 * aria-label="posted by external agent" — screen readers read the label,
 * not "robot face". The visible sender text starts after the badge with no
 * second emoji character (micro-spec N2). Browser-native `title` tooltip
 * for v1 (N7: keyboard-focusable tooltip is a v2 upgrade).
 */
function renderExternalAgentSender(
  metadata: Record<string, unknown> | null | undefined,
  labelColor: string,
) {
  const { headline, tooltip } = computeExternalAgentSender(metadata);
  return (
    <div
      className={`text-[10px] font-bold uppercase tracking-wider mb-1 ${labelColor}`}
      title={tooltip}
    >
      <span role="img" aria-label="posted by external agent" className="mr-1">
        🤖
      </span>
      {headline}
    </div>
  );
}
// ─── end MESSAGE_ROLE_DISPATCH ─────────────────────────────────────────────

interface DealRoomProps {
  slug: string;
  code?: string;
}

function GroupDayGrid({
  candidateDays,
  responses,
  hostName,
  mySessionId,
  myPersonLabel,
  isHost,
  onVote,
}: {
  candidateDays: string[];
  responses: Array<{ person: string; dayVotes?: Record<string, boolean> }>;
  hostName: string;
  mySessionId: string | null;
  myPersonLabel?: string;
  isHost: boolean;
  onVote: (date: string, available: boolean) => void;
}) {
  // Collect all participant names from responses (excluding host)
  const participantNames = Array.from(new Set(responses.map((r) => r.person).filter((n) => n !== hostName)));
  const columns = [hostName || "Host", ...participantNames];

  const getVote = (person: string, date: string): boolean | undefined => {
    const row = responses.find((r) => r.person === person);
    return row?.dayVotes?.[date];
  };

  const myLabel = myPersonLabel || (mySessionId ? `Guest (${mySessionId.slice(-4)})` : null);
  const myColIndex = myLabel ? columns.indexOf(myLabel) : -1;

  const formatDay = (iso: string) => {
    const d = new Date(iso + "T00:00:00");
    return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  };

  return (
    <div className="mt-3 overflow-x-auto">
      <table className="text-xs border-collapse w-full">
        <thead>
          <tr>
            <th className="text-left pr-3 pb-1 font-medium text-secondary whitespace-nowrap">Day</th>
            {columns.map((col, i) => (
              <th key={i} className="px-2 pb-1 font-medium text-secondary text-center whitespace-nowrap max-w-[80px] truncate">
                {col === hostName ? (hostName ? hostName.split(" ")[0] : "Host") : col.split(" ")[0]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {candidateDays.map((date) => (
            <tr key={date} className="border-t border-border/30">
              <td className="pr-3 py-1 text-secondary whitespace-nowrap">{formatDay(date)}</td>
              {columns.map((col, colIdx) => {
                const isHostCol = col === hostName;
                const vote = isHostCol ? true : getVote(col, date);
                const isMyCol = !isHost && colIdx === myColIndex;
                const isMyColByLabel = !isHost && col === myLabel;
                const canClick = isMyCol || isMyColByLabel;

                const cell =
                  vote === true ? "✓" :
                  vote === false ? "✗" :
                  "·";
                const cellColor =
                  vote === true ? "text-emerald-500" :
                  vote === false ? "text-red-400" :
                  "text-muted";

                return (
                  <td key={colIdx} className="px-2 py-1 text-center">
                    {canClick ? (
                      <button
                        onClick={() => onVote(date, vote !== true)}
                        className={`w-6 h-6 rounded text-sm font-semibold transition-colors ${
                          vote === true
                            ? "bg-emerald-500/20 text-emerald-500 hover:bg-red-400/20 hover:text-red-400"
                            : vote === false
                            ? "bg-red-400/20 text-red-400 hover:bg-emerald-500/20 hover:text-emerald-500"
                            : "bg-zinc-700/40 text-muted hover:bg-emerald-500/20 hover:text-emerald-500"
                        }`}
                        title={vote === true ? "Click to mark unavailable" : "Click to mark available"}
                      >
                        {cell}
                      </button>
                    ) : (
                      <span className={`${cellColor} font-semibold`}>{cell}</span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function DealRoom({ slug, code }: DealRoomProps) {
  const router = useRouter();
  const { setTheme } = useTheme();
  // Time-of-day theme default (2026-04-21 deal-room reshape, thread G).
  // If the guest has no stored theme preference, pick light/dark based
  // on their local wall-clock. Any explicit toggle still wins — this only
  // fires on first visit when localStorage has no "theme" entry.
  useEffect(() => {
    if (hasNoStoredThemePreference()) {
      setTheme(resolveTimeOfDayTheme());
    }
  }, [setTheme]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  /** NegotiationLink DB id — used by MeetingCardConfirmedView to PATCH tip. */
  const [linkDbId, setLinkDbId] = useState<string | null>(null);
  /** Raw link.parameters JSON — used for authored tip read path (PR2 SEED pivot). */
  const [linkParameters, setLinkParameters] = useState<Record<string, unknown> | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSending, setIsSending] = useState(false);
  // Stage 1 live-sync (§8.4 B1 fold): suppress the 10s poll while a stream
  // is in flight to avoid racing poll results against mid-stream temp-id
  // bubbles. Flipped true at the top of handleSend before the POST fires;
  // flipped false 500ms after the stream closes so the subsequent poll
  // can observe the onFinish-persisted admin row.
  const [isStreaming, setIsStreaming] = useState(false);
  const [hostName, setHostName] = useState("");
  const [isHost, setIsHost] = useState(false);
  // Bilateral: logged-in guest (authenticated User, not the host).
  // Anonymous guests leave this false.
  const [isGuest, setIsGuest] = useState(false);
  const [guestUser, setGuestUser] = useState<{
    id: string;
    name: string | null;
    email: string | null;
  } | null>(null);
  const [topic, setTopic] = useState("");
  // Per-field "Edited just now" pill — proposal 2026-04-28 §3.C.
  // Server returns lastMaterialEditAt (ISO string or null) + lastEditedFields
  // (string[] of canonical material field names, see material-fields.ts).
  // EditedPill below computes freshness + humanizes the field list.
  const [lastMaterialEditAt, setLastMaterialEditAt] = useState<string | null>(null);
  const [lastEditedFields, setLastEditedFields] = useState<string[]>([]);
  const [linkFormat, setLinkFormat] = useState("");
  const [linkStartTime, setLinkStartTime] = useState<string | null>(null); // "HH:MM" for date-mode events
  const [linkLocation, setLinkLocation] = useState<string | null>(null);
  const [linkActivity, setLinkActivity] = useState<string | null>(null);
  const [linkActivityIcon, setLinkActivityIcon] = useState<string | null>(null);
  const [linkActivityOptions, setLinkActivityOptions] = useState<string[] | null>(null);
  const [linkGuestPicksLocation, setLinkGuestPicksLocation] = useState(false);
  // Other guestPicks deferrals — drive "(proposed)" suffix on event card
  // fields per 2026-04-29 feedback. Format/duration/date can each be deferred
  // independently; the card surfaces each via a per-field suffix.
  const [linkGuestPicksFormat, setLinkGuestPicksFormat] = useState(false);
  const [linkGuestPicksDuration, setLinkGuestPicksDuration] = useState(false);
  const [linkGuestPicksDate, setLinkGuestPicksDate] = useState(false);
  const [guestChatOpen, setGuestChatOpen] = useState(true);
  const [linkTimingLabel, setLinkTimingLabel] = useState<string | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [inviteeNames, setInviteeNames] = useState<string[]>([]); // full list — used in PR-C group display
  const [inviteeName, setInviteeName] = useState(""); // deprecated bridge — first of inviteeNames
  const [guestEmail, setGuestEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [archivedData, setArchivedData] = useState<{ hostEmail: string | null; hostName: string | null; hostMeetSlug: string | null } | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [confirmData, setConfirmData] = useState<Record<string, unknown> | null>(null);
  // PR2a — track whether the EnvoyDock thread is expanded in confirmed view
  const [confirmedThreadExpanded, setConfirmedThreadExpanded] = useState(false);
  // PR2c — when true, renders the reschedule picker below the confirmed card
  const [reschedulingFromConfirmed, setReschedulingFromConfirmed] = useState(false);
  /**
   * PR2a safety: when the new MeetingCardConfirmedView render path crashes
   * client-side, the error boundary flips this flag and we fall through to
   * the legacy event-card render on the next render. Prevents the blank-
   * page "Application error" experience from stranding users mid-confirm.
   * 2026-05-10 hotfix.
   */
  const [meetingCardCrashed, setMeetingCardCrashed] = useState(false);
  // Dismissible banner shown above legacy fallback when the error boundary trips.
  // No localStorage — resets on refresh. 2026-05-10 punch-list #13.
  const [meetingCardCrashedBannerDismissed, setMeetingCardCrashedBannerDismissed] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [emailWarning, setEmailWarning] = useState<string | null>(null);
  const [calendarConnected, setCalendarConnected] = useState(false);
  const [calendarDenied, setCalendarDenied] = useState(false);
  /** Tracks the post-OAuth slot/bilateral refetch — toggled true while
   *  the /api/negotiate/slots fetch is in flight so the picker surface
   *  can show a "matching availability…" spinner instead of a blank gap.
   *  Pure UI signal; no business logic depends on it. */
  const [postConnectRefetching, setPostConnectRefetching] = useState(false);
  const [showDetailsModal, setShowDetailsModal] = useState(false);
  const [showCancelModal, setShowCancelModal] = useState(false);
  const [showActionMenu, setShowActionMenu] = useState(false);
  const actionMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!showActionMenu) return;
    function onDocClick(e: MouseEvent) {
      if (actionMenuRef.current && !actionMenuRef.current.contains(e.target as Node)) {
        setShowActionMenu(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [showActionMenu]);
  const [isCancelling, setIsCancelling] = useState(false);
  const [isArchiving, setIsArchiving] = useState(false);
  const [gcalStatus, setGcalStatus] = useState<{
    eventExists: boolean;
    guestOnInvite: boolean;
    guestResponseStatus: "accepted" | "declined" | "tentative" | "needsAction" | null;
    htmlLink?: string | null;
  } | null>(null);
  const [sessionStatus, setSessionStatus] = useState<string>("active");
  const [, setSessionStatusLabel] = useState<string>("");
  const [statusAnimating, setStatusAnimating] = useState(false);
  const [isGroupEvent, setIsGroupEvent] = useState(false);
  const [participants, setParticipants] = useState<Array<{ name: string; status: string }>>([]);
  const [groupCoordination, setGroupCoordination] = useState<{
    candidateDays: string[] | null;
    responses: Array<{ person: string; dayVotes?: Record<string, boolean> }>;
  } | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesScrollRef = useRef<HTMLDivElement>(null);
  const prevStatusRef = useRef<string>("active");

  // Slots state for availability calendar sidebar
  const [slotsByDay, setSlotsByDay] = useState<Record<string, Array<{ start: string; end: string; score?: number; isShortSlot?: boolean; isStretch?: boolean }>> | null>(null);
  const [slotTimezone, setSlotTimezone] = useState("America/New_York");
  // Host's timezone for the picker's "{host} is in {host-tz}" label and the
  // dual-tz parity with the Envoy follow-up chat in composer.ts. Populated
  // from the session POST response. Null until that resolves.
  const [hostTimezone, setHostTimezoneState] = useState<string | null>(null);
  // Viewer-authoritative tz on the session (from DB). Drives the picker's
  // selected chip and the dual-tz trigger in composer.ts. Null before first
  // card render seeds it — the TimezonePicker owns the first-render POST.
  const [viewerTimezone, setViewerTimezoneState] = useState<string | null>(null);
  const [slotLocation, setSlotLocation] = useState<{ label: string; until?: string } | null>(null);
  const [slotDuration, setSlotDuration] = useState<number | undefined>(undefined);
  const [slotMinDuration, setSlotMinDuration] = useState<number | undefined>(undefined);
  // B2: fallback duration from session response — used when slotDuration is
  // undefined (e.g. slots API returned compute_failed). Session response is
  // the authoritative source for link-configured duration; slots API is the
  // authoritative source for computed availability duration.
  const [linkDuration, setLinkDuration] = useState<number | undefined>(undefined);
  // B3: child link code returned by session response — used for feedback auth.
  // feedbackCode is the child NegotiationLink.code (e.g. "hf5uex");
  // code (from URL) is the bookable rule's linkCode (e.g. "q89wdvt4").
  // The feedback route looks up by NegotiationLink.code; feedbackCode ?? code
  // is correct because for non-bookable visits, feedbackCode IS the minted
  // personalized code (same thing as code).
  const [feedbackCode, setFeedbackCode] = useState<string | undefined>(undefined);
  // B5: signals that this session is a bookable child link (has recurringWindowId).
  // Used to render the guest-facing "Bookable" subtitle when !isHost.
  const [isBookable, setIsBookable] = useState(false);
  const [schedulingMode, setSchedulingMode] = useState<"time" | "date">("time");
  const [isVip, setIsVip] = useState(false);
  // WISHLIST §1o PR-α: three-state response from `/api/negotiate/slots`
  // disambiguates the previously-silent fall-through where any compute throw,
  // disconnected calendar, or genuine zero-slot state all returned the same
  // empty `slotsByDay: {}` payload. `null` here means "haven't fetched yet"
  // — the picker bubble's existing `slotsByDay==null` guard already short-
  // circuits in that pre-fetch window so no inline message flashes.
  const [slotFetchState, setSlotFetchState] = useState<
    | { kind: "idle" }
    | { kind: "ok" }
    | { kind: "no_slots" }
    | { kind: "calendar_disconnected" }
    | { kind: "compute_failed" }
  >({ kind: "idle" });
  // Bilateral chip data — populated only when the session has a logged-in
  // guest whose calendar is connected. When absent, no chips render and the
  // existing host-only availability widget carries the interaction load.
  const [bilateralByDay, setBilateralByDay] = useState<Record<string, TimeChipData[]> | null>(null);
  // PR-B2 of bilateral+picker bundle: the canonical bilateral payload from
  // PR-A1's slots-route migration. Detailed tab in the picker reads from
  // this directly — single source of truth shared with Best matches.
  const [bilateralPayload, setBilateralPayload] = useState<
    import("@/lib/bilateral-availability").BilateralPayload | null
  >(null);
  // T4: one-shot trigger for MatchPulse. Flips true on the render cycle
  // when bilateralByDay first becomes non-empty, then resets next tick.
  const [justMatched, setJustMatched] = useState(false);
  const prevHadMatchRef = useRef(false);

  // TZ recovery banner state (Slice 7). When someone raced ahead of the human
  // guest — host, MCP agent, or a proxy — the session's guestTimezone ends up
  // set to a different TZ than the human guest's browser. Banner asks whether
  // to switch the thread to the guest's TZ. Silent otherwise.
  const [sessionTimezone, setSessionTimezone] = useState<string | null>(null);
  const [tzBannerDismissed, setTzBannerDismissed] = useState(false);
  const [isSwitchingTz, setIsSwitchingTz] = useState(false);

  // Anonymous calendar-link CTA state (Slice 8). Anonymous guests — no
  // AgentEnvoy account — can OAuth a read-only Google Calendar connect from
  // the deal room. After a successful round-trip the bilateral chips appear
  // just like they do for logged-in guests (same compute path, different
  // storage). Dismissal persists per-session in localStorage.
  // Post-confirm signup upsell dismissal (client-only state)
  const [signupUpsellDismissed, setSignupUpsellDismissed] = useState(false);
  // Signup-upsell modal: guest just booked a meeting and we're asking them
  // to create a host account. This is a true first-connect signup (not a
  // reconnect), so it gets the full trust-building first-connect modal.
  // `entryPoint: "deal-room-upsell"` audits against read-only scope only
  // (HOST_REQUIRED_FROM_UPSELL), since we're converting a guest who already
  // went through the deal-room read-only flow.
  // onboardReturnTo round-trips them back to this meet page after onboarding.
  const signupUpsellSignIn = useOAuthSignIn({
    mode: "first-connect",
    entryPoint: "deal-room-upsell",
    callbackUrl: onboardingCallbackUrl(`/meet/${slug}${code ? `/${code}` : ""}`),
  });
  // T3c: re-prompt host for calendar.events write scope when the confirm
  // pipeline degraded to .ics-only (gcal_skipped_scope). `upgrade-scope`
  // mode in useOAuthSignIn already forces prompt=consent, so the redundant
  // signInParams override is gone.
  const writeScopeReconnect = useOAuthSignIn({
    mode: "upgrade-scope",
    callbackUrl: `/meet/${slug}${code ? `/${code}` : ""}`,
  });
  // T3c: tracks whether the host's Google account currently lacks
  // calendar.events. Sourced from confirmData.calendarWriteUnavailable
  // (set by the pipeline pre-flight check) and refreshed from
  // /api/connections/status on mount so a post-reload host still sees
  // the upsell.
  const [calendarWriteUnavailable, setCalendarWriteUnavailable] = useState(false);
  // Propose-changes UI: each click injects a synthetic Envoy text bubble +
  // a fresh picker bubble into the thread. Client-only, never persisted.
  // Incrementing triggers a re-render with one more (text, picker) pair at
  // the bottom of the messages list.
  const [proposeChangesCount, setProposeChangesCount] = useState(0);
  // Signup intro modal (shown when guest clicks "Create free account")
  const [showSignupModal, setShowSignupModal] = useState(false);

  // Direct-confirm flow (2026-04-17): when a guest clicks a slot chip we skip
  // the Envoy round-trip entirely and render a proposal card locally. Once
  // they click Confirm, the card expands to collect name / email / reminder
  // opt-in and posts straight to /api/negotiate/confirm.
  const [pendingProposal, setPendingProposal] = useState<{
    dateTime: string;
    duration: number;
    format: string;
    location: string | null;
  } | null>(null);
  const [confirmFormExpanded, setConfirmFormExpanded] = useState(false);
  const [formGuestName, setFormGuestName] = useState("");
  const [formGuestEmail, setFormGuestEmail] = useState("");
  const [formGuestPhone, setFormGuestPhone] = useState("");
  const [formGuestNote, setFormGuestNote] = useState("");
  // Triggers a longer celebratory glow on the top event card right after
  // confirm. Kept separate from statusAnimating (1.5s, existing status pulse).
  const [justConfirmedGlow, setJustConfirmedGlow] = useState(false);

  // ─── Deal-room state machine (Stage 2, proposal
  // 2026-04-21_deal-room-widget-state-machine-and-agent-dialog-clarity) ──
  // `guestRequestedMoreOptions` is the sticky escape-hatch flag: once the
  // guest clicks "Pick a different time" in the offer card OR hits a
  // slot_no_longer_offered 409 from the server, we flip into negotiate and
  // stay there for the rest of the session. The flag is intentionally NOT
  // persisted — a fresh session re-evaluates mode from slot shape.
  //
  // `transitionReason` drives the one-line narration above the chooser when
  // we arrive in `negotiate` from `offer`:
  //   "user-pick" → "No problem — here's the full week."
  //   "slot-gone" → "That time isn't available anymore — here are the
  //                  current options."
  //   null         → no narration (fresh negotiate, not an arrival).
  const [guestRequestedMoreOptions, setGuestRequestedMoreOptions] = useState(false);
  const [transitionReason, setTransitionReason] = useState<
    "user-pick" | "slot-gone" | null
  >(null);
  // `link.intent.steering` — surfaced by /api/negotiate/session so the
  // client can use it as one of the mode-derivation inputs (N7 fold).
  // Pre-PR-58 links have no intent blob; this stays null and `deriveMode`
  // falls through to slot-count / same-day rules.
  const [linkIntentSteering, setLinkIntentSteering] = useState<
    "open" | "soft" | "narrow" | "exclusive" | string | null
  >(null);

  // Stage 3 V2 — external_agent primer. Set of agentIdentity strings for
  // which the primer has been dismissed (either "Got it" click this render,
  // or already seen in a previous session mount). Used alongside
  // `hasSeenPrimer` (localStorage) — the state bump is just so the render
  // re-runs when a user dismisses. Gated by sessionId so we can clean up
  // on `confirmed` via `cleanupPrimersForSession`.
  const [dismissedPrimers, setDismissedPrimers] = useState<Set<string>>(
    () => new Set(),
  );

  // Auto-scroll on new messages ONLY if the user is already pinned near the
  // bottom. If they've scrolled up to read earlier messages, don't yank them
  // back down — that's the "scroll hijack" anti-pattern.
  useEffect(() => {
    const el = messagesScrollRef.current;
    if (!el) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
      return;
    }
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom < 120) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages]);

  // Stage 3 V2 — cleanup primer keys on the terminal `confirmed` state.
  // Best-effort; keys are session-scoped so this is belt-and-suspenders.
  useEffect(() => {
    if (confirmed && sessionId) {
      cleanupPrimersForSession(sessionId);
    }
  }, [confirmed, sessionId]);

  // Detect [TIMEZONE_SWITCH] in messages and update widget timezone
  useEffect(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role !== "administrator") continue;
      const match = msg.content.match(/\[TIMEZONE_SWITCH\]\s*(\{[^}]+\})\s*\[\/TIMEZONE_SWITCH\]/);
      if (match) {
        try {
          const { timezone } = JSON.parse(match[1]);
          if (timezone && typeof timezone === "string") {
            setSlotTimezone(timezone);
          }
        } catch { /* ignore parse errors */ }
        break; // only apply the most recent switch
      }
    }
  }, [messages]);

  // Fetch slots for availability calendar. Re-runs when viewerTimezone
  // changes so the picker can trigger a regroup without a page reload.
  //
  // The `tz` param is display-only: it only affects day-key grouping and the
  // returned `timezone` label. Scoring/filtering stays host-tz server-side.
  //
  // Response shape (WISHLIST §1o PR-α): the route now disambiguates three
  // previously-conflated empty states. We branch on `error`/`status` to
  // route the inline UX (no_slots / calendar_disconnected / compute_failed)
  // — see `renderPickerBubble` for the rendered messages.
  useEffect(() => {
    if (!sessionId) return;
    const url = new URL("/api/negotiate/slots", window.location.origin);
    url.searchParams.set("sessionId", sessionId);
    const tzParam =
      viewerTimezone ??
      (() => {
        try {
          return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
        } catch {
          return "";
        }
      })();
    if (tzParam) url.searchParams.set("tz", tzParam);
    fetch(url.toString())
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data) return;
        // WISHLIST §1o PR-α: compute pipeline threw on the server. Echo a
        // client-side warn beacon (separate from the structured `console.error`
        // the route logs) so a Sentry-style listener / debug session can pair
        // the missing-widget UX with the failed fetch.
        if (data.error === "compute_failed") {
          console.warn("[deal-room] slots compute_failed", { sessionId });
          setSlotsByDay(null);
          setSlotFetchState({ kind: "compute_failed" });
          if (data.timezone) setSlotTimezone(data.timezone);
          return;
        }
        setSlotsByDay(data.slotsByDay);
        // Widget rendering tz — server echoes the tz it grouped by. When
        // viewerTimezone is set this will match it; pre-seed we fall back
        // to the browser's local tz to avoid a flash of host-tz content.
        setSlotTimezone(data.timezone);
        if (data.currentLocation) setSlotLocation(data.currentLocation);
        if (data.duration) {
          setSlotDuration(data.duration);
          setSchedulingMode(data.duration >= 24 * 60 ? "date" : "time");
        }
        if (data.minDuration) setSlotMinDuration(data.minDuration);
        if (data.isVip) setIsVip(true);
        if (data.bilateralByDay && typeof data.bilateralByDay === "object") {
          setBilateralByDay(data.bilateralByDay as Record<string, TimeChipData[]>);
        }
        if (data.bilateralPayload) {
          setBilateralPayload(
            data.bilateralPayload as import("@/lib/bilateral-availability").BilateralPayload,
          );
        }
        if (data.status === "calendar_disconnected") {
          setSlotFetchState({ kind: "calendar_disconnected" });
        } else if (data.status === "no_slots") {
          setSlotFetchState({ kind: "no_slots" });
        } else {
          setSlotFetchState({ kind: "ok" });
        }
      })
      .catch(() => {});
  }, [sessionId, viewerTimezone]);

  // Hydrate TZ-banner dismissal from localStorage once we know the sessionId.
  // Keyed per session so dismissing on one deal room doesn't silence others.
  useEffect(() => {
    if (!sessionId || typeof window === "undefined") return;
    try {
      const key = `tz-banner-dismissed:${sessionId}`;
      if (window.localStorage.getItem(key) === "1") {
        setTzBannerDismissed(true);
      }
    } catch {
      // localStorage blocked (private mode on some browsers) — just skip,
      // the banner will be shown and that's fine.
    }
  }, [sessionId]);

// After OAuth returns with ?calendarConnected=true, refetch slots so the
  // bilateral chips surface. Strip the query param so a later reload doesn't
  // re-trigger the refresh.
  useEffect(() => {
    if (!sessionId || typeof window === "undefined") return;
    const url = new URL(window.location.href);
    const cc = url.searchParams.get("calendarConnected");
    if (cc === "denied") {
      setCalendarDenied(true);
      url.searchParams.delete("calendarConnected");
      window.history.replaceState({}, "", url.pathname + url.search);
      return;
    }
    if (cc !== "true") return;
    setPostConnectRefetching(true);
    fetch(`/api/negotiate/slots?sessionId=${sessionId}${viewerTimezone ? `&tz=${encodeURIComponent(viewerTimezone)}` : ""}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.slotsByDay) setSlotsByDay(data.slotsByDay);
        if (data?.bilateralByDay && typeof data.bilateralByDay === "object") {
          setBilateralByDay(data.bilateralByDay as Record<string, TimeChipData[]>);
        }
        if (data?.bilateralPayload) {
          setBilateralPayload(
            data.bilateralPayload as import("@/lib/bilateral-availability").BilateralPayload,
          );
        }
      })
      .catch(() => {})
      .finally(() => {
        setPostConnectRefetching(false);
        url.searchParams.delete("calendarConnected");
        window.history.replaceState({}, "", url.pathname + url.search);
      });
    // viewerTimezone is intentionally excluded — this effect fires once on
    // OAuth return, not on tz changes. The slot-fetch re-runs via its own
    // effect when viewerTimezone changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // T4: detect bilateralByDay empty → non-empty transition and fire the
  // MatchPulse one-shot. Reset justMatched immediately so the next render
  // doesn't re-fire the animation.
  useEffect(() => {
    const hasMatchNow = !!bilateralByDay && Object.keys(bilateralByDay).length > 0;
    if (hasMatchNow && !prevHadMatchRef.current) {
      setJustMatched(true);
      const t = setTimeout(() => setJustMatched(false), 50);
      prevHadMatchRef.current = true;
      return () => clearTimeout(t);
    }
    if (!hasMatchNow) prevHadMatchRef.current = false;
  }, [bilateralByDay]);

  // Fetch Google Calendar event status for confirmed meetings (host only).
  useEffect(() => {
    if (!sessionId || !isHost || !confirmed) return;
    fetch(`/api/negotiate/gcal-status?sessionId=${sessionId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (data) setGcalStatus(data); })
      .catch(() => {});
  }, [sessionId, isHost, confirmed]);

  // Stage 1 live-sync (thread H) — §8.4 of the decided deal-room proposal
  // (2026-04-21). Two viewers on the same deal-room should converge on the
  // same transcript without a manual reload. The endpoint already returns
  // every message without role filtering, so this is a pure client-side
  // fetch-policy change.
  //
  // - 10s poll while the tab is visible and not streaming and not
  //   confirmed.
  // - Refetch immediately on `focus` and `visibilitychange` → visible.
  // - Merge via mergePollResult: content-matched id-swap on temp-id rows,
  //   standard id-dedup otherwise. See deal-room-live-sync.ts for the
  //   B1-fold rationale (why we didn't do the server-id handshake).
  useEffect(() => {
    if (!sessionId) return;

    let cancelled = false;

    async function pollOnce() {
      if (cancelled) return;
      if (isStreaming) return;
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      try {
        const res = await fetch(`/api/negotiate/session?id=${sessionId}`);
        if (!res.ok) return;
        const { session: sess } = await res.json();
        if (cancelled) return;
        if (!sess || !Array.isArray(sess.messages)) return;
        const serverMessages: LiveSyncMessage[] = sess.messages.map(
          (m: { id: string; role: string; content: string; metadata?: unknown; createdAt?: string | Date }) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            metadata: m.metadata ?? null,
            createdAt: typeof m.createdAt === "string"
              ? m.createdAt
              : m.createdAt instanceof Date
                ? m.createdAt.toISOString()
                : undefined,
          }),
        );
        setMessages((prev) => mergePollResult(prev as LiveSyncMessage[], serverMessages) as Message[]);
        // Mirror session status surfaces so the remote side's confirm /
        // status changes land as well.
        if (typeof sess.status === "string") setSessionStatus(sess.status);
        if (typeof sess.statusLabel === "string") setSessionStatusLabel(sess.statusLabel);
        // 2026-05-11 — when a confirmed session is edited in-chat
        // (`applyConfirmedSessionPatch`), the GCal event is patched and
        // session.agreedTime / agreedFormat / link.parameters.location
        // are updated. Refresh confirmData here so the MeetingCard
        // reflects the change without a page reload.
        if (sess.status === "agreed") {
          setConfirmData((prev) => {
            const next: Record<string, unknown> = { ...(prev ?? {}) };
            if (typeof sess.agreedTime === "string") next.dateTime = sess.agreedTime;
            if (typeof sess.agreedFormat === "string") next.format = sess.agreedFormat;
            if (typeof sess.duration === "number") next.duration = sess.duration;
            if ("location" in sess) next.location = sess.location;
            if (typeof sess.eventLink === "string") next.eventLink = sess.eventLink;
            return next;
          });
        }
      } catch {
        // Swallow transient network errors — next tick will retry.
      }
    }

    // Poll while visible + not streaming. Confirmed sessions also poll
    // (2026-05-11) so in-chat edits via applyConfirmedSessionPatch surface
    // on the other viewer's card within one tick.
    const startInterval = () => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return null;
      if (isStreaming) return null;
      return window.setInterval(pollOnce, 10_000);
    };

    const intervalId: number | null = startInterval();

    const onVisibility = () => {
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        pollOnce();
      }
    };
    const onFocus = () => {
      pollOnce();
    };

    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibility);
    }
    if (typeof window !== "undefined") {
      window.addEventListener("focus", onFocus);
    }

    return () => {
      cancelled = true;
      if (intervalId !== null) window.clearInterval(intervalId);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
      if (typeof window !== "undefined") {
        window.removeEventListener("focus", onFocus);
      }
    };
  }, [sessionId, isStreaming]);

  // T3c: detect host missing calendar.events write scope so the upsell
  // banner appears even after a page reload (when confirmData no longer
  // carries the warning flag from the original confirm response).
  useEffect(() => {
    if (!isHost || !confirmed) return;
    if (confirmData?.calendarWriteUnavailable) {
      setCalendarWriteUnavailable(true);
      return;
    }
    fetch("/api/connections/status")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.google?.connected && data.google.calendarWrite === false) {
          setCalendarWriteUnavailable(true);
        }
      })
      .catch(() => {});
  }, [isHost, confirmed, confirmData]);

  // Track event status changes for animation pulse
  useEffect(() => {
    const currentKey = confirmed ? "agreed" : sessionStatus;
    if (prevStatusRef.current !== currentKey && prevStatusRef.current !== "active") {
      setStatusAnimating(true);
      const timer = setTimeout(() => setStatusAnimating(false), 1500);
      prevStatusRef.current = currentKey;
      return () => clearTimeout(timer);
    }
    prevStatusRef.current = currentKey;
  }, [confirmed, sessionStatus]);

  function parseConfirmationProposal(content: string): {
    text: string;
    proposal: { dateTime: string; duration: number; format: string; location: string | null; timezone?: string } | null;
    proposalWarning?: string;
  } {
    // Strip STATUS_UPDATE, ACTION, and TIMEZONE_SWITCH blocks
    const cleaned = content
      .replace(/\s*\[STATUS_UPDATE\].*?\[\/STATUS_UPDATE\]\s*/g, "")
      .replace(/\s*\[ACTION\].*?\[\/ACTION\]\s*/g, "")
      .replace(/\s*\[TIMEZONE_SWITCH\].*?\[\/TIMEZONE_SWITCH\]\s*/g, "");
    const match = cleaned.match(
      /\[CONFIRMATION_PROPOSAL\]([^\[]*)\[\/CONFIRMATION_PROPOSAL\]/
    );
    if (!match) return { text: cleaned.trim(), proposal: null };
    try {
      const proposal = JSON.parse(match[1]);
      const text = cleaned.replace(
        /\[CONFIRMATION_PROPOSAL\][^\[]*\[\/CONFIRMATION_PROPOSAL\]/,
        ""
      ).trim();

      // Validate proposal fields
      const warnings: string[] = [];
      const dt = new Date(proposal.dateTime);
      if (isNaN(dt.getTime())) {
        return { text, proposal: null, proposalWarning: "Invalid date in proposal" };
      }
      if (dt.getTime() < Date.now()) {
        warnings.push("This time is in the past");
      }
      if (!proposal.duration || proposal.duration <= 0) {
        proposal.duration = 30; // safe default
      }
      const validFormats = ["phone", "video", "in-person"];
      if (!validFormats.includes(proposal.format)) {
        warnings.push(`Unknown format: ${proposal.format}`);
      }
      const hasOffset = /[+-]\d{2}:\d{2}$/.test(proposal.dateTime) || proposal.dateTime.endsWith("Z");
      if (!hasOffset) {
        warnings.push("Timezone offset missing \u2014 time may be inaccurate");
      }

      return { text, proposal, proposalWarning: warnings.length > 0 ? warnings.join(". ") : undefined };
    } catch {
      return { text: cleaned.trim(), proposal: null };
    }
  }

  // Resolve a slot click into a local pendingProposal. Uses session-scoped
  // defaults (linkFormat, linkLocation, slotDuration) so a guest's chip click
  // goes straight to a proposal card instead of round-tripping through Envoy.
  function proposeFromSlot(slot: { start: string; end: string }) {
    const startMs = new Date(slot.start).getTime();
    const endMs = new Date(slot.end).getTime();
    const durationFromRange = Math.max(15, Math.round((endMs - startMs) / 60000));
    // Prefer host-set meeting duration from link.parameters (slotDuration); fall
    // back to the chip's own range if the link didn't specify one.
    const duration = slotDuration && slotDuration > 0 ? slotDuration : durationFromRange;
    const format = linkFormat || "video";
    setPendingProposal({
      dateTime: slot.start,
      duration,
      format,
      location: linkLocation,
    });
    setConfirmFormExpanded(true);
    setConfirmError(null);
    // PR2c — picking a slot from reschedule mode closes the picker
    setReschedulingFromConfirmed(false);
    // Seed form inputs from whatever we know already.
    if (!formGuestName && (guestUser?.name || inviteeName)) {
      setFormGuestName(guestUser?.name || inviteeName);
    }
    if (!formGuestEmail && (guestUser?.email || guestEmail)) {
      setFormGuestEmail(guestUser?.email || guestEmail);
    }
    // Scroll the thread to the bottom so the newly-rendered confirm card
    // (name/email/Confirm button) is visible without manual scrolling. Two
    // RAFs + a short timeout cover the pickerʼs render + layout settle.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setTimeout(() => {
          messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
        }, 80);
      });
    });
  }

  // Date-mode: guest taps a calendar day → build a timed start ISO from the
  // chosen date + link startTime (default noon) + duration.
  function handleSelectDate(dateStr: string) {
    const timeStr = linkStartTime ?? "12:00";
    const [hh, mm] = timeStr.split(":").map(Number);
    const startDate = new Date(`${dateStr}T00:00:00`);
    startDate.setHours(hh, mm ?? 0, 0, 0);
    const duration = slotDuration ?? 1440;
    const endDate = new Date(startDate.getTime() + duration * 60_000);
    proposeFromSlot({ start: startDate.toISOString(), end: endDate.toISOString() });
  }

  async function handleConfirm(proposal: {
    dateTime: string;
    duration: number;
    format: string;
    location: string | null;
    timezone?: string;
  }, opts?: { guestName?: string; guestEmail?: string; guestNote?: string }) {
    if (!sessionId || isConfirming) return;
    setIsConfirming(true);
    setConfirmError(null);
    setEmailWarning(null);
    try {
      const res = await fetch("/api/negotiate/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          dateTime: proposal.dateTime,
          duration: proposal.duration,
          format: proposal.format,
          location: proposal.location,
          timezone: proposal.timezone,
          guestName: opts?.guestName ?? formGuestName ?? undefined,
          guestEmail: opts?.guestEmail ?? formGuestEmail ?? guestEmail ?? undefined,
          guestNote: opts?.guestNote ?? (formGuestNote.trim() || undefined),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        // N2 fold (proposal 2026-04-21_deal-room-widget-state-machine):
        // server says this slot isn't in the current offered set anymore
        // (host edited the link, calendar shifted, sibling consumed it).
        // Drop the user into negotiate mode with an explanatory narration
        // and clear the stale pendingProposal so the offer card collapses.
        if (res.status === 409 && data?.reason === "slot_no_longer_offered") {
          setPendingProposal(null);
          setConfirmFormExpanded(false);
          setTransitionReason("slot-gone");
          setGuestRequestedMoreOptions(true);
          // Kick the slots fetch so the chooser shows the current set.
          if (sessionId) {
            fetch(
              `/api/negotiate/slots?sessionId=${sessionId}${viewerTimezone ? `&tz=${encodeURIComponent(viewerTimezone)}` : ""}`,
            )
              .then((r) => (r.ok ? r.json() : null))
              .then((d) => {
                if (d?.slotsByDay) setSlotsByDay(d.slotsByDay);
              })
              .catch(() => {});
          }
          return;
        }
        if (data.error === "Session already confirmed") {
          // 2026-05-11: previously set confirmed=true here without confirmData,
          // which left meetingCardProps null → fall-through to legacy view.
          // Re-fetch the session so confirmData has the agreed slot's fields
          // (dateTime/format/duration/eventLink) before flipping confirmed.
          if (sessionId) {
            try {
              const sessionRes = await fetch(`/api/negotiate/session?id=${sessionId}`);
              if (sessionRes.ok) {
                const { session: sess } = await sessionRes.json();
                if (sess?.status === "agreed") {
                  setConfirmData({
                    dateTime: sess.agreedTime,
                    duration: sess.duration || 30,
                    format: sess.agreedFormat || "phone",
                    meetLink: sess.meetLink,
                    eventLink: sess.eventLink,
                  });
                }
              }
            } catch {
              // Fall through — confirmed flips below; meetingCardProps will
              // build proposal-shape props from the snapshot, which is
              // visually wrong but doesn't crash and won't fall to legacy.
            }
          }
          setConfirmed(true);
          setSessionStatus("agreed");
          setSessionStatusLabel("");
        } else {
          setConfirmError(data.error || "Failed to confirm meeting");
        }
        return;
      }
      setConfirmData(data);
      setConfirmed(true);
      setSessionStatus("agreed");
      setSessionStatusLabel("");
      setPendingProposal(null);
      setConfirmFormExpanded(false);
      // Celebratory glow on the top event card — stronger than the existing
      // 1.5s status pulse, runs 3s so users can see where to look.
      setJustConfirmedGlow(true);
      setTimeout(() => setJustConfirmedGlow(false), 3000);
      if (data.emailSent === false) {
        setEmailWarning("Meeting confirmed, but the confirmation email failed to send.");
      }
    } catch (error) {
      console.error("Confirm error:", error);
      // Heal pass: the confirm pipeline may have completed server-side
      // (Google event inserted, session moved to `agreed`) even though the
      // client request failed or timed out — reported 2026-04-21 by Danny
      // on link j6ep75 (cmo909lkz): "nothing happened" in the UI but the
      // event landed in his calendar. Check the session's truth once
      // before surfacing the generic error so we don't strand the user.
      let healed = false;
      if (sessionId) {
        try {
          const sessionRes = await fetch(
            `/api/negotiate/session?id=${sessionId}`,
          );
          if (sessionRes.ok) {
            const { session: sess } = await sessionRes.json();
            if (sess?.status === "agreed") {
              // 2026-05-11: also populate confirmData from the heal fetch —
              // previously omitted, which left the new MeetingCard surface
              // with confirmed=true but null confirmData → legacy fall-through.
              setConfirmData({
                dateTime: sess.agreedTime,
                duration: sess.duration || 30,
                format: sess.agreedFormat || "phone",
                meetLink: sess.meetLink,
                eventLink: sess.eventLink,
              });
              setConfirmed(true);
              setSessionStatus("agreed");
              setSessionStatusLabel("");
              setPendingProposal(null);
              setConfirmFormExpanded(false);
              setJustConfirmedGlow(true);
              setTimeout(() => setJustConfirmedGlow(false), 3000);
              healed = true;
            }
          }
        } catch {
          // fall through to error banner
        }
      }
      if (!healed) {
        setConfirmError("Failed to confirm meeting. Please try again.");
      }
    } finally {
      setIsConfirming(false);
    }
  }

  // Detect guest calendar connect via URL param.
  //
  // The OAuth callback at /api/auth/guest-calendar/callback already wrote a
  // system-role Message with structured metadata.scoredSlots — the slots
  // endpoint reads that for bilateral compute, so all we need to do here is
  // clean up the URL param and refetch the slots payload. Posting a
  // [SYSTEM: ...] message from the client was both redundant (calendar data
  // is already in the DB) and actively harmful — /api/negotiate/message
  // defaults the role to "guest" for unauthenticated POSTs, which surfaced
  // as a purple guest bubble and triggered a generic Envoy response that
  // had no real bilateral data to work with (sanitizeHistory strips the
  // system-role message before Envoy sees history). The widget is the
  // affordance; no LLM turn needed.
  const calendarCheckDone = useRef(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("calendarConnected") === "true" && sessionId && !calendarConnected && !calendarCheckDone.current) {
      calendarCheckDone.current = true;
      setCalendarConnected(true);
      const url = new URL(window.location.href);
      url.searchParams.delete("calendarConnected");
      window.history.replaceState({}, "", url.pathname);
      // Refetch slots so bilateralByDay + green/orange chips appear.
      fetch(`/api/negotiate/slots?sessionId=${sessionId}${viewerTimezone ? `&tz=${encodeURIComponent(viewerTimezone)}` : ""}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (data?.slotsByDay) setSlotsByDay(data.slotsByDay);
          if (data?.bilateralByDay) setBilateralByDay(data.bilateralByDay);
          if (data?.bilateralPayload) setBilateralPayload(data.bilateralPayload);
        })
        .catch(() => {});
    }
    // viewerTimezone is intentionally excluded from deps — the main slots
    // effect handles tz-change refetches; this one is a calendarConnected
    // one-shot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, calendarConnected]);

  // After a `lock_session_duration` action lands, refetch the slot universe.
  // Duration is the only dimension where guest negotiation invalidates the
  // slot pre-compute (slots that fit 30 min may not fit 60), unlike
  // activity / location / format. The action handler in actions.ts seeds a
  // system-role message with `metadata.kind = "session_duration_lock"`
  // whenever the lock succeeds; we watch for new ones here and re-query
  // /api/negotiate/slots so the picker re-renders with the new duration's
  // slot set. Reusable-link guest-picks proposal, decided 2026-04-28.
  const processedDurationLocks = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!sessionId) return;
    const newLocks = messages.filter((m) => {
      const kind = (m.metadata as Record<string, unknown> | null | undefined)?.kind;
      return kind === "session_duration_lock" && !processedDurationLocks.current.has(m.id);
    });
    if (newLocks.length === 0) return;
    for (const m of newLocks) processedDurationLocks.current.add(m.id);
    fetch(`/api/negotiate/slots?sessionId=${sessionId}${viewerTimezone ? `&tz=${encodeURIComponent(viewerTimezone)}` : ""}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.slotsByDay) setSlotsByDay(data.slotsByDay);
      })
      .catch(() => {});
    // viewerTimezone deliberately omitted from deps — same reasoning as the
    // calendarConnected effect above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, sessionId]);

  // Initialize session on mount
  useEffect(() => {
    async function initSession() {
      try {
        const res = await fetch("/api/negotiate/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            slug,
            code,
            guestTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          }),
        });

        if (!res.ok) {
          const data = await res.json();
          if (data.error === "archived") {
            setArchivedData({ hostEmail: data.hostEmail, hostName: data.hostName, hostMeetSlug: data.hostMeetSlug ?? null });
            setIsLoading(false);
            return;
          }
          setError(data.error || "Failed to start session");
          setIsLoading(false);
          return;
        }

        const data = await res.json();
        setSessionId(data.sessionId);
        setHostName(data.host?.name || data.hostName || "");
        setIsHost(data.isHost || false);
        setIsGuest(data.isGuest || false);
        setGuestUser(data.guestUser || null);
        // TZ recovery banner: capture the session's stored guestTimezone so
        // we can compare against the browser's detected TZ. Null when no
        // visitor has posted a TZ yet.
        if (typeof data.sessionTimezone === "string" || data.sessionTimezone === null) {
          setSessionTimezone(data.sessionTimezone);
        }
        // Host + viewer tz — feed the calendar-card picker.
        if (typeof data.hostTimezone === "string") {
          setHostTimezoneState(data.hostTimezone);
        }
        if (typeof data.viewerTimezone === "string" || data.viewerTimezone === null) {
          setViewerTimezoneState(data.viewerTimezone);
        }
        setTopic(data.link?.topic || "");
        // Per-field "Edited" pill — read material-edit metadata.
        {
          const lastEdit = (data.link as Record<string, unknown> | undefined)?.lastMaterialEditAt;
          setLastMaterialEditAt(typeof lastEdit === "string" ? lastEdit : null);
          const fields = (data.link as Record<string, unknown> | undefined)?.lastEditedFields;
          setLastEditedFields(
            Array.isArray(fields) ? (fields as unknown[]).filter((f): f is string => typeof f === "string") : [],
          );
        }
        // B2/B3: always reset feedbackCode at the top of handler (Pitfall 2 fix)
        // so stale bookable child codes don't leak across sessions in the same tab.
        setFeedbackCode(undefined);
        // B5 N1: use !!() not conditional set — resets to false on re-load to a
        // non-bookable session in the same React instance (N1 reviewer fix).
        setIsBookable(!!data.isBookable);
        setLinkFormat(data.link?.format || "");
        // B2: populate linkDuration from session response — fallback when slotDuration
        // is undefined (e.g. slots API returned compute_failed for a bookable session).
        if (typeof data.link?.duration === "number" && data.link.duration > 0) {
          setLinkDuration(data.link.duration);
        }
        setLinkStartTime(typeof (data.link as Record<string, unknown>)?.startTime === "string" ? (data.link as Record<string, unknown>).startTime as string : null);
        setLinkLocation(typeof data.link?.location === "string" && data.link.location.trim() ? data.link.location.trim() : null);
        setLinkActivity(typeof data.link?.activity === "string" && data.link.activity.trim() ? data.link.activity.trim() : null);
        setLinkActivityIcon(typeof data.link?.activityIcon === "string" && data.link.activityIcon.trim() ? data.link.activityIcon.trim() : null);
        {
          const opts = (data.link as Record<string, unknown>)?.activityOptions;
          setLinkActivityOptions(Array.isArray(opts) ? opts as string[] : null);
          const gp = (data.link as Record<string, unknown>)?.guestPicks as Record<string, unknown> | null | undefined;
          setLinkGuestPicksLocation(gp?.location === true);
          // Format / duration deferrals can be `true` OR an array of allowed
          // values — both shapes signal "guest picks". Date is boolean-only.
          setLinkGuestPicksFormat(gp?.format === true || Array.isArray(gp?.format));
          setLinkGuestPicksDuration(gp?.duration === true || Array.isArray(gp?.duration));
          setLinkGuestPicksDate(gp?.date === true);
        }
        setLinkTimingLabel(typeof data.link?.timingLabel === "string" && data.link.timingLabel.trim() ? data.link.timingLabel.trim() : null);
        // Stage 2 state-machine input (N7 fold): surface intent.steering so
        // deriveMode() can pick the exclusive-single-slot offer branch. Null
        // on pre-PR-58 links — mode derivation falls through to the generic
        // slot-count / same-day rule.
        {
          const rawIntent = (data.link as { intent?: { steering?: unknown } } | null | undefined)?.intent;
          const steering = rawIntent && typeof rawIntent === "object" && "steering" in rawIntent
            ? (rawIntent as { steering?: unknown }).steering
            : null;
          setLinkIntentSteering(
            typeof steering === "string" && steering.length > 0 ? steering : null,
          );
        }
        const names: string[] = Array.isArray(data.link?.inviteeNames) && (data.link.inviteeNames as string[]).length > 0
          ? (data.link.inviteeNames as string[])
          : data.link?.inviteeName ? [data.link.inviteeName] : [];
        setInviteeNames(names);
        setInviteeName(names[0] ?? "");
        // Pre-fill the confirm-card form from any info we already have so the
        // guest doesn't have to retype their name/email if Envoy captured it.
        if (data.session?.guestName && !formGuestName) setFormGuestName(data.session.guestName);
        else if (names[0] && !formGuestName) setFormGuestName(names[0]);
        if (data.session?.guestEmail && !formGuestEmail) setFormGuestEmail(data.session.guestEmail);
        else if (data.link?.inviteeEmail && !formGuestEmail) setFormGuestEmail(data.link.inviteeEmail);
        setSessionStatus(data.status || "active");
        setSessionStatusLabel(data.statusLabel || "");
        if (data.isGroupEvent) setIsGroupEvent(true);
        if (data.participants) setParticipants(data.participants);
        if (data.groupCoordination) setGroupCoordination(data.groupCoordination as { candidateDays: string[] | null; responses: Array<{ person: string; dayVotes?: Record<string, boolean> }> });

        // PR2 SEED: store link DB id + parameters for authored-tip read/write path.
        if (typeof data.link?.id === "string" && data.link.id) {
          setLinkDbId(data.link.id);
        }
        if (data.link?.parameters && typeof data.link.parameters === "object") {
          setLinkParameters(data.link.parameters as Record<string, unknown>);
        }

        // B3: store child NegotiationLink.code for feedback auth.
        // feedbackCode is the child NegotiationLink.code (e.g. "hf5uex");
        // code (from URL) is the bookable rule's linkCode (e.g. "q89wdvt4").
        // The feedback route looks up by NegotiationLink.code; feedbackCode ?? code
        // is correct because for non-bookable visits, feedbackCode IS the minted
        // personalized code (same thing as code).
        if (data.code) {
          setFeedbackCode(data.code);
          // Primary link → redirect to persistent contextual URL
          if (!code) {
            router.replace(`/meet/${slug}/${data.code}`);
          }
        }

        // Already confirmed — load messages AND set confirmed state
        if (data.confirmed) {
          setConfirmData({
            dateTime: data.agreedTime,
            duration: data.duration || 30,
            format: data.agreedFormat || "phone",
            meetLink: data.meetLink,
            // 2026-05-10: GCal event deep-link from session-load endpoint
            // (constructed via googleCalendarEventUrl on the server). Drives
            // the new MeetingCard "Open in Google Calendar" action immediately
            // on page load, no async fetch required.
            eventLink: data.eventLink,
          });
          setConfirmed(true);
          // Load message history so chat is visible below the event card
          if (data.messages?.length > 0) {
            setMessages(
              data.messages.map((m: { id: string; role: string; content: string; metadata?: unknown; createdAt?: string }) => ({
                id: m.id,
                role: m.role,
                content: m.content,
                metadata: (m.metadata as Message["metadata"]) ?? null,
                createdAt: m.createdAt,
              }))
            );
          }
          return;
        }

        // If resuming an existing session, load full message history
        if (data.resumed && data.messages?.length > 0) {
          setMessages(
            data.messages.map((m: { id: string; role: string; content: string; metadata?: unknown; createdAt?: string }) => ({
              id: m.id,
              role: m.role,
              content: m.content,
              metadata: (m.metadata as Message["metadata"]) ?? null,
              createdAt: m.createdAt,
            }))
          );
        } else if (data.greeting) {
          // Use a temp id (numeric ms-since-epoch) so the first poll's
          // content-match pass in mergePollResult swaps this local row in
          // place with the server-persisted greeting. A non-numeric id
          // like "greeting" fails isTempId, falls through to id-dedup,
          // and the server's CUID row appends — rendering the greeting
          // twice (one DB row, two bubbles).
          //
          // Phase 2 PR3b: new sessions return the tip text as `greeting`
          // (not a full elaborated greeting template). This seeds the
          // EnvoyDock thread with the tip content. For group events,
          // `greeting` is the LLM-generated group welcome. When `greeting`
          // is empty or null (possible in future), the thread starts empty.
          setMessages([
            {
              id: Date.now().toString(),
              role: "administrator",
              content: data.greeting,
              createdAt: new Date().toISOString(),
            },
          ]);
        } else {
          // No greeting — new surface sessions start with an empty thread.
          // The tip is shown on the MeetingCard instead.
          setMessages([]);
        }
      } catch {
        setError("Failed to connect. Please try again.");
      } finally {
        setIsLoading(false);
      }
    }

    initSession();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- router is stable, slug/code are the real triggers
  }, [slug, code]);

  /**
   * handleSend — legacy form submit path. The `textOverride` parameter
   * supports EnvoyDock's real composer (Bug 3 fix 2026-05-11): the dock's
   * onSendMessage prop calls handleSend(syntheticEvent, composerText) so the
   * message posts through the full streaming pipeline without touching the
   * legacy input state.
   */
  async function handleSend(e: React.FormEvent, textOverride?: string) {
    e.preventDefault();
    const text = textOverride ?? input.trim();
    if (!text || isSending || !sessionId) return;

    // Host directive: :: prefix (host only)
    if (isHost && text.startsWith("::")) {
      const directive = text.slice(2).trim();
      if (!directive) return;
      setInput("");
      try {
        await fetch("/api/negotiate/directive", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: directive, sessionId }),
        });
        const directiveMsg: Message = {
          id: `directive-${Date.now()}`,
          role: "host_note",
          content: directive,
        };
        setMessages((prev) => [...prev, directiveMsg]);
      } catch {}
      return;
    }

    const messageRole = isHost ? "host" : "guest";
    const userMsg: Message = {
      id: Date.now().toString(),
      role: messageRole,
      content: text,
    };

    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setIsSending(true);
    // Block poll merges during the stream — see Stage 1 live-sync note
    // on isStreaming state above.
    setIsStreaming(true);

    try {
      const res = await fetch("/api/negotiate/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          content: userMsg.content,
        }),
      });

      if (!res.ok) {
        let errorMsg = "Failed to send message. Please try again.";
        try {
          const errBody = await res.json();
          if (errBody.error) {
            errorMsg = errBody.retryable
              ? `${errBody.error} — try again in a moment.`
              : errBody.error;
          }
        } catch {}
        throw new Error(errorMsg);
      }

      const contentType = res.headers.get("content-type") || "";

      // Error responses come as JSON
      if (contentType.includes("application/json")) {
        const body = await res.json();
        if (body.error) throw new Error(body.error);
        setIsSending(false);
        // No stream happened — release the poll guard immediately.
        setIsStreaming(false);
        return;
      }

      // Both host and guest messages get a streaming agent response
      const reader = res.body?.getReader();
      if (!reader) throw new Error("No reader");

      const assistantId = (Date.now() + 1).toString();
      setMessages((prev) => [
        ...prev,
        { id: assistantId, role: "administrator", content: "" },
      ]);

      const decoder = new TextDecoder();
      let fullText = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          // Stage 1 live-sync (§8.4): flip isStreaming false 500ms after
          // the stream closes. The 500ms window covers the race between
          // onFinish's DB write (server-side admin row) and the next
          // poll's read — without it, the first post-stream poll can
          // fire before the server row exists and miss the content-match
          // dedup path.
          setTimeout(() => setIsStreaming(false), 500);
          break;
        }

        const chunk = decoder.decode(value, { stream: true });
        fullText += chunk;
        // Strip structured blocks client-side so mid-stream partials don't
        // flash raw `[DELEGATE_SPEAKER]...[/DELEGATE_SPEAKER]` / `[ACTION]`
        // / `[STATUS_UPDATE]` tags at the guest. Server re-strips in
        // onFinish before persisting — this is the client mirror so the
        // visible state matches the persisted state without a reload.
        // Bug reported 2026-04-21 by Danny on link j6ep75 (cmo909lkz).
        const rendered = stripRendererOnlyBlocks(fullText);
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId ? { ...m, content: rendered } : m
          )
        );
      }

      // If stream ended with no text, remove the empty bubble and show error
      if (!fullText.trim()) {
        setMessages((prev) => prev.filter((m) => m.id !== assistantId));
        setMessages((prev) => [
          ...prev,
          { id: `error-${Date.now()}`, role: "system", content: "Something went wrong — please try again." },
        ]);
      }
      // Re-fetch session status + link info after AI response
      if (sessionId) {
        try {
          const sessionRes = await fetch(`/api/negotiate/session?id=${sessionId}`);
          if (sessionRes.ok) {
            const { session: sess } = await sessionRes.json();
            setSessionStatus(sess.status);
            setSessionStatusLabel(sess.statusLabel || "");
            // Update link info (guest name, topic, email) if changed by save_guest_info action
            if (sess.link?.inviteeName && !inviteeName) setInviteeName(sess.link.inviteeName);
            if (sess.link?.topic && !topic) setTopic(sess.link.topic);
            const freshEmail = sess.guestEmail || sess.link?.inviteeEmail;
            if (freshEmail && !guestEmail) setGuestEmail(freshEmail);
          }
        } catch {}
      }
    } catch (error) {
      console.error("Send error:", error);
      const errorContent = error instanceof Error ? error.message : "Failed to send message. Please try again.";
      setMessages((prev) => [
        ...prev,
        { id: `error-${Date.now()}`, role: "system", content: errorContent },
      ]);
      // Stream may have died before the done branch ran — release the
      // poll guard so the next 10s tick can catch up.
      setIsStreaming(false);
    } finally {
      setIsSending(false);
    }
  }

  // --- Contextual event title ---
  function getEventTitle() {
    const hostFirst = hostName ? hostName.split(" ")[0] : "";
    const guestFirst = inviteeName ? inviteeName.split(" ")[0] : "";
    const effectiveFormat = confirmed && confirmData ? (confirmData.format as string) : linkFormat;

    if (topic && guestFirst) return `${topic} — ${guestFirst}`;
    if (topic && hostFirst) return `${topic} with ${hostFirst}`;
    if (effectiveFormat === "phone" && guestFirst && hostFirst) return `Phone call: ${guestFirst} & ${hostFirst}`;
    if (effectiveFormat === "phone" && hostName) return `Phone call with ${hostName}`;
    if ((effectiveFormat === "video") && guestFirst && hostFirst) return `Call — ${guestFirst} & ${hostFirst}`;
    if ((effectiveFormat === "video") && hostName) return `Call with ${hostName}`;
    if (guestFirst && hostFirst) return `${guestFirst} & ${hostFirst}`;
    if (hostName) return `Meet with ${hostName}`;
    return "Meeting";
  }

  // --- Meeting emoji picker ---
  // Priority: host-set `activityIcon` (handled by callers) > activity vocab
  // lookup (`emojiForActivity` from canonical `app/src/lib/activity-vocab.ts`) >
  // location keyword > format > empty fallback. Adding a new activity belongs
  // in `activity-vocab.ts`; do not extend the venue-keyword regex chain below
  // for activity matches — that's drift.
  //
  // Location-keyword fallback exists for cases where the host wrote a venue
  // string but no `activity` field was set (e.g. "Blue Bottle on Mission")
  // — keep it minimal; activity coverage belongs upstream.
  function getMeetingEmoji(
    format: string | null | undefined,
    location: string | null | undefined,
    activity?: string | null | undefined,
  ): string {
    // 1. Activity vocab — canonical source of truth.
    const activityEmoji = emojiForActivity(activity ?? null);
    if (activityEmoji) return activityEmoji;

    // 2. Location-keyword fallback — only when activity didn't resolve.
    const loc = (location ?? "").toLowerCase();
    if (loc) {
      if (/\b(cafe|café|coffee|starbucks|blue bottle|philz|peets|peet's)\b/.test(loc)) return "☕";
      if (/\b(restaurant|bistro|dinner|lunch|brunch|grill|kitchen|tavern)\b/.test(loc)) return "🍽️";
      if (/\b(bike|biking|cycle|cycling|trail|ride)\b/.test(loc)) return "🚴";
      if (/\b(surf|surfing|beach|ocean)\b/.test(loc)) return "🏄";
      // Zoom / Meet / Teams URLs land here when location is the meet link
      if (/\b(zoom\.us|meet\.google|teams\.microsoft|webex)\b/.test(loc)) return "💻";
      // Location provided but no keyword matched — use pin as the generic location icon
      return "📍";
    }

    // 3. Format fallback.
    if (format === "phone") return "📱";
    if (format === "video") return "💻";
    if (format === "in-person") return "👤";
    return "";
  }

  // ─── Stage 2 mode derivation ──────────────────────────────────────────
  // Memoized on the exact input set specified in §3.1 of the decided
  // proposal: (sessionStatus, availableSlots, guestRequestedMoreOptions,
  // link.intent?.steering, session.viewerTimezone). `confirmed` is folded
  // into the first argument so the `agreed` terminal state resolves right.
  //
  // `availableSlots` is flattened from `slotsByDay` — only `start` is read
  // by the derivation (it's the "same local day" axis). If slotsByDay
  // hasn't loaded yet, the array is empty and mode defaults to negotiate.
  //
  // Hooks must run on every render — keep these above the early returns
  // (archived / error) below.
  const availableSlotStarts = useMemo(() => {
    if (!slotsByDay) return [] as Array<{ start: string }>;
    const out: Array<{ start: string }> = [];
    for (const day of Object.values(slotsByDay)) {
      for (const s of day) out.push({ start: s.start });
    }
    return out;
  }, [slotsByDay]);

  const dealRoomMode: DealRoomMode = useMemo(() => {
    return deriveMode(
      {
        status: confirmed ? "agreed" : sessionStatus,
        viewerTimezone: viewerTimezone ?? null,
      },
      {
        availableSlots: availableSlotStarts,
        guestRequestedMoreOptions,
        link: { intent: linkIntentSteering ? { steering: linkIntentSteering } : null },
      },
    );
  }, [
    confirmed,
    sessionStatus,
    viewerTimezone,
    availableSlotStarts,
    guestRequestedMoreOptions,
    linkIntentSteering,
  ]);

  // PR2a/PR2c — derive MeetingCardProps from deal-room state.
  // PR2a: confirmed only. PR2c: extended to proposal/matched/skipped/confirming.
  // Returns null when guest+host names are both empty (safe fallback to legacy).
  const meetingCardProps = useMemo(() => {
    // Compute hasBilateralMatch for matched-state detection
    const hasBilateralMatch = !!(bilateralByDay && Object.values(bilateralByDay).some((chips) =>
      chips.some((c) => c.color === "both"),
    ));
    // Extract guestPicks from linkParameters for the new card surface.
    // Only location + format are in scope; duration/window/date are out of scope.
    const gp = (linkParameters?.guestPicks) as Record<string, unknown> | null | undefined;
    const linkGuestPicks = gp
      ? {
          location: gp.location === true,
          format: (gp.format === true || Array.isArray(gp.format))
            ? gp.format as boolean | string[]
            : undefined,
        }
      : null;

    const props = dealRoomToMeetingCardProps({
      isHost,
      hostName,
      inviteeName,
      confirmData,
      linkActivity,
      linkLocation,
      sessionTimezone,
      slotTimezone,
      linkParameters,
      // Confirm endpoint returns the GCal event URL as `eventLink`. The legacy
      // host-only `/api/negotiate/gcal-status` fetch returns it as `htmlLink`.
      // Prefer confirmData.eventLink (immediate at confirm + on session-load)
      // and fall back to gcalStatus.htmlLink (defensive — older code paths).
      gcalEventUrl:
        (typeof confirmData?.eventLink === "string" ? confirmData.eventLink : null) ??
        (typeof confirmData?.htmlLink === "string" ? confirmData.htmlLink : null) ??
        gcalStatus?.htmlLink ??
        null,
      // PR2c — non-confirmed state fields
      sessionStatus,
      isConfirming,
      hasBilateralMatch,
      linkFormat,
      // Guest-picks deferrals from link.parameters.guestPicks
      linkGuestPicks,
    });
    return props;
  }, [
    isHost,
    hostName,
    inviteeName,
    confirmData,
    linkActivity,
    linkLocation,
    sessionTimezone,
    slotTimezone,
    linkParameters,
    gcalStatus,
    sessionStatus,
    isConfirming,
    bilateralByDay,
    linkFormat,
  ]);

  // PR2a/PR2c — map deal-room messages to EnvoyDock ChatMessage shape.
  // Used by both MeetingCardConfirmedView (confirmed) and MeetingCardProposalView
  // (proposal/matched/skipped). Human messages are stored as "guest" or "host"
  // (see api/negotiate/message/route.ts); both map to the dock's "guest" lane
  // since the thread is from the viewer's perspective. Envoy is "administrator".
  const confirmedThreadMessages: ChatMessage[] = useMemo(() => {
    return messages
      .filter(
        (m) =>
          m.role === "administrator" ||
          m.role === "guest" ||
          m.role === "host",
      )
      .map((m) => ({
        id: m.id,
        role: m.role === "administrator" ? ("agent" as const) : ("guest" as const),
        text: m.content,
        timestamp: m.createdAt ?? new Date().toISOString(),
      }));
  }, [messages]);

  // Stage 3 V2 — first-occurrence map: for each external_agent identity
  // (delegateSpeaker.name or "unknown-agent"), the earliest index in the
  // transcript. The primer renders above the bubble at that index if the
  // viewer hasn't already seen the primer for that pair. Computed at the
  // top level so the hook call stays stable across early returns below.
  const firstExternalAgentIdxByIdentity = useMemo(() => {
    const out = new Map<string, number>();
    messages.forEach((m, i) => {
      if (m.role !== "external_agent") return;
      const identity = agentIdentityFrom(
        m.metadata as
          | { delegateSpeaker?: { name?: string | null } | null | undefined }
          | null
          | undefined,
      );
      if (!out.has(identity)) out.set(identity, i);
    });
    return out;
  }, [messages]);

  // --- Archived state ---
  if (archivedData) {
    const hostFirst = archivedData.hostName?.split(" ")[0] || "the host";
    const primaryUrl = archivedData.hostMeetSlug
      ? `/meet/${archivedData.hostMeetSlug}`
      : null;
    return (
      <div className="min-h-screen bg-surface flex flex-col">
        <PublicHeader />
        <div className="flex-1 flex items-center justify-center px-6 py-12">
          <div className="text-center max-w-md">
            <div className="w-16 h-16 mx-auto mb-5 rounded-full bg-surface-secondary border border-DEFAULT flex items-center justify-center">
              <svg className="w-7 h-7 text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5m8.25 3v6.75m0 0l-3-3m3 3l3-3M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z" />
              </svg>
            </div>
            <h1 className="text-xl font-bold text-primary mb-2">Meeting Unavailable</h1>
            <p className="text-sm text-muted mb-6">
              This meeting isn&rsquo;t available right now.
            </p>
            {primaryUrl && (
              <div className="mb-6 p-5 rounded-xl bg-surface-secondary border border-DEFAULT text-left">
                <div className="text-[10px] font-bold uppercase tracking-wider text-indigo-400 mb-2">
                  Book time with {hostFirst}
                </div>
                <p className="text-sm text-secondary mb-4">
                  You can still set up a meeting using {hostFirst}&rsquo;s link.
                </p>
                <a
                  href={primaryUrl}
                  className="block w-full text-center px-4 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-lg transition"
                >
                  Book a time with {hostFirst}
                </a>
              </div>
            )}
            {archivedData.hostEmail && (
              <p className="text-xs text-muted">
                Or email{" "}
                <a href={`mailto:${archivedData.hostEmail}`} className="text-indigo-400 hover:text-indigo-300">
                  {archivedData.hostEmail}
                </a>
                .
              </p>
            )}
          </div>
        </div>
      </div>
    );
  }

  // --- Error state ---
  if (error) {
    return (
      <div className="min-h-screen bg-surface flex flex-col">
        <PublicHeader />
        <div className="flex-1 flex items-center justify-center px-6 py-12">
          <div className="text-center">
            <div className="text-4xl mb-4">&#128533;</div>
            <h1 className="text-xl font-bold text-primary mb-2">Link not found</h1>
            <p className="text-muted">{error}</p>
          </div>
        </div>
      </div>
    );
  }

  // --- ICS download helper ---
  function downloadIcs() {
    if (!confirmData) return;
    const dt = new Date(confirmData.dateTime as string);
    const end = new Date(dt.getTime() + (Number(confirmData.duration) || 30) * 60000);
    const fmt = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const dealRoomUrl = `${window.location.origin}/meet/${slug}${code ? `/${code}` : ""}`;
    const descParts = [
      `Scheduled via AgentEnvoy`,
      ...(confirmData.meetLink ? [`Join: ${confirmData.meetLink}`] : []),
      "",
      `Need to change or cancel? ${dealRoomUrl}`,
    ];
    // ICS DESCRIPTION uses escaped newlines
    const icsDesc = descParts.join("\\n");
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      `DTSTART:${fmt(dt)}`,
      `DTEND:${fmt(end)}`,
      `SUMMARY:${getEventTitle()}`,
      `DESCRIPTION:${icsDesc}`,
      `URL:${dealRoomUrl}`,
      confirmData.location ? `LOCATION:${confirmData.location}` : "",
      "END:VEVENT",
      "END:VCALENDAR",
    ].filter(Boolean).join("\r\n");
    const blob = new Blob([ics], { type: "text/calendar" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "meeting.ics";
    a.click();
    URL.revokeObjectURL(url);
  }

  // --- Sticky event card (shows in all states) ---
  // Determine the latest proposal from messages (for "Proposed" state). Local
  // pendingProposal (from a chip click) takes precedence so the top card
  // updates instantly even when Envoy hasn't been round-tripped.
  const latestProposal = (() => {
    if (pendingProposal) return pendingProposal;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "administrator") {
        const { proposal } = parseConfirmationProposal(messages[i].content);
        if (proposal) return proposal;
      }
    }
    return null;
  })();

  // Server-driven status — confirmed state overrides sessionStatus for backwards compat
  const eventStatus = confirmed ? "agreed" : sessionStatus;

  // Event details come from confirmData (confirmed) or latestProposal (proposed) or just title (scheduling)
  const eventDateTime = confirmed && confirmData
    ? confirmData.dateTime as string
    : latestProposal?.dateTime ?? null;
  const eventFormat = confirmed && confirmData
    ? String(confirmData.format)
    : latestProposal?.format ?? linkFormat ?? null;
  const eventDuration = confirmed && confirmData
    ? String(confirmData.duration)
    // B2: linkDuration fallback — when slotDuration is undefined (e.g. slots API
    // compute_failed), the session response's data.link?.duration is the
    // authoritative link-configured duration. Avoids "30 min" header on a
    // 60-min Tutoring bookable when slots failed to compute.
    : latestProposal ? String(latestProposal.duration) : String(slotDuration ?? linkDuration ?? 30);
  const eventLocation = confirmed && confirmData
    ? (confirmData.location as string | null)
    : latestProposal?.location ?? linkLocation ?? null;
  const eventMeetLink = confirmed && confirmData
    ? (confirmData.meetLink as string | undefined)
    : undefined;

  const hasExtraDetails = !!(eventMeetLink || eventLocation);

  // Generate Google Calendar "add event" URL from event details
  const googleCalUrl = (() => {
    if (!eventDateTime) return null;
    const dt = new Date(eventDateTime);
    const dur = Number(eventDuration) || 30;
    const end = new Date(dt.getTime() + dur * 60000);
    const fmt = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const drUrl = `${window.location.origin}/meet/${slug}${code ? `/${code}` : ""}`;
    const detailParts = [
      ...(eventMeetLink ? [`Join: ${eventMeetLink}`] : []),
      "",
      `Need to change or cancel? ${drUrl}`,
    ];
    const params = new URLSearchParams({
      action: "TEMPLATE",
      text: getEventTitle(),
      dates: `${fmt(dt)}/${fmt(end)}`,
      details: detailParts.join("\n"),
      ...(eventLocation ? { location: eventLocation } : {}),
    });
    return `https://calendar.google.com/calendar/render?${params.toString()}`;
  })();


  // Status prefix mapping — replaces the old chip + dot. The status word
  // leads the title ("Confirmed: Call with Katie") and carries the color.
  const STATUS_PREFIX: Record<string, { word: string; color: string }> = {
    active:    { word: "Scheduling", color: "text-zinc-500 dark:text-zinc-400" },
    proposed:  { word: "Proposed",   color: "text-amber-600 dark:text-amber-400" },
    agreed:    { word: "Confirmed",  color: "text-emerald-600 dark:text-emerald-400" },
    cancelled: { word: "Cancelled",  color: "text-red-600 dark:text-red-400" },
    escalated: { word: "Escalated",  color: "text-orange-600 dark:text-orange-400" },
    expired:   { word: "Expired",    color: "text-zinc-500" },
  };
  const statusPrefix = STATUS_PREFIX[eventStatus] || STATUS_PREFIX.active;

  // Detect the video provider from the meet link so the "where to join"
  // line can label it (Google Meet · meet.google.com/…). Falls back to
  // "Video" when nothing matches.
  const meetProvider = (() => {
    if (!eventMeetLink) return null;
    if (eventMeetLink.includes("meet.google")) return "Google Meet";
    if (eventMeetLink.includes("zoom.")) return "Zoom";
    if (eventMeetLink.includes("teams.microsoft")) return "Teams";
    if (eventMeetLink.includes("webex.com")) return "Webex";
    return "Video";
  })();

  // Whether the ⋯ menu has anything in it for the current viewer. If not,
  // hide the kebab entirely.
  const menuHasItems =
    (confirmed && eventStatus !== "cancelled" && (!!googleCalUrl || true /* .ics always */)) ||
    (confirmed || eventStatus === "cancelled") /* Find a new time */ ||
    hasExtraDetails ||
    (isHost && !!sessionId) /* Archive */ ||
    (isHost && confirmed) /* Cancel meeting */;

  const eventCard = (
    <div className={`z-10 px-4 sm:px-5 pt-3 sm:pt-4 pb-2 bg-surface/95 backdrop-blur-sm flex-shrink-0 transition-all duration-500`}>
      <div className={`max-w-3xl rounded-xl border-[3px] px-4 py-3 transition-all duration-700 ${
        confirmed
          ? "border-emerald-500 dark:border-emerald-400 bg-emerald-500/[0.04] shadow-lg shadow-emerald-500/10 ring-4 ring-emerald-500/15 dark:ring-emerald-400/15"
          : eventStatus === "cancelled"
            ? "border-red-400/70 dark:border-red-500/60 bg-red-500/[0.03] shadow-md"
            : "border-zinc-300 dark:border-zinc-700 bg-black/[0.02] dark:bg-white/[0.03] shadow-md shadow-black/5"
      } ${
        justConfirmedGlow
          ? "ring-4 ring-emerald-400/60 shadow-[0_0_28px_rgba(16,185,129,0.4)] scale-[1.01]"
          : statusAnimating
            ? (eventStatus === "confirmed" ? "ring-emerald-500/40" : eventStatus === "cancelled" ? "ring-red-500/40" : "ring-amber-300 dark:ring-amber-500/40")
            : ""
      }`}>
        {/* Title row — status leads ("Confirmed: Call with Katie"). The
            colored prefix replaces the old floating dot + chip. ⋯ on the
            right opens the action menu. */}
        <div className="flex items-center gap-2 mb-1">
          <span className={`text-sm font-bold flex-shrink-0 ${statusPrefix.color}`}>
            {statusPrefix.word}:
          </span>
          <span className="text-sm font-semibold text-primary truncate">{getEventTitle()}</span>
          {isVip && <span className="text-[10px] text-amber-500/60 dark:text-amber-400/50 flex-shrink-0 select-none" title="Priority meeting">★</span>}
          <EditedPill
            lastMaterialEditAt={lastMaterialEditAt}
            lastEditedFields={lastEditedFields}
            className="ml-1"
          />
          {menuHasItems && (
            <div className="relative ml-auto flex-shrink-0" ref={actionMenuRef}>
              <button
                onClick={() => setShowActionMenu((v) => !v)}
                className="w-7 h-7 rounded-lg flex items-center justify-center text-muted hover:text-primary hover:bg-surface-secondary border border-transparent hover:border-DEFAULT transition text-base leading-none"
                title="More actions"
                aria-label="More actions"
                data-testid="event-card-actions-button"
              >
                ⋯
              </button>
              {showActionMenu && (
                <div className="absolute right-0 top-9 z-30 min-w-[220px] rounded-lg border border-DEFAULT bg-surface-inset shadow-2xl py-1.5 text-xs">
                  {confirmed && eventStatus !== "cancelled" && googleCalUrl && (
                    <a
                      href={googleCalUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={() => setShowActionMenu(false)}
                      className="flex items-center gap-2 px-3 py-1.5 text-primary hover:bg-surface-secondary"
                    >
                      <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 flex-shrink-0">
                        <path d="M18.316 5.684H24v12.632h-5.684V5.684z" fill="#1967D2" />
                        <path d="M5.684 18.316V5.684L0 5.684v12.632l5.684 0z" fill="#188038" />
                        <path d="M18.316 24V18.316H5.684V24h12.632z" fill="#1967D2" />
                        <path d="M18.316 5.684V0H5.684v5.684h12.632z" fill="#EA4335" />
                        <path d="M18.316 18.316H5.684V5.684h12.632v12.632z" fill="#fff" />
                        <path d="M9.2 15.7V9.1h1.5v2.4h2.6V9.1h1.5v6.6h-1.5v-2.8h-2.6v2.8H9.2z" fill="#1967D2" />
                      </svg>
                      Add to Google Calendar
                    </a>
                  )}
                  {confirmed && eventStatus !== "cancelled" && (
                    <button
                      onClick={() => { downloadIcs(); setShowActionMenu(false); }}
                      className="w-full text-left flex items-center gap-2 px-3 py-1.5 text-primary hover:bg-surface-secondary"
                    >
                      <span aria-hidden>📅</span> Download .ics
                    </button>
                  )}
                  {(confirmed || eventStatus === "cancelled") && (
                    <button
                      onClick={() => {
                        setProposeChangesCount((n) => n + 1);
                        setShowActionMenu(false);
                        setTimeout(() => {
                          document.querySelector<HTMLDivElement>("[data-messages-end]")?.scrollIntoView({ behavior: "smooth" });
                        }, 50);
                      }}
                      className="w-full text-left flex items-center gap-2 px-3 py-1.5 text-primary hover:bg-surface-secondary"
                    >
                      <span aria-hidden>🕒</span> Find a new time
                    </button>
                  )}
                  {hasExtraDetails && (
                    <button
                      onClick={() => { setShowDetailsModal(true); setShowActionMenu(false); }}
                      className="w-full text-left flex items-center gap-2 px-3 py-1.5 text-primary hover:bg-surface-secondary"
                    >
                      <span aria-hidden>ℹ️</span> Details
                    </button>
                  )}
                  {isHost && (sessionId || confirmed) && <div className="my-1 border-t border-DEFAULT" />}
                  {isHost && sessionId && (
                    <button
                      onClick={async () => {
                        if (isArchiving) return;
                        setIsArchiving(true);
                        try {
                          const res = await fetch("/api/negotiate/archive", {
                            method: "PATCH",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ sessionId, archived: true }),
                          });
                          if (res.ok) {
                            window.location.href = "/dashboard/event-links";
                          }
                        } finally {
                          setIsArchiving(false);
                          setShowActionMenu(false);
                        }
                      }}
                      disabled={isArchiving}
                      className="w-full text-left flex items-center gap-2 px-3 py-1.5 text-primary hover:bg-surface-secondary disabled:opacity-50"
                      data-testid="deal-room-archive-button"
                    >
                      <span aria-hidden>📥</span> {isArchiving ? "Archiving…" : "Archive"}
                    </button>
                  )}
                  {isHost && confirmed && (
                    <button
                      onClick={() => { setShowCancelModal(true); setShowActionMenu(false); }}
                      className="w-full text-left flex items-center gap-2 px-3 py-1.5 text-red-400 hover:bg-red-500/10"
                    >
                      <span aria-hidden>🚫</span> Cancel meeting
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Participants row (group events) */}
        {isGroupEvent && participants.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 mb-1">
            {participants.map((p, i) => (
              <span key={i} className="flex items-center gap-1 text-xs text-secondary">
                <span className={`w-1.5 h-1.5 rounded-full ${
                  p.status === "agreed" ? "bg-emerald-400" :
                  p.status === "active" ? "bg-amber-400" :
                  p.status === "declined" ? "bg-red-400" : "bg-zinc-500"
                }`} />
                {p.name}
              </span>
            ))}
          </div>
        )}

        {/* GroupDayGrid — day availability picker for group events */}
        {isGroupEvent && groupCoordination?.candidateDays && groupCoordination.candidateDays.length > 0 && (
          <GroupDayGrid
            candidateDays={groupCoordination.candidateDays}
            responses={groupCoordination.responses}
            hostName={hostName}
            mySessionId={sessionId}
            myPersonLabel={formGuestName || undefined}
            isHost={isHost}
            onVote={(date, available) => {
              if (!sessionId) return;
              fetch("/api/negotiate/group-day-vote", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ negotiationSessionId: sessionId, date, available }),
              }).then(async (res) => {
                if (res.ok) {
                  const updated = { ...groupCoordination };
                  const responses = [...(updated.responses || [])];
                  const myLabel = formGuestName || `Guest (${sessionId.slice(-4)})`;
                  const idx = responses.findIndex((r) => r.person === myLabel);
                  if (idx >= 0) {
                    responses[idx] = { ...responses[idx], dayVotes: { ...(responses[idx].dayVotes || {}), [date]: available } };
                  } else {
                    responses.push({ person: myLabel, dayVotes: { [date]: available } });
                  }
                  setGroupCoordination({ ...updated, responses } as typeof groupCoordination);
                }
              });
            }}
          />
        )}

        {/* B5: bookable subtitle — guest-only, not shown to host or after confirm. */}
        {isBookable && !isHost && (
          <span className="text-xs text-secondary italic">
            Bookable — anyone with this link can book
          </span>
        )}

        {/* Meta line — activity icon + duration + (when set) datetime.
            The format word ("Video" / "Phone") drops out once we have a
            time, since the icon + join line below already convey it.
            Pre-confirm fallback below covers the "no time, no format"
            case from link.parameters. */}
        {/* Sub-lines (meta · join · rsvp) all share the same row shape:
            fixed-width icon column so text left-aligns vertically, same
            font size + color across rows. */}
        <div className="space-y-0.5">
          {(eventFormat || linkActivityIcon || linkActivity) && (() => {
            const icon = linkActivityIcon || getMeetingEmoji(eventFormat, eventLocation || linkLocation, linkActivity) || "🕐";
            const formatText = eventFormat === "phone" ? "Phone" : eventFormat === "video" ? "Video" : eventFormat === "in-person" ? "In person" : eventFormat;
            const formatSuffix = linkGuestPicksFormat ? " ✏️" : "";
            const durationSuffix = linkGuestPicksDuration ? " ✏️" : "";
            const showFormatWord = !eventDateTime && !!formatText;
            const dt = eventDateTime ? new Date(eventDateTime) : null;
            const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
            const hostTz = slotTimezone;
            const showDual = !!dt && hostTz && hostTz !== localTz;
            const datePart = dt ? dt.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }) : null;
            const localTime = dt ? dt.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZoneName: "short" }) : null;
            const hostTime = showDual && dt ? dt.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZoneName: "short", timeZone: hostTz }) : null;
            return (
              <div className="flex items-center gap-2 text-xs text-secondary">
                <span aria-hidden className="w-4 inline-flex justify-center text-sm leading-none flex-shrink-0">{icon}</span>
                <span>
                  {showFormatWord && <>{formatText}{formatSuffix} <span className="text-muted">·</span> </>}
                  {eventDuration} min{durationSuffix}
                  {dt && <> <span className="text-muted">·</span> {datePart} {localTime}{hostTime ? ` (${hostTime})` : ""}</>}
                </span>
              </div>
            );
          })()}
          {!eventDateTime && !eventFormat && !linkActivity && !linkActivityIcon && (() => {
            const parts: string[] = [];
            if (slotDuration) parts.push(formatDuration(slotDuration) + (linkGuestPicksDuration ? " ✏️" : ""));
            if (linkTimingLabel) parts.push(linkTimingLabel + (linkGuestPicksDate ? " ✏️" : ""));
            if (linkLocation) {
              parts.push(`📍 ${linkLocation}` + (linkGuestPicksLocation ? " ✏️" : ""));
            } else if (linkGuestPicksLocation) {
              parts.push("✏️ Pick a location");
            }
            return (
              <div className="flex items-center gap-2 text-xs text-secondary">
                <span aria-hidden className="w-4 inline-flex justify-center text-sm leading-none flex-shrink-0">🕐</span>
                <span>{parts.length === 0 ? "Meeting details pending" : parts.join(" · ")}</span>
              </div>
            );
          })()}

          {/* Where to join — own line when confirmed. */}
          {confirmed && eventMeetLink && (
            <div className="flex items-center gap-2 text-xs text-secondary">
              <span aria-hidden className="w-4 inline-flex justify-center text-sm leading-none flex-shrink-0">🔗</span>
              <span className="min-w-0 truncate">
                {meetProvider} <span className="text-muted">·</span>{" "}
                <a
                  href={eventMeetLink}
                  className="text-indigo-400 hover:text-indigo-300"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {eventMeetLink.replace(/^https?:\/\//, "").split("/").slice(0, 2).join("/")}
                </a>
              </span>
            </div>
          )}
          {confirmed && !eventMeetLink && eventLocation && (
            <div className="flex items-center gap-2 text-xs text-secondary">
              <span aria-hidden className="w-4 inline-flex justify-center text-sm leading-none flex-shrink-0">📍</span>
              <span className="truncate" title={eventLocation}>{eventLocation}</span>
            </div>
          )}
        </div>

        {/* Deferral status line — "🤔 Gathering John's suggestions on the
            location". Same neutral phrasing on host + guest views. Suppressed
            post-confirm; deferrals stop mattering once a slot is locked. */}
        {!confirmed && (() => {
          const deferred: DeferralFieldNoun[] = [];
          if (linkGuestPicksLocation) deferred.push("location");
          if (linkGuestPicksDuration) deferred.push("length");
          if (linkGuestPicksFormat) deferred.push("format");
          const list = formatDeferralFieldsList(deferred);
          if (!list) return null;
          const firstName = (inviteeName || "").split(/\s+/)[0] || "the guest";
          return (
            <div className="mt-1 text-xs italic text-muted">
              🤔 Gathering {firstName}&apos;s suggestions on {list}
            </div>
          );
        })()}

        {/* T3c: host-only soft upsell when the confirm pipeline degraded
            to .ics-only (no calendar.events write scope). Degrade-not-block:
            the meeting is confirmed, we just couldn't auto-add it to GCal. */}
        {isHost && confirmed && calendarWriteUnavailable && (
          <div className="mt-2.5 flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 dark:border-amber-500/30 dark:bg-amber-500/5 px-3 py-2">
            <span className="text-amber-400 text-sm leading-5">⚠</span>
            <div className="flex-1 text-xs text-amber-800 dark:text-amber-200/90 leading-5">
              <span className="font-medium">Not on your Google Calendar.</span>{" "}
              Grant calendar write access to auto-add future meetings — or grab the .ics from the ⋯ menu.
            </div>
            <button
              onClick={writeScopeReconnect.trigger}
              className="text-xs font-medium text-amber-700 hover:text-amber-900 dark:text-amber-300 dark:hover:text-amber-200 transition whitespace-nowrap"
            >
              Grant access
            </button>
            {writeScopeReconnect.modal}
          </div>
        )}

        {/* Cancelled-state banner — per 2026-04-20 proposal §Q4, cancelled
            sessions stay visible in the feed (NOT auto-archived) with a
            banner that offers a fresh-start path. */}
        {eventStatus === "cancelled" && (
          <div className="mt-2.5 px-3 py-2.5 rounded-lg border border-red-500/20 bg-red-500/5">
            <div className="text-xs text-secondary mb-2">
              This meeting was cancelled. The deal room stays here for reference.
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {isHost ? (
                <a
                  href="/dashboard"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-indigo-500/90 hover:bg-indigo-500 text-white rounded-lg transition"
                >
                  Schedule something new →
                </a>
              ) : (
                <a
                  href={`/meet/${slug}`}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-indigo-500/90 hover:bg-indigo-500 text-white rounded-lg transition"
                >
                  Reach {hostName ? hostName.split(" ")[0] : "them"} again →
                </a>
              )}
            </div>
          </div>
        )}

        {/* Host informational row — group-link indicator (non-confirmed)
            and GCal sync status (confirmed). Cancel/Archive moved into
            the ⋯ menu above. */}
        {isHost && eventStatus !== "cancelled" && (
          (!confirmed && isGroupEvent) || (confirmed && gcalStatus)
        ) && (
          <div className="mt-2 flex items-center gap-3 flex-wrap">
            {!confirmed && isGroupEvent && (
              <span className="text-[11px] text-muted">
                Group link active — share link to add people
              </span>
            )}
            {confirmed && gcalStatus && gcalStatus.eventExists && (() => {
              const guestFirstName =
                (formGuestName || inviteeName || "").split(/\s+/)[0] || "Guest";
              const rsvp = gcalStatus.guestResponseStatus;
              const notOnInvite = gcalStatus.guestOnInvite === false;
              if (!notOnInvite && !rsvp) return null;
              const text = notOnInvite
                ? `${guestFirstName} not on invite`
                : rsvp === "accepted"  ? `${guestFirstName} accepted invite`
                : rsvp === "declined"  ? `${guestFirstName} declined invite`
                : rsvp === "tentative" ? `${guestFirstName} marked maybe`
                                       : `${guestFirstName} RSVP pending`;
              const color = notOnInvite
                ? "text-amber-500 dark:text-amber-400"
                : rsvp === "accepted"  ? "text-emerald-600 dark:text-emerald-500"
                : rsvp === "declined"  ? "text-red-500 dark:text-red-400"
                                       : "text-secondary";
              const dot = notOnInvite
                ? "bg-amber-400"
                : rsvp === "accepted"  ? "bg-emerald-500"
                : rsvp === "declined"  ? "bg-red-400"
                                       : "bg-zinc-500";
              const inner = (
                <>
                  <span className="w-4 inline-flex justify-center flex-shrink-0">
                    <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />
                  </span>
                  <span>
                    {text}
                    {gcalStatus.htmlLink && (
                      <span className="text-muted ml-1" aria-hidden>↗</span>
                    )}
                  </span>
                </>
              );
              return gcalStatus.htmlLink ? (
                <a
                  href={gcalStatus.htmlLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`flex items-center gap-2 text-xs ${color} hover:underline`}
                  title={notOnInvite
                    ? "Open the event in Google Calendar to add the guest"
                    : "Open the event in Google Calendar"}
                >
                  {inner}
                </a>
              ) : (
                <span className={`flex items-center gap-2 text-xs ${color}`}>
                  {inner}
                </span>
              );
            })()}
            {confirmed && gcalStatus && !gcalStatus.eventExists && (
              <span className="flex items-center gap-2 text-xs text-muted">
                <span className="w-4 inline-flex justify-center flex-shrink-0">
                  <span className="w-1.5 h-1.5 rounded-full bg-zinc-500" />
                </span>
                Not found on Google Calendar
              </span>
            )}
          </div>
        )}

        {/* Bookable-by-agents footer — small dashed-top pointer to /agents.
            Replaces the prior full-sentence "AI agents: book via API at …"
            line. The Link: rel="agent-api" middleware header still carries
            the URL for non-rendering agents. */}
        <div className="mt-2.5 pt-2 border-t border-dashed border-black/5 dark:border-white/5 flex justify-end">
          <a
            href="/agents"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[11px] text-muted hover:text-indigo-400 transition"
            title="Bookable by AI agents via MCP — agentenvoy.ai/api/mcp (docs at /agents)"
          >
            🤖 Bookable by agents →
          </a>
        </div>
      </div>
    </div>
  );

  // --- Details modal ---
  const detailsModal = showDetailsModal ? (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setShowDetailsModal(false)}>
      <div className="bg-surface-inset border border-DEFAULT rounded-2xl p-6 w-full max-w-sm mx-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-semibold text-primary mb-4">Meeting Details</h3>
        <div className="space-y-3 text-sm text-primary">
          <div><span className="text-muted">Title:</span> {getEventTitle()}</div>
          {eventDateTime && <div><span className="text-muted">When:</span> {new Date(eventDateTime).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })} at {new Date(eventDateTime).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZoneName: "short" })}</div>}
          {eventFormat && <div><span className="text-muted">Format:</span> {eventFormat.charAt(0).toUpperCase() + eventFormat.slice(1)} &middot; {eventDuration} min</div>}
          {eventLocation && <div><span className="text-muted">Location:</span> {eventLocation}</div>}
          {eventMeetLink && <div><span className="text-muted">Link:</span> <a href={eventMeetLink} className="text-indigo-400 hover:text-indigo-300" target="_blank" rel="noopener noreferrer">{eventMeetLink}</a></div>}
          {hostName && <div><span className="text-muted">Host:</span> {hostName}</div>}
        </div>
        {confirmed && (
          <div className="flex gap-2 mt-4">
            <button onClick={downloadIcs} className="flex-1 px-3 py-2 text-xs font-medium bg-surface-secondary text-primary border border-DEFAULT rounded-lg hover:border-zinc-600 transition">Download .ics</button>
            {googleCalUrl && (
              <a href={googleCalUrl} target="_blank" rel="noopener noreferrer" className="flex-1 px-3 py-2 text-xs font-medium bg-emerald-900/40 text-emerald-300 border border-emerald-500/20 rounded-lg hover:border-emerald-500/40 transition text-center">Add to Google</a>
            )}
          </div>
        )}
        <button onClick={() => setShowDetailsModal(false)} className="w-full mt-3 px-3 py-2 text-xs text-muted border border-secondary rounded-lg hover:border-DEFAULT transition">Close</button>
      </div>
    </div>
  ) : null;

  // --- Cancel confirm modal ---
  const cancelModal = showCancelModal ? (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => !isCancelling && setShowCancelModal(false)}>
      <div className="bg-surface-inset border border-DEFAULT rounded-2xl p-6 w-full max-w-sm mx-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-semibold text-primary mb-2">Cancel this meeting?</h3>
        <p className="text-xs text-secondary mb-1">This will:</p>
        <ul className="text-xs text-secondary space-y-1 mb-4 ml-3 list-disc">
          <li>Delete the Google Calendar event and notify all attendees</li>
          <li>Release any holds blocking your calendar</li>
          <li>Mark this deal room as cancelled (still visible in the feed)</li>
        </ul>
        <p className="text-xs text-zinc-500 mb-5">This can&apos;t be undone.</p>
        <div className="flex gap-2">
          <button
            onClick={() => setShowCancelModal(false)}
            disabled={isCancelling}
            className="flex-1 px-3 py-2 text-xs text-secondary border border-secondary rounded-lg hover:border-DEFAULT transition disabled:opacity-50"
          >
            Keep it
          </button>
          <button
            onClick={async () => {
              if (!sessionId || isCancelling) return;
              setIsCancelling(true);
              try {
                const res = await fetch("/api/negotiate/cancel", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ sessionId }),
                });
                if (res.ok) {
                  // Stay on the deal room — it now renders the cancelled
                  // banner with a fresh-start CTA. Reload so the updated
                  // session state (status, system message) is picked up.
                  window.location.reload();
                } else {
                  const data = await res.json();
                  alert(data.error || "Cancel failed — please try again.");
                  setIsCancelling(false);
                  setShowCancelModal(false);
                }
              } catch {
                setIsCancelling(false);
                setShowCancelModal(false);
              }
            }}
            disabled={isCancelling}
            className="flex-1 px-3 py-2 text-xs font-medium bg-red-900/40 text-red-300 border border-red-500/30 rounded-lg hover:bg-red-900/60 hover:border-red-500/50 transition disabled:opacity-50"
          >
            {isCancelling ? "Cancelling…" : "Yes, cancel"}
          </button>
        </div>
      </div>
    </div>
  ) : null;

  // --- Main content ---
  // Inline picker bubble — rendered as an Envoy "quick action" inside the
  // message thread. Used (1) once after the first administrator message so
  // guests see the picker without it floating above, and (2) every time the
  // guest clicks "Propose changes" on a confirmed meeting.
  //
  // Stage 2 state-machine: in `offer` mode the OfferCard replaces this
  // picker entirely — see the OfferCard render below. Suppress the picker
  // here to avoid rendering two widgets. Host-view and confirmed-view keep
  // the picker as today.
  const renderPickerBubble = (keyPrefix: string) => {
    // Post-OAuth slot/bilateral refetch in flight — show a "matching
    // availability…" spinner so the user doesn't stare at a blank gap
    // for 1-3 seconds while Google freebusy + scoring runs. Skips host
    // view (hosts don't go through the OAuth round-trip here).
    if (postConnectRefetching && !isHost && !confirmed) {
      return (
        <div
          key={`${keyPrefix}-post-connect-loading`}
          className="flex justify-start"
        >
          <div className="max-w-[85%] rounded-2xl rounded-bl-sm bg-emerald-500/10 border border-emerald-500/20 px-4 py-3 text-sm text-emerald-200 leading-snug flex items-center gap-2.5">
            <span
              aria-hidden="true"
              className="inline-block w-3 h-3 rounded-full border-2 border-emerald-300/40 border-t-emerald-300 animate-spin"
            />
            <span>Matching your availability…</span>
          </div>
        </div>
      );
    }

    // WISHLIST §1o PR-α: when the slot fetch resolved to one of the three
    // empty/error states, render an inline message between greeting and
    // composer instead of silently returning null. Guards skip host-view
    // and confirmed-view — both legitimately have no actionable picker
    // here and shouldn't surface the new copy.
    if (!slotsByDay || Object.keys(slotsByDay).length === 0) {
      if (isHost || confirmed) return null;
      const inline = (() => {
        if (slotFetchState.kind === "compute_failed") {
          return (
            <div
              key={`${keyPrefix}-slot-compute-failed`}
              className="flex justify-start"
            >
              <div className="max-w-[85%] rounded-2xl rounded-bl-sm bg-amber-50 border border-amber-200 dark:bg-amber-500/10 dark:border-amber-500/20 px-4 py-3 text-sm text-amber-800 dark:text-amber-200 leading-snug">
                <div className="text-[10px] font-bold uppercase tracking-wider mb-1 text-amber-700 dark:text-amber-300">
                  Envoy
                </div>
                <div>
                  Couldn&apos;t load times right now.{" "}
                  <button
                    type="button"
                    onClick={() => {
                      if (typeof window !== "undefined") window.location.reload();
                    }}
                    className="underline underline-offset-2 hover:text-amber-900 dark:hover:text-amber-100"
                  >
                    Refresh to try again
                  </button>
                  .
                </div>
              </div>
            </div>
          );
        }
        if (slotFetchState.kind === "calendar_disconnected") {
          return (
            <div
              key={`${keyPrefix}-slot-calendar-disconnected`}
              className="flex justify-start"
            >
              <div className="max-w-[85%] rounded-2xl rounded-bl-sm bg-surface-secondary border border-DEFAULT px-4 py-3 text-sm text-primary leading-snug">
                <div className="text-[10px] font-bold uppercase tracking-wider mb-1 text-emerald-400">
                  Envoy
                </div>
                <div>
                  The host needs to reconnect their calendar — please use the
                  chat below and I&apos;ll loop them in.
                </div>
              </div>
            </div>
          );
        }
        if (slotFetchState.kind === "no_slots") {
          return (
            <div
              key={`${keyPrefix}-slot-no-slots`}
              className="flex justify-start"
            >
              <div className="max-w-[85%] rounded-2xl rounded-bl-sm bg-surface-secondary border border-DEFAULT px-4 py-3 text-sm text-primary leading-snug">
                <div className="text-[10px] font-bold uppercase tracking-wider mb-1 text-emerald-400">
                  Envoy
                </div>
                <div>
                  No times available right now — please use the chat below and
                  we&apos;ll find something that works.
                </div>
              </div>
            </div>
          );
        }
        return null;
      })();
      return inline;
    }
    if (dealRoomMode === "offer" && !confirmed && !isHost) return null;
    // Timezone picker (shipped 2026-04-21 per guest-tz-ux-three-primitives).
    // Sits above any other header content. Rendered whenever the guest is a
    // human viewer and we know the host's tz (not for host-viewing-own-room).
    const tzPicker =
      sessionId && hostTimezone && !isHost ? (
        <TimezonePicker
          sessionId={sessionId}
          hostTimezone={hostTimezone}
          hostFirstName={hostName ? resolveHostFirstName({ name: hostName }) : "the host"}
          viewerTimezone={viewerTimezone}
          onTimezoneChange={(tz) => setViewerTimezoneState(tz)}
        />
      ) : null;

    const connectCta = (() => {
      if (isHost || isGuest || confirmed || !sessionId) return null;
      if (bilateralByDay && Object.keys(bilateralByDay).length > 0) return null;
      if (calendarDenied) {
        return (
          <div className="mb-2 px-3 py-2 rounded-md bg-amber-50 border border-amber-200 dark:bg-amber-500/10 dark:border-amber-500/20 text-[11px] text-amber-800 dark:text-amber-200 leading-snug">
            We didn&apos;t get permission to read your calendar — that&apos;s okay,
            you can still pick from the times below.
          </div>
        );
      }

      return (
        <DealRoomConnectCtas
          variant="bubble"
          sessionId={sessionId}
          slug={slug}
          code={code}
        />
      );
    })();

    const headerSlot = connectCta ? <>{connectCta}</> : null;

    // Stage 2 transition narration — shown when the guest lands in
    // `negotiate` mode after arriving from `offer`. Two variants:
    //   user-pick → user clicked "Pick a different time" on the OfferCard.
    //   slot-gone → confirm server returned slot_no_longer_offered (N2).
    // "Back to the suggested time" link only shows on user-pick (slot-gone
    // means the offered slot is gone — flipping back would be a lie).
    const narrationLine =
      !isHost && !confirmed && guestRequestedMoreOptions && transitionReason
        ? transitionReason === "slot-gone"
          ? "That time isn't available anymore — here are the current options."
          : "No problem — here's the full week."
        : null;
    const showBackToOffer =
      !isHost && !confirmed && transitionReason === "user-pick";

    return (
      <div key={keyPrefix} className="flex justify-start">
        <div className="max-w-[85%] w-full min-w-0 rounded-2xl px-3 pb-3 text-sm bg-surface-secondary border border-DEFAULT text-primary rounded-bl-sm">
          {narrationLine && (
            <div
              className="text-xs text-secondary leading-snug mb-2 px-1"
              role="status"
              aria-live="polite"
            >
              {narrationLine}
              {showBackToOffer && (
                <>
                  {" "}
                  <button
                    type="button"
                    className="underline text-emerald-400 hover:text-emerald-300 transition"
                    onClick={() => {
                      setGuestRequestedMoreOptions(false);
                      setTransitionReason(null);
                    }}
                  >
                    Back to the suggested time
                  </button>
                </>
              )}
            </div>
          )}
          {!isHost && !confirmed && bilateralByDay && (() => {
            // Find the first day with a "both free" chip to anchor the headline.
            const days = Object.keys(bilateralByDay).sort();
            const firstMatchDay = days.find((d) =>
              (bilateralByDay[d] || []).some((c) => c.color === "both"),
            );
            const matchCount = Object.values(bilateralByDay).filter((v) =>
              v.some((c) => c.color === "both"),
            ).length;
            const dayLabel = firstMatchDay
              ? new Date(firstMatchDay + "T12:00:00").toLocaleDateString("en-US", {
                  weekday: "short",
                  month: "short",
                  day: "numeric",
                })
              : undefined;
            if (matchCount === 0) return null;
            return <CelebrationBanner matchCount={matchCount} firstMatchDayLabel={dayLabel} />;
          })()}
          <MatchPulse
            justMatched={justMatched}
            matchCount={bilateralByDay ? Object.values(bilateralByDay).filter((v) => v.some((c) => c.color === "both")).length : 0}
            enabled={!isHost && !confirmed}
          >
          <AvailabilityCalendar
            view="week"
            schedulingMode={schedulingMode}
            slotsByDay={slotsByDay || {}}
            timezone={slotTimezone}
            currentLocation={slotLocation}
            duration={slotDuration}
            minDuration={slotMinDuration}
            onSelectSlot={!isHost && !confirmed && schedulingMode === "time" ? (_msg, slot) => {
              if (slot) proposeFromSlot(slot);
            } : undefined}
            onSelectDate={!isHost && !confirmed && schedulingMode === "date" ? handleSelectDate : undefined}
            onTimezoneClick={() => {
              setInput("I\u2019m actually in a different timezone \u2014 ");
              document.querySelector<HTMLTextAreaElement>("textarea")?.focus();
            }}
            headerSlot={headerSlot}
            footerSlot={tzPicker}
            bilateralByDay={bilateralByDay}
            bilateralPayload={bilateralPayload}
            hostFirstName={hostName ? resolveHostFirstName({ name: hostName }) : undefined}
            eventTitle={(() => {
              const hostFirst = hostName ? hostName.split(" ")[0] : "";
              const inviteeFirst = inviteeName ? inviteeName.split(" ")[0] : "";
              if (linkActivity && inviteeFirst) return `${linkActivity} with ${inviteeFirst}`;
              if (linkActivity && hostFirst) return `${linkActivity} with ${hostFirst}`;
              if (linkActivity) return linkActivity;
              return getEventTitle();
            })()}
          />
          </MatchPulse>
        </div>
      </div>
    );
  };

  // PR2c — Reschedule picker node: renders the AvailabilityCalendar when
  // reschedulingFromConfirmed is true. Bypasses renderPickerBubble's
  // `if (confirmed) return null` guards since this is an intentional re-open
  // of scheduling from the confirmed state.
  // Only rendered when slotsByDay has data; if slots aren't loaded, the
  // user can still type in the EnvoyDock thread.
  const reschedulePickerNode: React.ReactNode =
    reschedulingFromConfirmed && slotsByDay && Object.keys(slotsByDay).length > 0 ? (
      <AvailabilityCalendar
        view="week"
        schedulingMode={schedulingMode}
        slotsByDay={slotsByDay}
        timezone={slotTimezone}
        currentLocation={slotLocation}
        duration={slotDuration}
        minDuration={slotMinDuration}
        onSelectSlot={schedulingMode === "time" ? (_msg, slot) => {
          if (slot) proposeFromSlot(slot);
        } : undefined}
        onSelectDate={schedulingMode === "date" ? handleSelectDate : undefined}
        onTimezoneClick={() => {
          setInput("I’m actually in a different timezone — ");
        }}
        bilateralByDay={bilateralByDay}
        bilateralPayload={bilateralPayload}
        hostFirstName={hostName ? resolveHostFirstName({ name: hostName }) : undefined}
        eventTitle={(() => {
          const hostFirst = hostName ? hostName.split(" ")[0] : "";
          const inviteeFirst = inviteeName ? inviteeName.split(" ")[0] : "";
          if (linkActivity && inviteeFirst) return `${linkActivity} with ${inviteeFirst}`;
          if (linkActivity && hostFirst) return `${linkActivity} with ${hostFirst}`;
          if (linkActivity) return linkActivity;
          return getEventTitle();
        })()}
      />
    ) : reschedulingFromConfirmed ? (
      // No slots loaded — show a brief prompt directing to the chat thread
      <div className="p-4 text-sm text-[#9b9480] text-center">
        No availability loaded — use the chat below to find a new time.
      </div>
    ) : null;

  // ── New-card picker + confirm slots (2026-05-10) ──────────────────────────
  // The legacy renderPickerBubble wraps the AvailabilityCalendar in a
  // chat-style bubble (max-w-[85%], bg-surface-secondary) meant for the
  // legacy chat column. Inside the new MeetingCardProposalView's centered
  // max-w-[540px] frame that wrapper made the picker (a) cramped/off-center,
  // and — more critically — left the confirm-card form (name/email/phone
  // needed to actually book) unrendered because it lives separately in the
  // legacy render tree below. These two slots render the SAME picker +
  // confirm primitives in a wrapper-free shape suitable for the new card.
  const newCardPickerNode: React.ReactNode =
    !confirmed && !isHost && slotsByDay && Object.keys(slotsByDay).length > 0 ? (
      <div className="bg-white">
        <AvailabilityCalendar
          view="week"
          schedulingMode={schedulingMode}
          slotsByDay={slotsByDay}
          timezone={slotTimezone}
          currentLocation={slotLocation}
          duration={slotDuration}
          minDuration={slotMinDuration}
          onSelectSlot={schedulingMode === "time" ? (_msg, slot) => {
            if (slot) proposeFromSlot(slot);
          } : undefined}
          onSelectDate={schedulingMode === "date" ? handleSelectDate : undefined}
          onTimezoneClick={() => {
            setInput("I’m actually in a different timezone — ");
            document.querySelector<HTMLTextAreaElement>("textarea")?.focus();
          }}
          bilateralByDay={bilateralByDay}
          bilateralPayload={bilateralPayload}
          hostFirstName={hostName ? resolveHostFirstName({ name: hostName }) : undefined}
          eventTitle={(() => {
            const hostFirst = hostName ? hostName.split(" ")[0] : "";
            const inviteeFirst = inviteeName ? inviteeName.split(" ")[0] : "";
            if (linkActivity && inviteeFirst) return `${linkActivity} with ${inviteeFirst}`;
            if (linkActivity && hostFirst) return `${linkActivity} with ${hostFirst}`;
            if (linkActivity) return linkActivity;
            return getEventTitle();
          })()}
        />
      </div>
    ) : null;

  // Confirm-card slot — renders the name/email/phone form so the guest can
  // actually book the slot they just picked. Mirrors the legacy render at
  // line ~3111 but without the chat-bubble (max-w-[85%], dark theme) wrapper.
  // Shown only when there's something to confirm and we're a guest.
  const newCardConfirmNode: React.ReactNode = (() => {
    if (confirmed || isHost || !latestProposal) return null;
    if (dealRoomMode === "offer" && !confirmFormExpanded) return null;
    const effective = latestProposal;
    const dt = new Date(effective.dateTime);
    const inPast = dt.getTime() <= Date.now();
    const nameOk = formGuestName.trim().length > 0;
    const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formGuestEmail.trim());
    const canSubmit = !inPast && nameOk && emailOk;
    const clickConfirmButton = () => {
      if (!canSubmit) return;
      handleConfirm(
        { dateTime: effective.dateTime, duration: effective.duration, format: effective.format, location: effective.location },
        { guestName: formGuestName.trim(), guestEmail: formGuestEmail.trim(), guestNote: [formGuestPhone.trim() ? `Phone: ${formGuestPhone.trim()}` : null, formGuestNote.trim() || null].filter(Boolean).join("\n") || undefined }
      );
    };
    const metaParts = [
      `\u{1F4C5} ${dt.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: slotTimezone })}`,
      `\u{1F550} ${dt.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZoneName: "short", timeZone: slotTimezone })} · ${formatDuration(effective.duration)}`,
      `${getMeetingEmoji(effective.format, null) || "\u{1F550}"} ${effective.format.charAt(0).toUpperCase() + effective.format.slice(1)}`,
      ...(effective.location ? [`\u{1F4CD} ${effective.location}`] : []),
    ];
    return (
      <div className={`rounded-2xl border border-emerald-300 bg-emerald-50 px-4 pt-3 pb-4 space-y-2 ${pendingProposal ? "pick-pulse-once" : ""}`}>
        <div className="flex items-baseline gap-1.5 flex-wrap">
          <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-700 shrink-0">
            {pendingProposal ? "Your Pick:" : "Proposed Meeting:"}
          </span>
          <span className="text-xs text-zinc-600">{metaParts.join("  ·  ")}</span>
        </div>
        {inPast && (
          <p className="text-xs text-amber-700">This time is in the past. Pick another from the calendar.</p>
        )}
        <div className="pt-2 border-t border-emerald-200 space-y-1.5">
          <div className="grid grid-cols-2 gap-1.5">
            <div>
              <label className="block text-[10px] font-semibold uppercase tracking-wider text-emerald-700 mb-1">Name</label>
              <input
                type="text"
                value={formGuestName}
                onChange={(e) => setFormGuestName(e.target.value)}
                autoComplete="name"
                className="w-full px-2.5 py-1.5 bg-white border border-emerald-200 rounded-md text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:border-emerald-500"
                placeholder="Jane Doe"
              />
            </div>
            <div>
              <label className="block text-[10px] font-semibold uppercase tracking-wider text-emerald-700 mb-1">Email</label>
              <input
                type="email"
                value={formGuestEmail}
                onChange={(e) => setFormGuestEmail(e.target.value)}
                autoComplete="email"
                className="w-full px-2.5 py-1.5 bg-white border border-emerald-200 rounded-md text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:border-emerald-500"
                placeholder="jane@example.com"
              />
            </div>
          </div>
          <div>
            <label className="block text-[10px] font-semibold uppercase tracking-wider text-emerald-700 mb-1">
              Phone <span className="text-zinc-500 font-normal normal-case tracking-normal">(optional)</span>
            </label>
            <input
              type="tel"
              value={formGuestPhone}
              onChange={(e) => setFormGuestPhone(e.target.value)}
              autoComplete="tel"
              className="w-full px-2.5 py-1.5 bg-white border border-emerald-200 rounded-md text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:border-emerald-500"
              placeholder="+1 (555) 000-0000"
            />
          </div>
          <div>
            <label className="block text-[10px] font-semibold uppercase tracking-wider text-emerald-700 mb-1">
              Anything else? <span className="text-zinc-500 font-normal normal-case tracking-normal">(optional)</span>
            </label>
            <textarea
              value={formGuestNote}
              onChange={(e) => setFormGuestNote(e.target.value)}
              rows={2}
              maxLength={500}
              className="w-full px-2.5 py-1.5 bg-white border border-emerald-200 rounded-md text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:border-emerald-500 resize-none"
              placeholder="Agenda notes, anything the other person should know…"
            />
          </div>
        </div>
        <div className="flex items-center gap-3 mt-1">
          <button
            onClick={clickConfirmButton}
            disabled={isConfirming || inPast || !canSubmit}
            className="flex-1 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-sm font-semibold rounded-lg transition"
          >
            {isConfirming ? "Confirming..." : "Confirm"}
          </button>
          <button
            onClick={() => {
              if (pendingProposal) {
                setPendingProposal(null);
                setConfirmFormExpanded(false);
              } else {
                setInput("That’s close, but could we ");
                document.querySelector<HTMLTextAreaElement>("textarea")?.focus();
              }
            }}
            className="text-xs text-zinc-500 hover:text-zinc-700 transition whitespace-nowrap"
          >
            {pendingProposal ? "Pick a different time" : "Suggest a change"}
          </button>
        </div>
        {confirmError && (
          <p className="text-xs text-red-500">{confirmError}</p>
        )}
        {emailWarning && (
          <p className="text-xs text-amber-600">{emailWarning}</p>
        )}
      </div>
    );
  })();

  // Find the first administrator message so the inline picker can follow it.
  const firstAdminIdx = messages.findIndex((m) => m.role === "administrator");

  // Guest chat is default-on only when the link has something to negotiate:
  //   - activity menu (host offered choices)
  //   - guestPicks.location (host deferred venue selection to guest)
  //   - physical activity without a location (guest needs to confirm venue)
  // Hosts always see the full chat. Guests can open it manually regardless.
  const guestChatAutoOpen =
    !!(linkActivityOptions && linkActivityOptions.length > 1) ||
    linkGuestPicksLocation ||
    !!(linkActivity && !linkLocation);
  const showGuestChat = isHost || guestChatOpen || guestChatAutoOpen;

  const chatContent = (
    <>
      <div ref={messagesScrollRef} className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden p-4 space-y-4">
        {isLoading ? (
          <div className="flex justify-center py-12">
            <div className="flex gap-1">
              <div className="w-2 h-2 rounded-full bg-muted animate-bounce" />
              <div className="w-2 h-2 rounded-full bg-muted animate-bounce [animation-delay:0.1s]" />
              <div className="w-2 h-2 rounded-full bg-muted animate-bounce [animation-delay:0.2s]" />
            </div>
          </div>
        ) : (
          messages.map((msg, idx) => {
            // Date separator — show on first message of each new day
            let dateSeparator: React.ReactNode = null;
            if (msg.createdAt) {
              const msgDate = new Date(msg.createdAt).toLocaleDateString("en-US", {
                weekday: "short",
                month: "short",
                day: "numeric",
              });
              const prevDate = idx > 0 && messages[idx - 1]?.createdAt
                ? new Date(messages[idx - 1].createdAt!).toLocaleDateString("en-US", {
                    weekday: "short",
                    month: "short",
                    day: "numeric",
                  })
                : null;
              if (idx === 0 || msgDate !== prevDate) {
                dateSeparator = (
                  <div className="flex items-center gap-3 py-2">
                    <div className="flex-1 border-t border-secondary" />
                    <span className="text-[10px] font-medium uppercase tracking-wider text-muted">{msgDate}</span>
                    <div className="flex-1 border-t border-secondary" />
                  </div>
                );
              }
            }

            // Legacy "Meeting confirmed:" system messages — hidden.
            if (msg.role === "system" && /^Meeting confirmed:/i.test(msg.content)) {
              return null;
            }

            // Internal LLM-context system messages — never user-visible.
            // guest_calendar_snapshot is created by the guest-calendar OAuth
            // callback and is for the slots endpoint's bilateral compute, not
            // for display. Filter here so the raw [SYSTEM: ...] text never
            // appears in the chat bubble.
            if (msg.role === "system" && (msg.metadata as Record<string, unknown> | null)?.kind === "guest_calendar_snapshot") {
              return null;
            }

            // activity_location_lock system messages: emitted when the guest
            // locks an activity or location via lock_activity_location. The
            // Envoy's prose already acknowledges the lock ("Got it — Coupa Cafe
            // near Stanford it is!"), so the chip is redundant. Suppress in
            // all views; the DB row is retained for audit.
            if (msg.role === "system" && (msg.metadata as Record<string, unknown> | null)?.kind === "activity_location_lock") {
              return null;
            }

            // host_update system messages render as inline ✓ lines for both
            // host and guest — guests see the change (e.g. "✓ Format updated
            // to phone") via the isHostUpdateInline path below.

            // Stage 3 V4 — mode-aware meta-narration suppression.
            // In `offer` or `confirmed` mode, hide administrator bubbles
            // whose body is prose meta-commentary about an external_agent
            // turn (e.g. "This is from another AI agent — noted"). The
            // structural banner + primer (V1 + V2) carries that signal
            // without breaking the celebratory framing of offer-mode.
            //
            // In `negotiate` mode Envoy narrating context is allowed, so
            // this suppression is off.
            //
            // Narrowly scoped: only `administrator` role, only when the
            // content matches the conservative regex set in
            // external-agent-meta.ts. Transition narrations fired by the
            // mode-transition observer (N9 fold) route through a separate
            // state (`transitionReason`) and render outside this list.
            if (
              msg.role === "administrator" &&
              dealRoomMode !== "negotiate" &&
              isExternalAgentMetaNarration(msg.content)
            ) {
              if (typeof console !== "undefined" && console.debug) {
                console.debug(
                  "[deal-room V4] suppressed meta-narration bubble",
                  { id: msg.id, mode: dealRoomMode },
                );
              }
              return null;
            }

            // Host notes — only visible to host
            if (msg.role === "host_note") {
              if (!isHost) return null;
              return (
                <div key={msg.id}>
                  {dateSeparator}
                  <div className="flex justify-end">
                    <div className="max-w-[70%] rounded-lg px-3 py-1.5 text-xs bg-amber-50 border border-amber-200 dark:bg-amber-900/30 dark:border-amber-700/40 text-amber-800 dark:text-amber-300">
                      <span className="font-semibold uppercase tracking-wider text-[9px] text-amber-600 dark:text-amber-500 mr-1.5">Note</span>
                      {msg.content}
                    </div>
                  </div>
                </div>
              );
            }

            const parsed =
              msg.role === "administrator"
                ? parseConfirmationProposal(msg.content)
                : { text: msg.content, proposal: null, proposalWarning: undefined };
            const { proposal } = parsed;
            // Once the meeting is confirmed, Envoy's original proposal
            // message still contains call-to-action text like "Click confirm
            // to lock it in!" — strip those trailing CTA lines so the history
            // reads cleanly in past tense. The green "Meeting confirmed!" card
            // renders below the message and is the new call-to-nothing.
            const text = (proposal && confirmed)
              ? parsed.text
                  .replace(/\s*(?:just\s+)?click (?:the )?confirm(?:\s+button)?[^\n.!]*[.!]*/gi, "")
                  .replace(/\s*(?:lock it in|locked in)[!.]?/gi, "")
                  .replace(/\s*let me know if[^\n]*/gi, "")
                  .replace(/\n{3,}/g, "\n\n")
                  .trim()
              : parsed.text;

            // MESSAGE_ROLE_DISPATCH — see helper definition at top of file.
            // The helper returns null for roles that opt out of the bubble
            // render entirely (e.g. system + metadata.kind = host_update,
            // handled as an inline ✓ summary further down).
            const metadataKind =
              (msg.metadata as Record<string, unknown> | null | undefined)?.kind;
            const roleStyle =
              getRoleStyles(
                msg.role,
                typeof metadataKind === "string" ? metadataKind : undefined,
                { isGuest, isHost },
              ) ?? {
                bubble:
                  "bg-surface-secondary border border-DEFAULT text-primary rounded-bl-sm",
                labelColor: "text-emerald-400",
                rightAligned: false,
              };
            const rightAligned = roleStyle.rightAligned;
            const messageStyle = roleStyle.bubble;
            const isExternalAgent = msg.role === "external_agent";

            // Each Envoy is named after the human it represents. "Your Envoy"
            // only for the viewer's own agent; counterparties always see the
            // named form ("John's Envoy", "Danny's Envoy") so it's immediately
            // clear which side is speaking.
            const guestFirstForLabel = guestUser?.name
              ? guestUser.name.split(" ")[0]
              : inviteeName
                ? inviteeName.split(" ")[0]
                : null;

            // Host's-side Envoy: "Your Envoy" only when the viewer IS the host.
            // Guests (esp. bilateral, where the guest has their own Envoy too)
            // see it named after the host — "{host}'s Envoy" — so it's clear
            // which side is speaking. Reverts the 2026-04-18 blanket "Your
            // Envoy" rule, which confused guests whose own Envoy was also
            // labeled the same.
            const hostFirstForLabel = hostName ? hostName.split(" ")[0] : "";
            const administratorLabel = isHost
              ? "Your Envoy"
              : hostFirstForLabel
                ? `${hostFirstForLabel}'s Envoy`
                : "Host's Envoy";

            const guestEnvoyLabel = isGuest
              ? "Your Envoy"
              : guestFirstForLabel
                ? `${guestFirstForLabel}'s Envoy`
                : "Guest's Envoy";

            const senderLabel =
              msg.role === "host"
                ? hostName || "Host"
                : msg.role === "guest"
                  ? guestFirstForLabel || "Guest"
                  : msg.role === "administrator"
                    ? administratorLabel
                    : msg.role === "guest_envoy"
                      ? guestEnvoyLabel
                      : null;

            // labelColor comes from MESSAGE_ROLE_DISPATCH via roleStyle.
            const labelColor = roleStyle.labelColor;

            // Slice 9 — proxy attribution badge. Server writes
            // metadata.delegateSpeaker when Envoy detects a proxy
            // (ai_agent, human_assistant, or unknown). Render a small
            // "via {name}" footer below the bubble so the host can
            // tell at a glance that the message came through a proxy.
            //
            // Stage 3 V1 — for external_agent bubbles we upgrade the
            // footer copy to the proposal's explicit phrasing: "via
            // {name}'s AI agent" (or "via an AI agent" when name is
            // missing). Footer only, no inline prefix in the body.
            const delegateSpeaker = msg.metadata?.delegateSpeaker;
            let delegateBadge: React.ReactNode = null;
            if (isExternalAgent) {
              const name = delegateSpeaker?.name?.trim();
              const footerText = name
                ? `via ${name}'s AI agent`
                : "via an AI agent";
              delegateBadge = (
                <div
                  className={`text-[10px] mt-1 italic ${rightAligned ? "text-right text-white/60" : "text-muted"}`}
                  data-testid="delegate-speaker-badge"
                >
                  {footerText}
                </div>
              );
            } else if (delegateSpeaker) {
              delegateBadge = (
                <div
                  className={`text-[10px] mt-1 italic ${rightAligned ? "text-right text-white/60" : "text-muted"}`}
                  data-testid="delegate-speaker-badge"
                >
                  via {delegateSpeaker.name || (
                    delegateSpeaker.kind === "ai_agent"
                      ? "AI agent"
                      : delegateSpeaker.kind === "human_assistant"
                      ? "assistant"
                      : "proxy"
                  )}
                </div>
              );
            }

            // Stage 3 V2 — once-per-(session, identity) primer banner.
            // Shown ABOVE the first external_agent bubble for each agent
            // identity, unless the viewer already dismissed it (localStorage)
            // or dismissed in the current render cycle. Shared-channel
            // primers render for both sides; the dismiss is per-viewer.
            let primerBanner: React.ReactNode = null;
            if (isExternalAgent && sessionId) {
              const identity = agentIdentityFrom(
                msg.metadata as
                  | { delegateSpeaker?: { name?: string | null } | null | undefined }
                  | null
                  | undefined,
              );
              const isFirstForIdentity =
                firstExternalAgentIdxByIdentity.get(identity) === idx;
              if (
                isFirstForIdentity &&
                !dismissedPrimers.has(identity) &&
                !hasSeenPrimer(sessionId, identity)
              ) {
                // Counterpart the agent represents — prefer delegateSpeaker
                // name, fall back to invitee. From the host viewer the
                // delegate is the guest's agent; from the guest viewer it's
                // whoever the message is posted on behalf of.
                const counterpartName =
                  (delegateSpeaker?.name && delegateSpeaker.name.trim()) ||
                  (isHost ? inviteeName : hostName) ||
                  null;
                primerBanner = (
                  <div className="flex justify-start">
                    <div className="max-w-[85%] min-w-0">
                      <ExternalAgentPrimer
                        counterpartName={counterpartName}
                        onDismiss={() => {
                          markPrimerSeen(sessionId, identity);
                          setDismissedPrimers((prev) => {
                            const next = new Set(prev);
                            next.add(identity);
                            return next;
                          });
                        }}
                      />
                    </div>
                  </div>
                );
              }
            }

            // Group event participants use chat-only availability sharing — no slot picker.
            const showPickerAfter = idx === firstAdminIdx && !isGroupEvent;

            // Inline host_update system messages render as small grey inline text
            // (matches the dashboard ✓ summary style) instead of the emerald bubble.
            const msgKind = (msg.metadata as Record<string, unknown> | null | undefined)?.kind;
            const isHostUpdateInline =
              msg.role === "system" &&
              (msgKind === "host_update" || msgKind === "cancel_event");
            if (isHostUpdateInline) {
              return (
                <React.Fragment key={msg.id}>
                  {dateSeparator}
                  <div className="flex justify-center">
                    <div className="text-[11px] text-muted italic px-2 py-0.5">
                      ✓ {text}
                    </div>
                  </div>
                </React.Fragment>
              );
            }

            return (
              <React.Fragment key={msg.id}>
                {dateSeparator}
                {primerBanner}
                <div className={`flex min-w-0 items-end gap-1 ${rightAligned ? "justify-end" : "justify-start"}`}>
                  <div className={`max-w-[85%] min-w-0 rounded-2xl px-4 py-3 text-sm leading-relaxed ${messageStyle}`}>
                    {isExternalAgent
                      ? renderExternalAgentSender(msg.metadata ?? null, labelColor)
                      : senderLabel && (
                          <div
                            className={`text-[10px] font-bold uppercase tracking-wider mb-1 ${labelColor}`}
                          >
                            {senderLabel}
                          </div>
                        )}
                    <div className="whitespace-pre-wrap break-words">{text}</div>
                    {delegateBadge}
                  </div>
                  {msg.role === "administrator" && isHost && (
                    <ThumbsDownFeedback
                      sessionId={sessionId ?? null}
                      messageContent={text}
                    />
                  )}
                </div>

                {/* Per-message proposal/confirmed cards removed 2026-04-17.
                    The proposal + confirm form lives in a standalone block
                    below the messages list so there's exactly one card and
                    it's anchored near the composer, not buried mid-scroll. */}
                {showPickerAfter && renderPickerBubble(`picker-after-${msg.id}`)}
              </React.Fragment>
            );
          })
        )}

        {/* Propose-changes synthetic bubbles. Each click on "Propose changes"
            in the confirmed-event card pushes another (Envoy text + fresh
            picker) pair here. Client-only; never posted to the server. */}
        {Array.from({ length: proposeChangesCount }).map((_, i) => (
          <React.Fragment key={`propose-changes-${i}`}>
            <div className="flex min-w-0 justify-start">
              <div className="max-w-[85%] min-w-0 rounded-2xl px-4 py-3 text-sm leading-relaxed bg-surface-secondary border border-DEFAULT text-primary rounded-bl-sm">
                <div className="text-[10px] font-bold uppercase tracking-wider mb-1 text-emerald-400">
                  Envoy
                </div>
                <div>Let me help you make changes — here&apos;s the availability picker right now.</div>
              </div>
            </div>
            {renderPickerBubble(`picker-propose-${i}`)}
          </React.Fragment>
        ))}

        <div data-messages-end />

        {/* Stage 2 offer-mode card (proposal 2026-04-21_deal-room-widget-
            state-machine §4). Shown when `deriveMode(...)` resolves to
            `offer` — exclusive single-slot OR small same-local-day set.
            Replaces the chooser + bottom proposal card so the guest sees
            one focused confirm instead of a chooser + proposal pair. The
            card collapse itself IS the "we converged" celebration (§4.4).
            On confirm we reuse `handleConfirm` so the guest-name / email
            capture form (below) still lives in this component. On "pick a
            different time" we flip `guestRequestedMoreOptions=true`, which
            transitions the mode to `negotiate` and renders the existing
            chooser with the "No problem — here's the full week." narration. */}
        {!confirmed && !isHost && dealRoomMode === "offer" && availableSlotStarts.length > 0 && (() => {
          // Pick the offer slot: prefer the lone -2 exclusive if present,
          // otherwise the first slot in the small same-day set. We read
          // from the full slotsByDay to recover the `end` field the
          // OfferCard uses for duration display fallback.
          const allSlots = (() => {
            const out: Array<{ start: string; end: string }> = [];
            if (!slotsByDay) return out;
            for (const day of Object.values(slotsByDay)) {
              for (const s of day) out.push({ start: s.start, end: s.end });
            }
            return out;
          })();
          if (allSlots.length === 0) return null;
          const offerSlot = allSlots[0];
          const duration =
            slotDuration && slotDuration > 0
              ? slotDuration
              : Math.max(
                  15,
                  Math.round(
                    (new Date(offerSlot.end).getTime() -
                      new Date(offerSlot.start).getTime()) /
                      60000,
                  ),
                );
          const fmt = linkFormat || "video";
          const tz = slotTimezone || viewerTimezone || "UTC";
          return (
            <OfferCard
              slot={offerSlot}
              durationMin={duration}
              format={fmt}
              location={linkLocation}
              timezone={tz}
              isConfirming={isConfirming}
              onConfirm={() => {
                // Reuse the existing pendingProposal flow so the name/email
                // form lives in one place. If we already have name+email
                // (from prior capture or link pre-fill), submit straight
                // through; otherwise surface the form on the card below
                // that collects them, then confirm.
                const nameOk = formGuestName.trim().length > 0;
                const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
                  formGuestEmail.trim(),
                );
                setPendingProposal({
                  dateTime: offerSlot.start,
                  duration,
                  format: fmt,
                  location: linkLocation,
                });
                if (nameOk && emailOk) {
                  handleConfirm(
                    {
                      dateTime: offerSlot.start,
                      duration,
                      format: fmt,
                      location: linkLocation,
                    },
                    {
                      guestName: formGuestName.trim(),
                      guestEmail: formGuestEmail.trim(),
                      guestNote: [formGuestPhone.trim() ? `Phone: ${formGuestPhone.trim()}` : null, formGuestNote.trim() || null].filter(Boolean).join("\n") || undefined,
                    },
                  );
                } else {
                  // Expand the name/email form on the existing proposal
                  // card so the user can complete the capture and submit.
                  setConfirmFormExpanded(true);
                  requestAnimationFrame(() => {
                    requestAnimationFrame(() => {
                      setTimeout(() => {
                        messagesEndRef.current?.scrollIntoView({
                          behavior: "smooth",
                          block: "end",
                        });
                      }, 80);
                    });
                  });
                }
              }}
              onPickDifferent={() => {
                // Sticky escape-hatch: once flipped, the mode stays
                // `negotiate` for the rest of the session. The narration
                // above the chooser is keyed by `transitionReason`.
                setTransitionReason("user-pick");
                setGuestRequestedMoreOptions(true);
              }}
            />
          );
        })()}

        {/* Single proposal + confirm card (direct-confirm flow, 2026-04-17).
            Reads local pendingProposal first (set on chip click) then falls
            back to Envoy's most recent CONFIRMATION_PROPOSAL message. Shows
            only when there's something to confirm and the session isn't
            already agreed. Suppressed in `offer` mode since the OfferCard
            above carries the confirm primitive in that state. The card
            re-surfaces in `offer` mode ONLY when the form is already
            expanded (name/email capture in-flight after OfferCard click). */}
        {!confirmed && !isHost && latestProposal && (dealRoomMode !== "offer" || confirmFormExpanded) && (() => {
          const effective = latestProposal;
          const dt = new Date(effective.dateTime);
          const inPast = dt.getTime() <= Date.now();
          const nameOk = formGuestName.trim().length > 0;
          const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formGuestEmail.trim());
          const canSubmit = !inPast && nameOk && emailOk;
          const clickConfirmButton = () => {
            if (!canSubmit) return;
            handleConfirm(
              { dateTime: effective.dateTime, duration: effective.duration, format: effective.format, location: effective.location },
              { guestName: formGuestName.trim(), guestEmail: formGuestEmail.trim(), guestNote: [formGuestPhone.trim() ? `Phone: ${formGuestPhone.trim()}` : null, formGuestNote.trim() || null].filter(Boolean).join("\n") || undefined }
            );
          };
          const metaParts = [
            `\u{1F4C5} ${dt.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: slotTimezone })}`,
            `\u{1F550} ${dt.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZoneName: "short", timeZone: slotTimezone })} · ${formatDuration(effective.duration)}`,
            `${getMeetingEmoji(effective.format, null) || "\u{1F550}"} ${effective.format.charAt(0).toUpperCase() + effective.format.slice(1)}`,
            ...(effective.location ? [`\u{1F4CD} ${effective.location}`] : []),
          ];
          return (
            <div className="flex justify-start">
              {/* Pick-pulse: one-shot emerald box-shadow pulse that runs when
                  this card first mounts. The card mounts when pendingProposal
                  transitions null → set (i.e. right after the picker click),
                  so the animation fires exactly once per "pick this time"
                  click. Pairs with the F11 "Picked — confirm below ↓" picker
                  label and the auto-scroll in proposeFromSlot to make the
                  next-step destination unmistakable. We gate on
                  `pendingProposal` so the pulse only fires after a picker
                  click — NOT for the legacy CONFIRMATION_PROPOSAL render
                  path that mounts this same card from a non-picker source. */}
              <div className={`max-w-[85%] w-full bg-emerald-900/20 border border-emerald-700/50 rounded-xl px-3 pt-2.5 pb-3 space-y-2 ${pendingProposal ? "pick-pulse-once" : ""}`}>
                {/* Header: "Your Pick:" label + inline meeting meta */}
                <div className="flex items-baseline gap-1.5 flex-wrap">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-400 shrink-0">
                    {pendingProposal ? "Your Pick:" : "Proposed Meeting:"}
                  </span>
                  <span className="text-xs text-secondary">{metaParts.join("  ·  ")}</span>
                </div>
                {inPast && (
                  <p className="text-xs text-amber-400">This time is in the past. Pick another from the calendar.</p>
                )}
                <div className="pt-2 border-t border-emerald-700/30 space-y-1.5">
                    <div className="grid grid-cols-2 gap-1.5">
                      <div>
                        <label className="block text-[10px] font-semibold uppercase tracking-wider text-emerald-400 mb-1">Name</label>
                        <input
                          type="text"
                          value={formGuestName}
                          onChange={(e) => setFormGuestName(e.target.value)}
                          autoComplete="name"
                          className="w-full px-2.5 py-1.5 bg-surface border border-DEFAULT rounded-md text-sm text-primary placeholder:text-muted focus:outline-none focus:border-emerald-500"
                          placeholder="Jane Doe"
                        />
                      </div>
                      <div>
                        <label className="block text-[10px] font-semibold uppercase tracking-wider text-emerald-400 mb-1">Email</label>
                        <input
                          type="email"
                          value={formGuestEmail}
                          onChange={(e) => setFormGuestEmail(e.target.value)}
                          autoComplete="email"
                          className="w-full px-2.5 py-1.5 bg-surface border border-DEFAULT rounded-md text-sm text-primary placeholder:text-muted focus:outline-none focus:border-emerald-500"
                          placeholder="jane@example.com"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="block text-[10px] font-semibold uppercase tracking-wider text-emerald-400 mb-1">
                        Phone <span className="text-muted font-normal normal-case tracking-normal">(optional)</span>
                      </label>
                      <input
                        type="tel"
                        value={formGuestPhone}
                        onChange={(e) => setFormGuestPhone(e.target.value)}
                        autoComplete="tel"
                        className="w-full px-2.5 py-1.5 bg-surface border border-DEFAULT rounded-md text-sm text-primary placeholder:text-muted focus:outline-none focus:border-emerald-500"
                        placeholder="+1 (555) 000-0000"
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] font-semibold uppercase tracking-wider text-emerald-400 mb-1">
                        Anything else? <span className="text-muted font-normal normal-case tracking-normal">(optional)</span>
                      </label>
                      <textarea
                        value={formGuestNote}
                        onChange={(e) => setFormGuestNote(e.target.value)}
                        rows={2}
                        maxLength={500}
                        className="w-full px-2.5 py-1.5 bg-surface border border-DEFAULT rounded-md text-sm text-primary placeholder:text-muted focus:outline-none focus:border-emerald-500 resize-none"
                        placeholder="Agenda notes, anything the other person should know…"
                      />
                    </div>
                </div>
                <div className="flex items-center gap-3 mt-1">
                  <button
                    onClick={clickConfirmButton}
                    disabled={isConfirming || inPast || !canSubmit}
                    className="flex-1 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-sm font-semibold rounded-lg transition"
                  >
                    {isConfirming ? "Confirming..." : "Confirm"}
                  </button>
                  <button
                    onClick={() => {
                      if (pendingProposal) {
                        setPendingProposal(null);
                        setConfirmFormExpanded(false);
                      } else {
                        setInput("That’s close, but could we ");
                        document.querySelector<HTMLTextAreaElement>("textarea")?.focus();
                      }
                    }}
                    className="text-xs text-muted hover:text-secondary transition whitespace-nowrap"
                  >
                    {pendingProposal ? "Pick a different time" : "Suggest a change"}
                  </button>
                </div>
                {confirmError && (
                  <p className="text-xs text-red-400">{confirmError}</p>
                )}
                {emailWarning && (
                  <p className="text-xs text-amber-400">{emailWarning}</p>
                )}
              </div>
            </div>
          );
        })()}

        {/* Post-confirm signup upsell (client-only, not persisted) */}
        {confirmed && !isHost && !isGuest && !signupUpsellDismissed && (
          <div className="flex justify-start">
            <div className="max-w-[85%] bg-surface-secondary border border-DEFAULT text-primary rounded-bl-sm rounded-2xl px-4 py-3 space-y-3">
              <div>
                <div className="text-[10px] font-bold uppercase tracking-wider text-emerald-400 mb-1">Envoy</div>
                <div className="text-sm leading-relaxed">
                  Great news &mdash; we&rsquo;ve locked in a time! 🎉
                </div>
              </div>
              <div className="text-sm text-secondary">
                Want your own AI scheduling negotiator? Get instant meeting summaries, one-click rescheduling, and calendar sync — all automated for you.
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setShowSignupModal(true)}
                  className="flex-1 px-3 py-2 text-xs font-medium bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg transition text-center"
                >
                  Create free account
                </button>
              </div>
            </div>
          </div>
        )}

        {isSending && (
          <div className="flex justify-start">
            <div className="bg-surface-secondary border border-DEFAULT rounded-2xl rounded-bl-sm px-4 py-3">
              <div className="text-[10px] font-bold uppercase tracking-wider text-emerald-400 mb-1">Envoy</div>
              <div className="flex gap-1">
                <div className="w-2 h-2 rounded-full bg-muted animate-bounce" />
                <div className="w-2 h-2 rounded-full bg-muted animate-bounce [animation-delay:0.1s]" />
                <div className="w-2 h-2 rounded-full bg-muted animate-bounce [animation-delay:0.2s]" />
              </div>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <form onSubmit={handleSend} className="p-4 border-t border-secondary">
        <div className="flex gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSend(e);
              }
            }}
            placeholder={isHost ? `Message as ${hostName || "Host"}...` : "Type your message..."}
            rows={1}
            disabled={isLoading}
            name="message"
            autoComplete="off"
            autoCorrect="on"
            autoCapitalize="sentences"
            spellCheck
            inputMode="text"
            enterKeyHint="send"
            data-lpignore="true"
            data-1p-ignore="true"
            data-form-type="other"
            className="flex-1 min-w-0 resize-none bg-surface-secondary border border-DEFAULT rounded-xl px-4 py-3 text-base md:text-sm text-primary placeholder:text-muted focus:outline-none focus:border-indigo-500 transition disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={isSending || !input.trim() || isLoading}
            className="px-4 py-3 bg-accent hover:bg-accent-hover disabled:opacity-50 text-white rounded-xl text-sm font-medium transition"
          >
            Send
          </button>
        </div>
        <div className="mt-1.5 flex items-center justify-between gap-3">
          {isHost ? (
            <p className="text-[10px] text-muted">
              Prefix with <code className="text-muted">::</code> for private notes to Envoy
            </p>
          ) : (
            <span />
          )}
          <SendFeedbackLink
            mode={isHost ? "host-deal-room" : "guest-deal-room"}
            // B3: feedbackCode is the child NegotiationLink.code; falls back to
            // the URL's code (which IS the child code for non-bookable visits).
            linkCode={feedbackCode ?? code}
            sessionId={sessionId}
            className="text-[10px]"
          />
        </div>
      </form>
    </>
  );

  return (
    <div className="fixed inset-0 bg-surface text-primary flex flex-col overflow-hidden z-20">
      {/* Site header. Same component across host, logged-in guest, and
          anonymous — contents adapt to auth state inside DashboardHeader.
          Deal-room-specific affordances go in banners below, never in a
          bespoke header. */}
      <DashboardHeader
        signInCallbackUrl={`/meet/${slug}${code ? `/${code}` : ""}`}
      />
      {isGuest && guestUser?.name && (
        <span className="sr-only" data-testid="guest-name">
          {guestUser.name}
        </span>
      )}

      {/* Main area — chat + sidebar on desktop */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Chat column — event card + messages */}
        <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
          {/* 2026-05-10: skeleton loader during initial session load. Prevents
              the brief flash of the legacy event card that used to happen
              between first paint (no data → fallback) and data-resolved
              re-paint (new MeetingCard). Skip both branches while loading. */}
          {isLoading ? (
            /* Skeleton — silhouette-matched to the real MeetingCard so the
               swap on data-load is invisible. Mirrors:
               - MeetingCardConfirmedView outer bg + padding + max-width
               - MeetingCard article (rounded-[18px], border, shadow)
               - MeetingCardHero (gradient hero, icon circle, date/time lines)
               - MeetingCardInfoBlock (avatar pair, title bar, rows, tip)
               - MeetingCardActions (three text-link rows)
               - EnvoyDock resting state (avatar + nudge chip)
               2026-05-10 punch-list #12 */
            <div className="flex-1 min-h-0 overflow-y-auto bg-[#f6f3ec]">
              <div className="px-4 py-4 lg:px-8 lg:py-8">
                <div className="w-full max-w-[540px] mx-auto animate-pulse">
                  {/* MeetingCard article shell */}
                  <article
                    className="rounded-[18px] overflow-hidden bg-white"
                    style={{
                      border: "1px solid #e7e2d5",
                      boxShadow: "0 4px 24px rgba(24,24,27,.07), 0 1px 4px rgba(24,24,27,.04)",
                    }}
                  >
                    {/* ── Faux MeetingCardHero (confirmed-state gradient) ── */}
                    <div
                      className="px-[22px] pt-[22px] pb-5"
                      style={{ background: "linear-gradient(135deg, #059669 0%, #10b981 60%, #34d399 100%)" }}
                    >
                      {/* Icon circle + eyebrow + optional headline */}
                      <div className="flex items-center gap-[14px]">
                        <div className="w-[42px] h-[42px] rounded-full bg-white/30 flex-shrink-0" />
                        <div className="flex-1 space-y-1.5">
                          <div className="h-2.5 w-20 rounded bg-white/30" />
                          <div className="h-4 w-32 rounded bg-white/20" />
                        </div>
                      </div>
                      {/* When block */}
                      <div className="mt-[14px] pt-[14px]" style={{ borderTop: "1px solid rgba(255,255,255,.18)" }}>
                        <div className="h-5 w-48 rounded bg-white/25 mb-2" />
                        <div className="h-3 w-36 rounded bg-white/18" />
                      </div>
                    </div>

                    {/* ── Faux MeetingCardInfoBlock ── */}
                    <div className="px-[22px] pt-[18px] pb-3">
                      {/* Who row: overlapping avatar circles + name bar */}
                      <div className="flex items-center gap-[10px] mb-2">
                        <div className="flex items-center">
                          <div className="w-[26px] h-[26px] rounded-full bg-zinc-200 border-2 border-white" />
                          <div className="w-[26px] h-[26px] rounded-full bg-zinc-200 border-2 border-white -ml-[9px]" />
                        </div>
                        <div className="h-3 w-40 rounded bg-zinc-200" />
                      </div>
                      {/* Title bar */}
                      <div className="h-5 w-3/4 rounded bg-zinc-200 mb-3" />
                      {/* Channel line */}
                      <div className="flex items-center gap-[9px] pt-2">
                        <div className="w-5 h-4 rounded bg-zinc-100 flex-shrink-0" />
                        <div className="h-3.5 w-2/3 rounded bg-zinc-200" />
                      </div>
                      {/* Tip / agenda block */}
                      <div className="pl-3 border-l-2 border-zinc-200 mt-3">
                        <div className="h-3 w-full rounded bg-zinc-100 mb-1.5" />
                        <div className="h-3 w-4/5 rounded bg-zinc-100" />
                      </div>
                    </div>

                    {/* ── Faux MeetingCardActions (three text-link rows) ── */}
                    <div className="px-[22px] pb-4 pt-1 space-y-1">
                      {[80, 64, 72].map((w, i) => (
                        <div key={i} className="flex items-center gap-[9px] py-[7px]">
                          <div className="w-4 h-4 rounded bg-indigo-100 flex-shrink-0" />
                          <div className={`h-3.5 rounded bg-indigo-100`} style={{ width: `${w}px` }} />
                        </div>
                      ))}
                    </div>

                    {/* ── Faux footer chip ── */}
                    <div className="flex justify-end px-[18px] pb-3 pt-1">
                      <div className="h-3 w-32 rounded bg-zinc-100" />
                    </div>
                  </article>

                  {/* ── Faux EnvoyDock (resting state) ── */}
                  <div className="mt-3 px-3 py-3 rounded-2xl bg-white border border-[#e7e2d5] flex items-center gap-3">
                    <div className="w-[42px] h-[42px] rounded-full bg-indigo-100 flex-shrink-0" />
                    <div className="flex-1 space-y-1.5">
                      <div className="h-3 w-1/2 rounded bg-zinc-200" />
                      <div className="h-2.5 w-1/3 rounded bg-zinc-100" />
                    </div>
                    <div className="w-[30px] h-[30px] rounded-lg bg-indigo-50" />
                  </div>
                </div>
              </div>
            </div>
          ) : !meetingCardCrashed && !isGroupEvent && confirmed && meetingCardProps ? (
            /* PR2a/PR2c — confirmed non-group session (HOST + GUEST both
               render the new card per user 2026-05-10; isHost fallthrough
               removed). RescheduleOverlay passed as belowCardSlot so the
               picker sits BETWEEN card and dock — agent appears below picker. */
            <MeetingCardErrorBoundary onError={() => setMeetingCardCrashed(true)}>
              <MeetingCardConfirmedView
                sessionId={sessionId}
                linkId={linkDbId}
                cardProps={meetingCardProps}
                threadMessages={confirmedThreadMessages}
                threadExpanded={confirmedThreadExpanded}
                onExpandThread={() => setConfirmedThreadExpanded(true)}
                onCollapseThread={() => setConfirmedThreadExpanded(false)}
                // Bug 3 fix (2026-05-11): EnvoyDock composer is now a real
                // <textarea> wired to onSendMessage. Call handleSend with a
                // textOverride so the full streaming pipeline runs without
                // touching the legacy input state.
                onSendMessage={(text) => {
                  handleSend({ preventDefault: () => {} } as React.FormEvent, text);
                }}
                // ── Real action handlers (2026-05-10 PR2c-lite) ──────────
                onOpenCancelModal={() => setShowCancelModal(true)}
                onAddToCalendar={() => {
                  if (googleCalUrl) {
                    window.open(googleCalUrl, "_blank", "noopener");
                  } else {
                    downloadIcs();
                  }
                }}
                onRequestReschedule={() => {
                  setReschedulingFromConfirmed(true);
                  setMessages((prev) => [
                    ...prev,
                    {
                      id: `reschedule-prompt-${Date.now()}`,
                      role: "administrator",
                      content:
                        "Find an available slot below, or tell me how I can help you find another time.",
                      createdAt: new Date().toISOString(),
                      metadata: null,
                    },
                  ]);
                  setConfirmedThreadExpanded(true);
                }}
                onRequestEdit={() => {
                  setConfirmedThreadExpanded(true);
                  setInput("I'd like to change the meeting — ");
                }}
                dealRoomUrl={typeof window !== "undefined"
                  ? `${window.location.origin}/meet/${slug}${code ? `/${code}` : ""}`
                  : undefined}
                showDashboardLink={isHost || isGuest}
                feedbackLinkCode={feedbackCode ?? code}
                belowCardSlot={
                  reschedulingFromConfirmed ? (
                    <RescheduleOverlay
                      onCancel={() => {
                        setReschedulingFromConfirmed(false);
                        setMessages((prev) => [
                          ...prev,
                          {
                            id: `reschedule-kept-${Date.now()}`,
                            role: "administrator",
                            content:
                              "Kept your existing time. Let me know if anything else needs to change.",
                            createdAt: new Date().toISOString(),
                            metadata: null,
                          },
                        ]);
                      }}
                      pickerSlot={reschedulePickerNode}
                    />
                  ) : null
                }
              />
            </MeetingCardErrorBoundary>
          ) : !meetingCardCrashed && !isGroupEvent && !confirmed && meetingCardProps ? (
            /* PR2c — proposal/matched/skipped/confirming non-group session
               (HOST + GUEST both — isHost fallthrough removed 2026-05-10) */
            <MeetingCardErrorBoundary onError={() => setMeetingCardCrashed(true)}>
              <MeetingCardProposalView
                cardProps={meetingCardProps}
                threadMessages={confirmedThreadMessages}
                threadExpanded={confirmedThreadExpanded}
                onExpandThread={() => setConfirmedThreadExpanded(true)}
                onCollapseThread={() => setConfirmedThreadExpanded(false)}
                // Bug 3 fix (2026-05-11): same as confirmed path — route
                // through handleSend with textOverride.
                onSendMessage={(text) => {
                  handleSend({ preventDefault: () => {} } as React.FormEvent, text);
                }}
                // Guest-picks affordance: expand dock + prefill the chat input
                // so the guest can reply with their preferred venue or format.
                // Same pattern as onRequestEdit in MeetingCardConfirmedView.
                onFocusChat={(prefill) => {
                  setInput(prefill);
                  setConfirmedThreadExpanded(true);
                }}
                // 2026-05-10: stripped-down calendar (no chat-bubble wrapper)
                // so it fits the new card surface. Confirm form rendered as
                // a sibling slot — without it, picking a slot would do
                // nothing because the legacy confirm card lives in a
                // different render tree we never reach.
                pickerSlot={newCardPickerNode}
                confirmSlot={newCardConfirmNode}
                showDashboardLink={isHost || isGuest}
              />
            </MeetingCardErrorBoundary>
          ) : (
          /* EXISTING PATH (unchanged): old event card + chat column */
          /* Desktop centered wrapper for left-side content */
          <div className="flex-1 min-h-0 overflow-hidden flex flex-col md:max-w-[640px] lg:max-w-[760px] xl:max-w-[880px] md:mx-auto md:w-full">
            {/* Error-boundary fallback banner — shown when MeetingCardErrorBoundary
                tripped and we fell back to legacy. Small, amber, dismissible.
                Grep "BOUNDARY_TRIP" in the browser console for the full error.
                No localStorage — dismiss resets on refresh. 2026-05-10 punch-list #13. */}
            {meetingCardCrashed && !meetingCardCrashedBannerDismissed && (
              <div className="flex items-center justify-between gap-2 px-3 py-1.5 bg-amber-50 border-b border-amber-200 text-[11.5px] text-amber-800 flex-shrink-0">
                <span>
                  Heads up: the new event view hit an error and we fell back to the classic view.{" "}
                  <button
                    className="underline font-medium"
                    onClick={() => window.location.reload()}
                  >
                    Refresh to try again.
                  </button>
                </span>
                <button
                  aria-label="Dismiss"
                  className="ml-2 text-amber-600 hover:text-amber-900 font-medium leading-none flex-shrink-0"
                  onClick={() => setMeetingCardCrashedBannerDismissed(true)}
                >
                  ×
                </button>
              </div>
            )}
            {/* Event card — sticky inside chat column */}
            {eventCard}

          {/* TZ recovery banner — appears when someone raced ahead of this
              human guest and the session's primary TZ differs from their
              browser TZ. Silent when they match or the banner was dismissed.
              Hidden once the meeting is confirmed.
              Disabled 2026-04-18 per John — too noisy on guest load. Widget
              auto-detects browser TZ already; keep dormant until we revisit. */}
          {(false as boolean) && (() => {
            if (confirmed) return null;
            if (tzBannerDismissed) return null;
            if (!sessionId || !sessionTimezone) return null;
            if (typeof window === "undefined") return null;
            let browserTz = "";
            try {
              browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
            } catch {
              return null;
            }
            if (!browserTz || browserTz === sessionTimezone) return null;

            const prettyTz = (tz: string) =>
              tz.split("/").pop()?.replace(/_/g, " ") ?? tz;

            const dismiss = () => {
              setTzBannerDismissed(true);
              try {
                window.localStorage.setItem(`tz-banner-dismissed:${sessionId}`, "1");
              } catch {
                /* ignore — state already dismissed */
              }
            };

            const switchTz = async () => {
              setIsSwitchingTz(true);
              try {
                const res = await fetch("/api/negotiate/session/timezone", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ sessionId, timezone: browserTz }),
                });
                if (res.ok) {
                  const body = await res.json();
                  if (typeof body?.sessionTimezone === "string") {
                    setSessionTimezone(body.sessionTimezone);
                    setSlotTimezone(body.sessionTimezone);
                  }
                  // Re-fetch slots so bilateral chips render with the new TZ
                  // (ISO datetimes are TZ-agnostic; labels flip on re-render).
                  fetch(`/api/negotiate/slots?sessionId=${sessionId}${viewerTimezone ? `&tz=${encodeURIComponent(viewerTimezone)}` : ""}`)
                    .then((r) => (r.ok ? r.json() : null))
                    .then((data) => {
                      if (data?.slotsByDay) setSlotsByDay(data.slotsByDay);
                      if (data?.bilateralByDay && typeof data.bilateralByDay === "object") {
                        setBilateralByDay(data.bilateralByDay as Record<string, TimeChipData[]>);
                      }
                      if (data?.bilateralPayload) {
                        setBilateralPayload(
                          data.bilateralPayload as import("@/lib/bilateral-availability").BilateralPayload,
                        );
                      }
                    })
                    .catch(() => {});
                  dismiss();
                }
              } catch {
                /* soft fail — leave banner visible so user can retry */
              } finally {
                setIsSwitchingTz(false);
              }
            };

            return (
              <div
                className="border-b border-amber-200 bg-amber-50 dark:border-amber-800/40 dark:bg-amber-900/10 px-4 py-2.5 flex items-center gap-3 text-sm flex-shrink-0"
                data-testid="tz-recovery-banner"
              >
                <span role="img" aria-label="clock">🕐</span>
                <span className="flex-1 text-amber-900 dark:text-amber-100/90">
                  Looks like you&apos;re in <strong>{prettyTz(browserTz)}</strong>.
                  This thread is currently in <strong>{prettyTz(sessionTimezone)}</strong>.
                </span>
                <button
                  type="button"
                  onClick={switchTz}
                  disabled={isSwitchingTz}
                  className="px-3 py-1 rounded-md text-xs font-medium bg-amber-500/80 hover:bg-amber-500 text-amber-950 transition disabled:opacity-50"
                >
                  {isSwitchingTz ? "Switching…" : `Switch to ${prettyTz(browserTz)}`}
                </button>
                <button
                  type="button"
                  onClick={dismiss}
                  className="px-3 py-1 rounded-md text-xs font-medium text-amber-800 hover:text-amber-900 hover:bg-amber-100 dark:text-amber-200 dark:hover:text-amber-100 dark:hover:bg-amber-900/20 transition"
                  aria-label="Keep current timezone"
                >
                  Keep {prettyTz(sessionTimezone)}
                </button>
              </div>
            );
          })()}

          {/* Mobile calendar-connect banner. The calendar picker itself is
              rendered inline inside the first Envoy bubble (see
              renderPickerBubble) — this banner only surfaces the
              "Auto-match calendars" CTA for anonymous guests. */}
          {(() => {
            if (isHost || isGuest || confirmed || !sessionId) return null;
            if (bilateralByDay && Object.keys(bilateralByDay).length > 0) return null;
            if (!slotsByDay || Object.keys(slotsByDay).length === 0) return null;
            if (calendarDenied) {
              return (
                <div className="md:hidden border-b border-secondary flex-shrink-0 px-4 py-2 text-[11px] text-amber-800 bg-amber-50 dark:text-amber-200 dark:bg-amber-500/10 leading-snug">
                  We didn&apos;t get permission to read your calendar — that&apos;s
                  okay, pick a time below.
                </div>
              );
            }

            return (
              <DealRoomConnectCtas
                variant="mobile-banner"
                sessionId={sessionId}
                slug={slug}
                code={code}
              />
            );
          })()}
            {showGuestChat ? chatContent : (
              !confirmed && !isHost && (
                <div className="flex flex-col items-center justify-center py-6 px-4">
                  <button
                    type="button"
                    onClick={() => setGuestChatOpen(true)}
                    className="text-sm text-muted hover:text-primary transition underline underline-offset-2"
                  >
                    Chat with Envoy
                  </button>
                </div>
              )
            )}
          </div>
          )} {/* end PR2a existing-path ternary */}
        </div>

      </div>

      {/* Details modal */}
      {detailsModal}
      {/* Cancel modal */}
      {cancelModal}
      {/* Signup intro modal — opens from the post-confirm upsell's CTA.
          Plain-text walkthrough so guests know what "create free account"
          actually does before being bounced to Google. */}
      {showSignupModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
          onClick={() => setShowSignupModal(false)}
        >
          <div
            className="relative max-w-md w-full bg-surface border border-DEFAULT rounded-2xl p-6 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => setShowSignupModal(false)}
              aria-label="Close"
              className="absolute top-3 right-3 text-muted hover:text-primary transition"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
            <div className="text-[10px] font-bold uppercase tracking-wider text-indigo-400">
              Your own AI scheduler
            </div>
            <h2 className="text-xl font-semibold text-primary leading-tight">
              Let Envoy run point on your calendar, too.
            </h2>
            <ol className="space-y-2.5 text-sm text-secondary">
              <li className="flex gap-3">
                <span className="flex-shrink-0 w-6 h-6 rounded-full bg-indigo-500/15 text-indigo-400 text-xs font-semibold flex items-center justify-center">1</span>
                <span>Sign in with Google — we never see your password.</span>
              </li>
              <li className="flex gap-3">
                <span className="flex-shrink-0 w-6 h-6 rounded-full bg-indigo-500/15 text-indigo-400 text-xs font-semibold flex items-center justify-center">2</span>
                <span>Connect your calendar so Envoy knows when you&rsquo;re really free.</span>
              </li>
              <li className="flex gap-3">
                <span className="flex-shrink-0 w-6 h-6 rounded-full bg-indigo-500/15 text-indigo-400 text-xs font-semibold flex items-center justify-center">3</span>
                <span>Share your own link &mdash; Envoy handles the back-and-forth.</span>
              </li>
            </ol>
            <button
              type="button"
              onClick={signupUpsellSignIn.trigger}
              className="block w-full text-center px-4 py-3 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold rounded-lg transition"
            >
              Connect with Google to begin
            </button>
            <button
              type="button"
              onClick={() => {
                setSignupUpsellDismissed(true);
                setShowSignupModal(false);
              }}
              className="block w-full text-center text-xs text-muted hover:text-secondary transition"
            >
              Not now
            </button>
          </div>
        </div>
      )}
      {signupUpsellSignIn.modal}
    </div>
  );
}
