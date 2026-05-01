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
  const [isConfirming, setIsConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [emailWarning, setEmailWarning] = useState<string | null>(null);
  const [calendarConnected, setCalendarConnected] = useState(false);
  const [calendarDenied, setCalendarDenied] = useState(false);
  const [showDetailsModal, setShowDetailsModal] = useState(false);
  const [showCancelModal, setShowCancelModal] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [gcalStatus, setGcalStatus] = useState<{
    eventExists: boolean;
    guestOnInvite: boolean;
    guestResponseStatus: "accepted" | "declined" | "tentative" | "needsAction" | null;
  } | null>(null);
  const [sessionStatus, setSessionStatus] = useState<string>("active");
  const [sessionStatusLabel, setSessionStatusLabel] = useState<string>("");
  const [statusAnimating, setStatusAnimating] = useState(false);
  const [isGroupEvent, setIsGroupEvent] = useState(false);
  const [participants, setParticipants] = useState<Array<{ name: string; status: string }>>([]);
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
  // Sticky "we celebrated this session" — once justMatched fires, this stays
  // true for the remainder of the page lifecycle so the celebration banner
  // (which has no close affordance, by design) lingers as the post-match
  // callout instead of vanishing on the next render tick. Refresh resets.
  const [hasCelebrated, setHasCelebrated] = useState(false);

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
  const [formWantsReminder, setFormWantsReminder] = useState(true);
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
  //
  // Celebration-banner gate (2026-04-29): the banner is for the moment a
  // guest just returned from OAuth — NOT every revisit where bilateral
  // matches. Read the sessionStorage flag set by DealRoomConnectCtas's
  // click handler and consume it once. Without the flag, we still fire
  // MatchPulse (the subtle ✨ animation) but skip the sticky banner.
  useEffect(() => {
    const hasMatchNow = !!bilateralByDay && Object.keys(bilateralByDay).length > 0;
    if (hasMatchNow && !prevHadMatchRef.current) {
      let justConnected = false;
      try {
        if (typeof window !== "undefined" && window.sessionStorage.getItem("aenv-cal-just-connected") === "1") {
          window.sessionStorage.removeItem("aenv-cal-just-connected");
          justConnected = true;
        }
      } catch {
        // ignore — Safari private mode etc.
      }
      setJustMatched(true);
      if (justConnected) setHasCelebrated(true);
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
    if (!sessionId || confirmed) return;

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
      } catch {
        // Swallow transient network errors — next tick will retry.
      }
    }

    // Only poll while visible + not streaming + not confirmed. Terminal
    // confirmed state stops polling entirely (outer guard above).
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
  }, [sessionId, confirmed, isStreaming]);

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
    // Collapse the form initially — one click to expand into name/email.
    setConfirmFormExpanded(false);
    setConfirmError(null);
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
  }, opts?: { guestName?: string; guestEmail?: string; wantsReminder?: boolean; guestNote?: string }) {
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
          wantsReminder: opts?.wantsReminder ?? formWantsReminder,
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
        setLinkFormat(data.link?.format || "");
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

        // Primary link → redirect to persistent contextual URL
        if (!code && data.code) {
          router.replace(`/meet/${slug}/${data.code}`);
        }

        // Already confirmed — load messages AND set confirmed state
        if (data.confirmed) {
          setConfirmData({
            dateTime: data.agreedTime,
            duration: data.duration || 30,
            format: data.agreedFormat || "phone",
            meetLink: data.meetLink,
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
        } else {
          // Use a temp id (numeric ms-since-epoch) so the first poll's
          // content-match pass in mergePollResult swaps this local row in
          // place with the server-persisted greeting. A non-numeric id
          // like "greeting" fails isTempId, falls through to id-dedup,
          // and the server's CUID row appends — rendering the greeting
          // twice (one DB row, two bubbles).
          setMessages([
            {
              id: Date.now().toString(),
              role: "administrator",
              content: data.greeting,
              createdAt: new Date().toISOString(),
            },
          ]);
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

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim() || isSending || !sessionId) return;

    const text = input.trim();

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

  const statusConfigs: Record<string, { label: string; color: string; border: string; dot: string }> = {
    active: { label: "Scheduling", color: "text-zinc-400", border: "border-zinc-700", dot: "bg-zinc-500" },
    proposed: { label: "Proposed", color: "text-amber-400", border: "border-amber-500/25", dot: "bg-amber-400" },
    agreed: { label: "Confirmed", color: "text-emerald-400", border: "border-emerald-500/25", dot: "bg-emerald-400" },
    cancelled: { label: "Cancelled", color: "text-red-400", border: "border-red-500/25", dot: "bg-red-400" },
    escalated: { label: "Escalated", color: "text-orange-400", border: "border-orange-500/25", dot: "bg-orange-400" },
    expired: { label: "Expired", color: "text-zinc-500", border: "border-zinc-700", dot: "bg-zinc-600" },
  };

  const statusConfig = statusConfigs[eventStatus] || statusConfigs.active;

  // Event details come from confirmData (confirmed) or latestProposal (proposed) or just title (scheduling)
  const eventDateTime = confirmed && confirmData
    ? confirmData.dateTime as string
    : latestProposal?.dateTime ?? null;
  const eventFormat = confirmed && confirmData
    ? String(confirmData.format)
    : latestProposal?.format ?? linkFormat ?? null;
  const eventDuration = confirmed && confirmData
    ? String(confirmData.duration)
    : latestProposal ? String(latestProposal.duration) : String(slotDuration || 30);
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


  const eventCard = (
    <div className={`z-10 px-4 sm:px-5 pt-3 sm:pt-4 pb-2 bg-surface/95 backdrop-blur-sm flex-shrink-0 transition-all duration-500`}>
      <div className={`max-w-3xl rounded-xl border ${statusConfig.border} bg-black/[0.02] dark:bg-white/[0.03] px-4 py-3 transition-all duration-700 ${
        justConfirmedGlow
          ? "ring-2 ring-emerald-400/60 bg-emerald-500/10 shadow-[0_0_24px_rgba(16,185,129,0.35)] scale-[1.01]"
          : statusAnimating
            ? "ring-1 " + (eventStatus === "confirmed" ? "ring-emerald-500/40 bg-emerald-500/5" : eventStatus === "cancelled" ? "ring-red-500/40 bg-red-500/5" : "ring-amber-500/40 bg-amber-500/5")
            : ""
      }`}>
        {/* Row 1: Title + status. The activity emoji prefixes the title per
            SPEC §3.6 (event card). Host-set `activityIcon` wins; falls
            back to format-derived canonical emoji; final fallback is 🕐
            when no activity / format signal is present. */}
        <div className="flex items-center gap-2.5 mb-1.5">
          <div className={`w-2.5 h-2.5 rounded-full ${statusConfig.dot} flex-shrink-0 transition-colors duration-500 ${statusAnimating ? "scale-125" : ""}`} style={statusAnimating ? { animation: "pulse 1s ease-in-out" } : {}} />
          {(() => {
            const titleEmoji = linkActivityIcon || getMeetingEmoji(eventFormat || linkFormat, eventLocation || linkLocation, linkActivity) || "🕐";
            return <span className="flex-shrink-0 select-none text-sm" aria-hidden="true">{titleEmoji}</span>;
          })()}
          <span className="text-sm font-semibold text-primary truncate">{getEventTitle()}</span>
          {isVip && <span className="text-[10px] text-amber-500/60 dark:text-amber-400/50 flex-shrink-0 select-none" title="Priority meeting">★</span>}
          <span className={`text-[10px] font-semibold uppercase tracking-wide ${statusConfig.color} flex-shrink-0`}>{statusConfig.label}</span>
          {sessionStatusLabel &&
            sessionStatusLabel.trim().toLowerCase() !== statusConfig.label.toLowerCase() && (
              <span className="text-[10px] text-muted ml-2">{sessionStatusLabel}</span>
            )}
          <EditedPill
            lastMaterialEditAt={lastMaterialEditAt}
            lastEditedFields={lastEditedFields}
            className="ml-1"
          />
        </div>

        {/* Participants row (group events) */}
        {isGroupEvent && participants.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 ml-5 mb-1">
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

        {/* Row 2: Details */}
        <div className="flex flex-wrap gap-x-4 gap-y-0.5 ml-5 text-xs text-secondary">
          {eventFormat && (() => {
            const formatEmoji = getMeetingEmoji(eventFormat, null);
            const formatText = eventFormat === "phone" ? "Phone" : eventFormat === "video" ? "Video" : eventFormat === "in-person" ? "In person" : eventFormat;
            // ✏️ pencil suffix on deferred fields — proposal 2026-04-29
            // feedback iter 2: replaced the "(proposed)" text suffix with
            // a pencil icon. Map pin (📍) is reserved for actual location;
            // pencil signals "editable / guest can suggest".
            const formatSuffix = linkGuestPicksFormat ? " ✏️" : "";
            const durationSuffix = linkGuestPicksDuration ? " ✏️" : "";
            return <span>{formatEmoji}{formatEmoji ? " " : ""}{formatText}{formatSuffix} &middot; {eventDuration} min{durationSuffix}</span>;
          })()}
          {eventDateTime && (() => {
            const dt = new Date(eventDateTime);
            const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
            const hostTz = slotTimezone;
            const showDual = hostTz && hostTz !== localTz;
            const datePart = dt.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
            const localTime = dt.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZoneName: "short" });
            const hostTime = showDual ? dt.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZoneName: "short", timeZone: hostTz }) : null;
            return <span>{datePart} {localTime}{hostTime ? ` (${hostTime})` : ""}</span>;
          })()}
          {!eventDateTime && !eventFormat && (() => {
            // Pre-confirmation fallback: render the host's proposal fragments
            // from link.parameters so the guest sees what the meeting is ABOUT
            // before a time is locked. Mirrors the greeting's prose-first
            // approach — show what's set, drop what isn't.
            const parts: string[] = [];
            if (linkActivity) {
              parts.push(linkActivityIcon ? `${linkActivityIcon} ${linkActivity}` : linkActivity);
            }
            if (slotDuration) parts.push(formatDuration(slotDuration) + (linkGuestPicksDuration ? " ✏️" : ""));
            if (linkTimingLabel) parts.push(linkTimingLabel + (linkGuestPicksDate ? " ✏️" : ""));
            if (linkLocation) {
              // Locked location → 📍 prefix. If also deferred (rare —
              // host gave a hint but guest can change), append ✏️.
              parts.push(`📍 ${linkLocation}` + (linkGuestPicksLocation ? " ✏️" : ""));
            } else if (linkGuestPicksLocation) {
              // No location set + deferred → guest will pick. Use ✏️
              // alone (NOT 📍) to signal "editable" rather than "we have
              // a location". Matches John's 2026-04-29 directive: "icon
              // should be a pencil. the map pin is for location."
              parts.push("✏️ Pick a location");
            }
            if (parts.length === 0) return <span>Meeting details pending</span>;
            return <span>{parts.join(" · ")}</span>;
          })()}
          {confirmed && (formGuestName || formGuestEmail) && (
            <span className="text-muted">
              {[formGuestName, formGuestEmail].filter(Boolean).join(" · ")}
            </span>
          )}
          {eventMeetLink && (
            <a href={eventMeetLink} className="text-indigo-400 hover:text-indigo-300 truncate max-w-[200px]" target="_blank" rel="noopener noreferrer">
              {eventMeetLink.replace("https://", "").split("/").slice(0, 2).join("/")}
            </a>
          )}
          {eventLocation && (
            <span className="truncate max-w-[200px]" title={eventLocation}>
              {getMeetingEmoji(null, eventLocation)} {eventLocation}
            </span>
          )}
        </div>

        {/* Deferral status line — "🤔 Gathering John's suggestions on the
            location". Same neutral phrasing on host + guest views. Suppressed
            post-confirm; deferrals stop mattering once a slot is locked.
            Date deferral intentionally skipped (calendar widget IS the day
            picker). Reuses formatDeferralFieldsList for canonical phrasing. */}
        {!confirmed && (() => {
          const deferred: DeferralFieldNoun[] = [];
          if (linkGuestPicksLocation) deferred.push("location");
          if (linkGuestPicksDuration) deferred.push("length");
          if (linkGuestPicksFormat) deferred.push("format");
          const list = formatDeferralFieldsList(deferred);
          if (!list) return null;
          const firstName = (inviteeName || "").split(/\s+/)[0] || "the guest";
          return (
            <div className="ml-5 mt-1 text-xs italic text-muted">
              🤔 Gathering {firstName}&apos;s suggestions on {list}
            </div>
          );
        })()}

        {/* T3c: host-only soft upsell when the confirm pipeline degraded
            to .ics-only (no calendar.events write scope). Degrade-not-block:
            the meeting is confirmed, we just couldn't auto-add it to GCal.
            The .ics download in the actions row below remains the floor. */}
        {isHost && confirmed && calendarWriteUnavailable && (
          <div className="ml-5 mt-2.5 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2">
            <span className="text-amber-400 text-sm leading-5">⚠</span>
            <div className="flex-1 text-xs text-amber-200/90 leading-5">
              <span className="font-medium">Not on your Google Calendar.</span>{" "}
              Grant calendar write access to auto-add future meetings — or use the .ics download below.
            </div>
            <button
              onClick={writeScopeReconnect.trigger}
              className="text-xs font-medium text-amber-300 hover:text-amber-200 transition whitespace-nowrap"
            >
              Grant access
            </button>
            {writeScopeReconnect.modal}
          </div>
        )}

        {/* Row 3: Actions (confirmed / cancelled only) */}
        {(confirmed || eventStatus === "cancelled") && (
          <div className="flex items-center gap-3 ml-5 mt-2.5">
            {eventStatus !== "cancelled" && (
              <>
                {/* Google Calendar */}
                {googleCalUrl && (
                  <a href={googleCalUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-surface-secondary/80 border border-DEFAULT hover:border-zinc-600 transition text-xs text-primary">
                    <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 flex-shrink-0">
                      <path d="M18.316 5.684H24v12.632h-5.684V5.684z" fill="#1967D2" />
                      <path d="M5.684 18.316V5.684L0 5.684v12.632l5.684 0z" fill="#188038" />
                      <path d="M18.316 24V18.316H5.684V24h12.632z" fill="#1967D2" />
                      <path d="M18.316 5.684V0H5.684v5.684h12.632z" fill="#EA4335" />
                      <path d="M18.316 18.316H5.684V5.684h12.632v12.632z" fill="#fff" />
                      <path d="M9.2 15.7V9.1h1.5v2.4h2.6V9.1h1.5v6.6h-1.5v-2.8h-2.6v2.8H9.2z" fill="#1967D2" />
                    </svg>
                    Google
                  </a>
                )}
                {/* ICS download */}
                <button onClick={downloadIcs} className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-surface-secondary/80 border border-DEFAULT hover:border-zinc-600 transition text-xs text-primary">
                  <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5" />
                  </svg>
                  .ics
                </button>
              </>
            )}
            {/* Find a new time — injects synthetic Envoy bubbles so the
                guest can re-pick without typing. Each click adds another
                pair (text + picker) at the bottom of the thread.
                Renamed from "Propose changes" per 2026-04-20 calendar-popup
                proposal: both host and guest have the same goal (find a
                new time) — naming it that way aligns wording across the
                two surfaces (deal room + popup). */}
            <button
              onClick={() => {
                setProposeChangesCount((n) => n + 1);
                // Scroll to bottom shortly after render so the new picker is visible.
                setTimeout(() => {
                  document
                    .querySelector<HTMLDivElement>("[data-messages-end]")
                    ?.scrollIntoView({ behavior: "smooth" });
                }, 50);
              }}
              className="text-xs text-indigo-400 hover:text-indigo-300 transition"
            >
              Find a new time
            </button>
            {/* More details */}
            {hasExtraDetails && (
              <button
                onClick={() => setShowDetailsModal(true)}
                className="text-xs text-muted hover:text-secondary transition"
              >
                Details
              </button>
            )}
          </div>
        )}


        {/* Cancelled-state banner — per 2026-04-20 proposal §Q4, cancelled
            sessions stay visible in the feed (NOT auto-archived) with a
            banner that offers a fresh-start path for whoever's looking:
            • host → dashboard to schedule something new
            • guest → host's primary /meet/<slug> to reach out again
            Keeps the prior messages accessible (scroll up) while making
            the "this meeting is over; here's what to do next" moment
            unambiguous. Host can still archive manually from the sidebar. */}
        {eventStatus === "cancelled" && (
          <div className="ml-5 mt-2.5 px-3 py-2.5 rounded-lg border border-red-500/20 bg-red-500/5">
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

        {/* Host management row — Add participant (non-confirmed) + GCal status (confirmed) + Archive/Cancel */}
        {isHost && eventStatus !== "cancelled" && (
          <div className="ml-5 mt-2.5 flex items-center gap-3 flex-wrap">
            {/* Group-link active indicator — non-confirmed only */}
            {!confirmed && isGroupEvent && (
              <span className="text-[11px] text-muted">
                Group link active — share link to add people
              </span>
            )}
            {/* Google Calendar status badge — only when confirmed */}
            {confirmed && gcalStatus && gcalStatus.eventExists && (
              <span className="flex items-center gap-1.5 text-[11px] text-muted">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 flex-shrink-0" />
                On Google Calendar
                {gcalStatus.guestOnInvite && gcalStatus.guestResponseStatus && (
                  <>
                    <span className="text-zinc-600 dark:text-zinc-700 mx-0.5">·</span>
                    <span className={
                      gcalStatus.guestResponseStatus === "accepted" ? "text-emerald-500" :
                      gcalStatus.guestResponseStatus === "declined" ? "text-red-400" :
                      "text-zinc-400"
                    }>
                      Guest {gcalStatus.guestResponseStatus === "accepted" ? "accepted" :
                             gcalStatus.guestResponseStatus === "declined" ? "declined" :
                             gcalStatus.guestResponseStatus === "tentative" ? "maybe" : "awaiting"}
                    </span>
                  </>
                )}
                {gcalStatus.guestOnInvite === false && (
                  <>
                    <span className="text-zinc-600 dark:text-zinc-700 mx-0.5">·</span>
                    <span className="text-amber-400">Guest not on invite</span>
                  </>
                )}
              </span>
            )}
            {confirmed && gcalStatus && !gcalStatus.eventExists && (
              <span className="flex items-center gap-1.5 text-[11px] text-zinc-500">
                <span className="w-1.5 h-1.5 rounded-full bg-zinc-600 flex-shrink-0" />
                Not found on Google Calendar
              </span>
            )}

            {/* Spacer to push buttons to the right when badge is present */}
            <span className="flex-1" />

            {/* Cancel button — confirmed sessions only */}
            {confirmed && (
              <button
                onClick={() => setShowCancelModal(true)}
                className="text-[11px] text-red-500/70 hover:text-red-400 transition"
              >
                Cancel meeting
              </button>
            )}
          </div>
        )}

        {/* Agent-bookable banner — visible to everyone (guest, host, agent).
            Browser-using AI agents (Claude.ai, ChatGPT) screenshot this
            page and read it visually; sr-only / aria-hidden discovery
            surfaces are invisible to them. The badge has to be (a) literally
            visible in the rendered viewport and (b) explicit about the
            keywords agents search for ("AgentEnvoy API", "MCP", URL).
            Promoted from text-[10px]/muted bottom-right footer to a more
            prominent inline banner 2026-05-01 after a friend's Claude
            tried web-searching for our API and didn't find it. */}
        <div className="mt-2.5 px-2.5 py-1.5 rounded-md bg-indigo-500/5 border border-indigo-500/20">
          <a
            href="/agents"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 text-[11px] text-secondary hover:text-indigo-400 transition"
            title="AgentEnvoy has a Model Context Protocol API at /api/mcp — see /agents for docs"
          >
            <span aria-hidden="true">🤖</span>
            <span className="flex-1">
              <strong className="font-semibold text-primary">AI agents:</strong>{" "}
              AgentEnvoy has an API. Don&apos;t browse this page — book via the
              MCP endpoint at{" "}
              <span className="font-mono text-indigo-400">agentenvoy.ai/api/mcp</span>{" "}
              (pass the meeting URL as <span className="font-mono">meetingUrl</span>).
              Docs at <span className="font-mono">/agents</span>.
            </span>
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
              <div className="max-w-[85%] rounded-2xl rounded-bl-sm bg-amber-500/10 border border-amber-500/20 px-4 py-3 text-sm text-amber-200 leading-snug">
                <div className="text-[10px] font-bold uppercase tracking-wider mb-1 text-amber-300">
                  Envoy
                </div>
                <div>
                  Couldn&apos;t load times right now.{" "}
                  <button
                    type="button"
                    onClick={() => {
                      if (typeof window !== "undefined") window.location.reload();
                    }}
                    className="underline underline-offset-2 hover:text-amber-100"
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
          <div className="mb-2 px-3 py-2 rounded-md bg-amber-500/10 border border-amber-500/20 text-[11px] text-amber-200 leading-snug">
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
        <div className="max-w-[85%] w-full min-w-0 rounded-2xl px-3 py-3 text-sm bg-surface-secondary border border-DEFAULT text-primary rounded-bl-sm">
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
          {hasCelebrated && !isHost && !confirmed && bilateralByDay && (() => {
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

            // host_update system messages: internal accounting when the host
            // changes meeting params via dashboard. The guest has no context
            // for "Format updated to phone" (they never saw the previous
            // format), so hide from guest view. Host still sees them for
            // continuity.
            if (
              msg.role === "system" &&
              (msg.metadata as Record<string, unknown> | null)?.kind === "host_update" &&
              !isHost
            ) {
              return null;
            }

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
                    <div className="max-w-[70%] rounded-lg px-3 py-1.5 text-xs bg-amber-900/30 border border-amber-700/40 text-amber-300">
                      <span className="font-semibold uppercase tracking-wider text-[9px] text-amber-500 mr-1.5">Note</span>
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

            const showPickerAfter = idx === firstAdminIdx;

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
                <div className={`flex min-w-0 ${rightAligned ? "justify-end" : "justify-start"}`}>
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
                      wantsReminder: formWantsReminder,
                      guestNote: formGuestNote.trim() || undefined,
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
            if (!confirmFormExpanded) {
              setConfirmFormExpanded(true);
              return;
            }
            if (!canSubmit) return;
            handleConfirm(
              { dateTime: effective.dateTime, duration: effective.duration, format: effective.format, location: effective.location },
              { guestName: formGuestName.trim(), guestEmail: formGuestEmail.trim(), wantsReminder: formWantsReminder, guestNote: formGuestNote.trim() || undefined }
            );
          };
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
              <div className={`max-w-[85%] bg-emerald-900/20 border border-emerald-700/50 rounded-xl p-4 space-y-3 ${pendingProposal ? "pick-pulse-once" : ""}`}>
                <div className="text-[10px] font-bold uppercase tracking-wider text-emerald-400">
                  {pendingProposal ? "Your pick" : "Proposed meeting"}
                </div>
                <div className="space-y-1 text-sm text-primary">
                  <p>&#128197; {dt.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: slotTimezone })}</p>
                  <p>&#128336; {dt.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZoneName: "short", timeZone: slotTimezone })} ({formatDuration(effective.duration)})</p>
                  <p>{getMeetingEmoji(effective.format, null) || "🕐"} {effective.format.charAt(0).toUpperCase() + effective.format.slice(1)}</p>
                  {effective.location && <p>&#128205; {effective.location}</p>}
                </div>
                {inPast && (
                  <p className="text-xs text-amber-400">This time is in the past. Pick another from the calendar.</p>
                )}
                {confirmFormExpanded && (
                  <div className="space-y-2 pt-2 border-t border-emerald-700/30">
                    <div>
                      <label className="block text-[10px] font-semibold uppercase tracking-wider text-emerald-400 mb-1">Your name</label>
                      <input
                        type="text"
                        value={formGuestName}
                        onChange={(e) => setFormGuestName(e.target.value)}
                        autoComplete="name"
                        className="w-full px-3 py-2 bg-surface border border-DEFAULT rounded-md text-sm text-primary placeholder:text-muted focus:outline-none focus:border-emerald-500"
                        placeholder="Jane Doe"
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] font-semibold uppercase tracking-wider text-emerald-400 mb-1">Your email</label>
                      <input
                        type="email"
                        value={formGuestEmail}
                        onChange={(e) => setFormGuestEmail(e.target.value)}
                        autoComplete="email"
                        className="w-full px-3 py-2 bg-surface border border-DEFAULT rounded-md text-sm text-primary placeholder:text-muted focus:outline-none focus:border-emerald-500"
                        placeholder="jane@example.com"
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] font-semibold uppercase tracking-wider text-emerald-400 mb-1">
                        Anything else to share? <span className="text-muted font-normal normal-case tracking-normal">(optional)</span>
                      </label>
                      <textarea
                        value={formGuestNote}
                        onChange={(e) => setFormGuestNote(e.target.value)}
                        rows={2}
                        maxLength={500}
                        className="w-full px-3 py-2 bg-surface border border-DEFAULT rounded-md text-sm text-primary placeholder:text-muted focus:outline-none focus:border-emerald-500 resize-none"
                        placeholder="Dial-in number, agenda notes, anything the other person should know…"
                      />
                    </div>
                    <label className="flex items-start gap-2 pt-1 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={formWantsReminder}
                        onChange={(e) => setFormWantsReminder(e.target.checked)}
                        className="mt-0.5 h-4 w-4 accent-emerald-500"
                      />
                      <span className="text-xs text-secondary">Send me a reminder email before the meeting</span>
                    </label>
                  </div>
                )}
                <button
                  onClick={clickConfirmButton}
                  disabled={isConfirming || inPast || (confirmFormExpanded && !canSubmit)}
                  className="w-full mt-2 px-4 py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition"
                >
                  {isConfirming ? "Confirming..." : confirmFormExpanded ? "Confirm" : "Confirm this time"}
                </button>
                <button
                  onClick={() => {
                    if (pendingProposal) {
                      setPendingProposal(null);
                      setConfirmFormExpanded(false);
                    } else {
                      setInput("That\u2019s close, but could we ");
                      document.querySelector<HTMLTextAreaElement>("textarea")?.focus();
                    }
                  }}
                  className="w-full text-center text-xs text-muted hover:text-secondary transition mt-1"
                >
                  {pendingProposal ? "Pick a different time" : "Suggest a change"}
                </button>
                {confirmError && (
                  <p className="mt-2 text-xs text-red-400">{confirmError}</p>
                )}
                {emailWarning && (
                  <p className="mt-2 text-xs text-amber-400">{emailWarning}</p>
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
            linkCode={code}
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
          {/* Desktop centered wrapper for left-side content */}
          <div className="flex-1 min-h-0 overflow-hidden flex flex-col md:max-w-[640px] lg:max-w-[760px] xl:max-w-[880px] md:mx-auto md:w-full">
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
                className="border-b border-amber-800/40 bg-amber-900/10 px-4 py-2.5 flex items-center gap-3 text-sm flex-shrink-0"
                data-testid="tz-recovery-banner"
              >
                <span role="img" aria-label="clock">🕐</span>
                <span className="flex-1 text-amber-100/90">
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
                  className="px-3 py-1 rounded-md text-xs font-medium text-amber-200 hover:text-amber-100 hover:bg-amber-900/20 transition"
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
                <div className="md:hidden border-b border-secondary flex-shrink-0 px-4 py-2 text-[11px] text-amber-200 bg-amber-500/10 leading-snug">
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
