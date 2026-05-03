"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import ThreadCard from "./thread-card";
import { ChannelChatStreamParser, type ChannelChatFrame } from "@/lib/channel-chat-stream";
import { computeThreadStatus, computeGroupThreadStatus } from "@/lib/thread-status";
import { formatDuration } from "@/lib/format-duration";
import { formatDeferralFieldsList, type DeferralFieldNoun } from "@/agent/greetings/registry";
import { QuickReplies } from "./onboarding/quick-replies";
import { PrimaryLinkFlow } from "./onboarding/primary-link-flow";
import { PreferencesExtendedFlow } from "./onboarding/preferences-extended-flow";
import { shortTimezoneLabel } from "@/lib/timezone";
import { GcalUpdateCard } from "./gcal-update-card";
import { RuleConfirmCard } from "./onboarding/rule-confirm-card";
import { RuleConfirmSheet } from "./onboarding/rule-confirm-sheet";
import type { OfficeHoursProposal } from "./onboarding/rule-form-fields";
import { SendFeedbackLink } from "./send-feedback";
import { useOAuthSignIn } from "./oauth/use-oauth-signin";
import { canNativeShare, shareInvite } from "@/lib/share-invite";
import type { QuickReplyOption, OnboardingPhase } from "@/lib/onboarding-machine";

interface ChannelMsg {
  id: string;
  role: string; // "user" | "envoy" | "system"
  content: string;
  threadId?: string | null;
  createdAt: string;
  metadata?: Record<string, unknown> | null;
  thread?: {
    id: string;
    title?: string;
    status: string;
    statusLabel?: string;
    type: string;
    meetingType?: string;
    duration?: number;
    format?: string;
    archived?: boolean;
    agreedTime?: string;
    isGroupEvent?: boolean;
    participants?: Array<{ name: string | null; status: string; role: string }>;
    /** VIP flag extracted server-side from rules.isVip (with legacy
     *  priority string fallback). Renders a single badge on the card. */
    isVip?: boolean;
    /** Short TZ label (e.g. "CEST") resolved server-side from NegotiationSession.guestTimezone. */
    guestTimezoneLabel?: string | null;
    link: {
      inviteeName?: string;
      inviteeNames?: string[];
      inviteeEmail?: string;
      topic?: string;
      code?: string;
      slug: string;
      mode?: string;
      activityIcon?: string | null;
    };
    _count: { messages: number };
  } | null;
}

// ── First-run welcome — variant dispatcher ───────────────────────────────

/**
 * Home greeting — switches on a server-resolved welcome-variant
 * (`/api/me/scheduling-defaults` returns `welcomeVariant`).
 *
 * Variants (state matrix per SPEC §3.3):
 *
 *   - "first-run"          — true new host. Full 3-bubble greeting with
 *                            seeded-posture readback + 3 forward chips.
 *   - "guest-first"        — signed up after a guest experience. Single
 *                            bubble acknowledging the prior interaction
 *                            + 3 forward chips. NO posture readback (the
 *                            user already saw Envoy from the guest side).
 *   - "returning-dormant"  — has messages, last activity ≥ 14 days ago.
 *                            Light "welcome back" bubble + 3 chips.
 *                            STUB — renders null until copy/UX lands.
 *   - "active"             — recent messages. Renders null. The chip
 *                            stack is the implicit "current setup."
 *
 * The 3 forward chips (`Coordinate a meeting / Explore features / Tune
 * preferences`) are extracted as `<ForwardChips>` and shared across
 * variants — same actions, different surrounding framing.
 *
 * 2026-04-26: this replaces the legacy onboarding-machine flow for
 * cold sign-ups. `events.createUser` now sets `lastCalibratedAt`
 * immediately (seed-everything fully configured the user at signup),
 * so /api/onboarding/chat never runs for new users; the demo-draft
 * auto-fire is gone with it. In-flight users from before this change
 * still see the legacy machine until they finish.
 */

type WelcomeVariant =
  | "first-run"
  | "guest-first"
  | "returning-dormant"
  | "active";

interface SeededPosture {
  name: string | null;
  businessHoursStartMinutes: number;
  businessHoursEndMinutes: number;
  defaultDuration: number;
  videoProvider: string;
  timezone: string | null;
  meetSlug: string | null;
  welcomeVariant: WelcomeVariant;
  guestFirstContext: { hostName: string | null; date: string } | null;
  /** §1n followup (b): true iff the user's Google Account has calendar.events
   *  write scope. Drives the guest-first "Connect/Grant write" CTA. */
  hasCalendarWriteScope: boolean;
}

const VIDEO_PROVIDER_DISPLAY: Record<string, string> = {
  google_meet: "Google Meet",
  zoom: "Zoom",
  webex: "Webex",
  teams: "Microsoft Teams",
  phone: "phone",
  in_person: "in-person",
};

function formatBizMinutes(m: number): string {
  const h = Math.floor(m / 60);
  const min = m % 60;
  const suffix = h < 12 || h === 24 ? "am" : "pm";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return min === 0
    ? `${h12}${suffix}`
    : `${h12}:${String(min).padStart(2, "0")}${suffix}`;
}

function firstNameOf(name: string | null): string {
  if (!name) return "there";
  return name.split(/\s+/)[0];
}

/** Three forward chips reused across all greeting variants. Same actions
 *  (coordinate / explore / tune); the bubble copy around them is what
 *  changes per variant. */
function ForwardChips({ onSeed }: { onSeed: (seed: string) => void }) {
  return (
    <div className="flex flex-wrap gap-2 px-1">
      <button
        type="button"
        onClick={() =>
          onSeed(
            "Help me coordinate a meeting — let's find a time and set up an invite.",
          )
        }
        className="text-xs px-3 py-1.5 rounded-full bg-purple-600 hover:bg-purple-500 text-white font-medium transition"
      >
        Coordinate a meeting
      </button>
      <button
        type="button"
        onClick={() =>
          onSeed(
            "Tell me what you can do — show me your most useful features like office hours, group events, and specialty invite links.",
          )
        }
        className="text-xs px-3 py-1.5 rounded-full border border-secondary/60 hover:border-purple-500/60 hover:bg-purple-500/5 text-primary transition"
      >
        Explore features
      </button>
      <button
        type="button"
        onClick={() => onSeed("__primary_link_flow__")}
        className="text-xs px-3 py-1.5 rounded-full border border-secondary/60 hover:border-purple-500/60 hover:bg-purple-500/5 text-primary transition"
      >
        Tune preferences
      </button>
    </div>
  );
}

/** Shared envoy-bubble shell used across the welcome surface. Extracted so
 *  that bubbles in a same-speaker run (consecutive Envoy bubbles in
 *  FirstRunWelcome / GuestFirstVariant) can suppress the "ENVOY" label on
 *  all but the first — modern messaging-app convention, matches the
 *  suppression we applied to chat history in §1n item 2. Pass
 *  `showLabel={false}` for any bubble that follows another Envoy bubble
 *  without an intervening user turn. */
function EnvoyBubble({
  showLabel = true,
  children,
}: {
  showLabel?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      {showLabel && (
        <span className="text-purple-400 text-[10px] font-semibold uppercase tracking-wide px-1">
          Envoy
        </span>
      )}
      <div className="bg-black/5 dark:bg-white/[0.07] rounded-2xl rounded-bl-sm px-4 py-3 text-sm text-primary max-w-lg leading-relaxed">
        {children}
      </div>
    </div>
  );
}

/** Bubble used in the first-run + returning-dormant variants — readback
 *  of the user's currently-seeded scheduling posture so they know what
 *  we're working with. Reusable so a "still right?" nudge for dormant
 *  users gets the same affordances as the first-run intro.
 *
 *  Per mockups/mobile-v2.html §1 Frame 1: the standalone-link card was
 *  pulled OUT of this bubble (was previously rendered inline at the bottom
 *  for first-run). It now renders as a sibling under the bubble in
 *  FirstRunWelcome — keeps the readback bubble focused on posture and lets
 *  the link card carry an indigo-ringed "ready to share" affordance. */
function PostureBubble({ p, showLabel }: { p: SeededPosture; showLabel?: boolean }) {
  const bizRange = `${formatBizMinutes(p.businessHoursStartMinutes)}–${formatBizMinutes(p.businessHoursEndMinutes)}`;
  const tzLabel = p.timezone ? shortTimezoneLabel(p.timezone) : "";
  const provider =
    VIDEO_PROVIDER_DISPLAY[p.videoProvider] ?? p.videoProvider;
  const isFirstRun = p.welcomeVariant === "first-run";

  return (
    <EnvoyBubble showLabel={showLabel}>
        <div className="mb-2">
          {isFirstRun
            ? "I've already set you up using your Google Calendar:"
            : "Quick refresher on your current setup:"}
        </div>
        <ul className="space-y-1 text-[13px] tabular-nums">
          <li>
            <span aria-hidden="true">⏰</span>{" "}
            <span className="text-muted">Business hours:</span>{" "}
            <span className="font-medium">{bizRange}</span>
            {tzLabel && (
              <>
                , <span className="font-medium">{tzLabel}</span>
              </>
            )}
          </li>
          <li>
            <span aria-hidden="true">⏱️</span>{" "}
            <span className="text-muted">Default meetings:</span>{" "}
            <span className="font-medium">
              {p.defaultDuration}-minute {provider}
            </span>
          </li>
          <li>
            <span aria-hidden="true">📅</span>{" "}
            <span className="text-muted">Reading from:</span>{" "}
            <span className="font-medium">your primary calendar</span>
          </li>
        </ul>
        <div className="mt-2 text-[12px] text-muted">
          All customizable any time.
        </div>
    </EnvoyBubble>
  );
}

/** Standalone "your primary link is ready" card — renders under the
 *  PostureBubble in the first-run welcome. Indigo-ringed, uppercase
 *  micro-label header, URL + Copy in a tinted inset row. */
function PrimaryLinkReadyCard({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="self-start w-full max-w-lg bg-surface border border-indigo-500/40 rounded-xl px-3.5 py-3 flex flex-col gap-2">
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted">
        <span aria-hidden="true">🔗</span>
        Your primary link is ready
      </div>
      <div className="flex items-center gap-2 bg-surface-secondary border border-border rounded-lg px-3 py-1.5">
        <code className="font-mono text-[11px] text-primary truncate flex-1">
          {url}
        </code>
        <button
          type="button"
          onClick={() => {
            navigator.clipboard.writeText(`https://${url}`);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          }}
          className="px-3 py-1 bg-indigo-600 hover:bg-indigo-500 text-white text-[11px] font-semibold rounded-md transition flex-shrink-0"
        >
          {copied ? "Copied!" : "Copy"}
        </button>
      </div>
    </div>
  );
}

interface ConnectedCalendar {
  id: string;
  name: string;
  primary: boolean;
  backgroundColor: string | null;
}

type CalendarRole = "primary" | "include" | "ignore";

/**
 * Calendar picker bubble — surfaces the user's connected Google calendars
 * during onboarding (right after the calendar-connect step has implicitly
 * happened via seed-everything). WISHLIST §1n item 1; rendered in both
 * first-run and guest-first variants per the §1n followup (2026-04-28).
 *
 * Single-calendar hosts: skip silently. ≥2 calendars: each calendar gets a
 * three-action picker (Primary / Include / Ignore) backed by
 * `activeCalendarIds[]`:
 *   - **Primary** = activeCalendarIds[0]. Determines the write-target
 *     calendar for new events.
 *   - **Include** = present in activeCalendarIds (not at position 0).
 *     Contributes to availability calculations.
 *   - **Ignore** = absent from activeCalendarIds. Not consulted at all.
 *
 * Default on first paint: only the Google-flagged primary is in
 * activeCalendarIds; everything else is ignored. Hosts can promote secondary
 * calendars to "include" (e.g. a personal calendar that should block work
 * meetings) or shift "primary" to a different calendar.
 *
 * Seed-resolution (§1n followup b/a, 2026-04-28): the seed default writes
 * `activeCalendarIds: ["primary"]` — the literal "primary" string is
 * Google's canonical alias for the user's main calendar, but the manage-
 * calendars dropdown enumerates IDs as actual email addresses, so the
 * literal never matches. On first paint, if activeCalendarIds is empty or
 * equal to the seed literal, auto-resolve to the Google-flagged primary's
 * actual ID and PUT to calendar-filter so downstream surfaces (Calendars
 * dropdown, scoring) all see the same resolved ID.
 */
function CalendarPickerBubble({ showLabel }: { showLabel?: boolean }) {
  const [calendars, setCalendars] = useState<ConnectedCalendar[] | null>(null);
  const [activeIds, setActiveIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch("/api/connections/google-calendars").then((r) =>
        r.ok ? r.json() : null,
      ),
      fetch("/api/agent/knowledge").then((r) => (r.ok ? r.json() : null)),
    ])
      .then(async ([calData, knowledgeData]) => {
        if (cancelled || !calData?.calendars) return;
        const list = calData.calendars as ConnectedCalendar[];
        setCalendars(list);
        const googlePrimary = list.find((c) => c.primary);
        const fallbackId = googlePrimary?.id ?? list[0]?.id ?? null;
        const stored = (knowledgeData?.activeCalendarIds as string[] | undefined) ?? [];

        const needsResolution =
          stored.length === 0 ||
          (stored.length === 1 && stored[0] === "primary");

        if (needsResolution && fallbackId && fallbackId !== "primary") {
          try {
            await fetch("/api/connections/calendar-filter", {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ activeCalendarIds: [fallbackId] }),
            });
            setActiveIds([fallbackId]);
          } catch {
            setActiveIds([fallbackId]);
          }
          return;
        }

        // Already-resolved: keep stored order, but filter to known calendar
        // IDs in case Google removed one since the last write.
        const filtered = stored.filter((id) => list.some((c) => c.id === id));
        setActiveIds(filtered.length > 0 ? filtered : fallbackId ? [fallbackId] : []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  if (!calendars || calendars.length < 2) return null;

  const primaryId = activeIds[0] ?? null;

  function roleOf(id: string): CalendarRole {
    if (id === primaryId) return "primary";
    if (activeIds.includes(id)) return "include";
    return "ignore";
  }

  async function persistActiveIds(next: string[]): Promise<boolean> {
    try {
      const res = await fetch("/api/connections/calendar-filter", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ activeCalendarIds: next }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async function handleRoleChange(id: string, role: CalendarRole) {
    if (busy) return;
    const current = roleOf(id);
    if (current === role) return;
    setBusy(true);
    const previous = activeIds;

    // Compute next activeCalendarIds[] from the role change. Primary is
    // always position 0; included calendars follow in their original
    // ordering; ignored calendars are absent.
    let next: string[];
    if (role === "primary") {
      next = [id, ...activeIds.filter((x) => x !== id)];
    } else if (role === "include") {
      // If the calendar was previously primary, we need a new primary —
      // promote the next-active calendar (or the only remaining one).
      // Disallow demoting primary if it would leave the list empty.
      if (current === "primary") {
        const rest = activeIds.filter((x) => x !== id);
        if (rest.length === 0) {
          setBusy(false);
          return; // refuse — at least one calendar must be active
        }
        next = [...rest, id];
      } else {
        // Was ignored → append to activeIds.
        next = [...activeIds, id];
      }
    } else {
      // role === "ignore"
      if (current === "primary") {
        const rest = activeIds.filter((x) => x !== id);
        if (rest.length === 0) {
          setBusy(false);
          return;
        }
        next = rest;
      } else {
        next = activeIds.filter((x) => x !== id);
      }
    }

    setActiveIds(next); // optimistic
    const ok = await persistActiveIds(next);
    if (!ok) setActiveIds(previous);
    setBusy(false);
  }

  return (
    <EnvoyBubble showLabel={showLabel}>
        <div className="mb-2">
          I use your Google calendar(s) to determine your availability and
          send invites. You&rsquo;ve got {calendars.length} Google calendars
          — we&rsquo;ve selected your primary calendar, but let me know if I
          should add others or make a different calendar your primary.
        </div>
        <ul className="space-y-1.5">
          {calendars.map((cal) => {
            const role = roleOf(cal.id);
            return (
              <li
                key={cal.id}
                className="flex items-center justify-between gap-3 text-[13px]"
              >
                <span className="flex items-center gap-2 min-w-0">
                  {cal.backgroundColor && (
                    <span
                      aria-hidden="true"
                      className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                      style={{ backgroundColor: cal.backgroundColor }}
                    />
                  )}
                  <span className="truncate">{cal.name}</span>
                </span>
                <select
                  value={role}
                  onChange={(ev) =>
                    handleRoleChange(cal.id, ev.target.value as CalendarRole)
                  }
                  disabled={busy}
                  aria-label={`Role for ${cal.name}`}
                  className="text-[11px] bg-surface-secondary border border-border rounded px-2 py-0.5 text-primary disabled:opacity-50 transition flex-shrink-0"
                >
                  <option value="primary">Primary</option>
                  <option value="include">Include</option>
                  <option value="ignore">Ignore</option>
                </select>
              </li>
            );
          })}
        </ul>
    </EnvoyBubble>
  );
}

/**
 * Guest-first welcome — user came in via someone else's link, signed up via the
 * read-only guest-flow path, and now landed on their own Home for the first
 * time. WISHLIST §1n item 7 originally added an unconditional "Connect Google
 * Calendar" CTA here; the followup (2026-04-28) gates it on actual OAuth scope
 * — only show it when calendar.events write scope is missing. Users who
 * already have full read+write don't need to be told to connect again.
 */
function GuestFirstVariant({
  posture,
  onSeed,
}: {
  posture: SeededPosture;
  onSeed: (seed: string) => void;
}) {
  const needsWriteScope = !posture.hasCalendarWriteScope;
  // mode: "upgrade-scope" — user already has an Account from the guest-flow
  // (read-only). To gain write, they need to re-consent with the new scope
  // checkbox visible; "upgrade-scope" sends `prompt: "consent"` and renders
  // the minimal `<UpgradeScopeBody>` modal copy. (Pre-followup this used
  // mode: "first-connect" which read like "you're a brand-new visitor" to
  // someone who already has an account.)
  const connectFlow = useOAuthSignIn({
    mode: "upgrade-scope",
    callbackUrl: "/dashboard",
  });

  // Two distinct screens:
  //
  //   - needsWriteScope (gate): the user came in via the guest-flow with
  //     read-only OAuth scope. We can't actually do scheduling on their
  //     behalf without write access, so we GATE the experience here — show
  //     a re-introduction + access-required framing, hide the forward
  //     chips so they can't proceed without granting. Once they click
  //     through, OAuth round-trip + redirect to /dashboard re-renders this
  //     component with hasCalendarWriteScope=true → the post-grant screen.
  //
  //   - has write scope (post-grant): they've completed the upgrade. Now
  //     they're effectively a fully-set-up host. Show them the seeded
  //     posture, their Primary link, and forward chips so they can
  //     actually use the product.
  if (needsWriteScope) {
    return (
      <div className="flex-1 flex flex-col justify-center py-6 gap-4">
        <h1 className="text-xl sm:text-2xl font-semibold text-primary px-1">
          👋 Welcome back, {firstNameOf(posture.name)}.
        </h1>

        <EnvoyBubble>
          <div className="mb-2">
            Great to re-meet you! I&rsquo;m Envoy. I run{" "}
            <strong className="font-semibold">personalized</strong>{" "}
            scheduling on your behalf so you don&rsquo;t have to chase
            calendars. Share a link, your invitee chats with me, I work
            out a time tailored to each guest.
          </div>
          <div>
            First things first — I need you to connect your Google
            Calendar so I can line up the best times to fit your
            schedule.
          </div>
        </EnvoyBubble>

        <div className="flex flex-wrap gap-2 px-1">
          <button
            type="button"
            onClick={connectFlow.trigger}
            className="text-xs px-3 py-1.5 rounded-full bg-emerald-600 hover:bg-emerald-500 text-white font-medium transition inline-flex items-center gap-1.5"
          >
            <span aria-hidden="true">🗓️</span>
            Connect Google Calendar
          </button>
        </div>

        {connectFlow.modal}
      </div>
    );
  }

  // Post-grant — light welcome with one bubble and the forward chips.
  // The user already saw Envoy from the guest side and just completed the
  // calendar connect, so we don't reintroduce the brand or read back the
  // posture; we let them choose between diving in vs. getting set up.
  return (
    <div className="flex-1 flex flex-col justify-center py-6 gap-4">
      <h1 className="text-xl sm:text-2xl font-semibold text-primary px-1">
        👋 Welcome back, {firstNameOf(posture.name)}.
      </h1>

      <EnvoyBubble>
          Let&rsquo;s get started — we can dive right in to your first
          meeting, or I can help you get up to speed and set up.
      </EnvoyBubble>

      <ForwardChips onSeed={onSeed} />
    </div>
  );
}

function FirstRunWelcome({ onSeed }: { onSeed: (seed: string) => void }) {
  const [posture, setPosture] = useState<SeededPosture | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/me/scheduling-defaults")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        setPosture({
          name: data.name ?? null,
          businessHoursStartMinutes: data.businessHoursStartMinutes ?? 540,
          businessHoursEndMinutes: data.businessHoursEndMinutes ?? 1020,
          defaultDuration: data.defaultDuration ?? 30,
          videoProvider: data.videoProvider ?? "google_meet",
          timezone: data.timezone ?? null,
          meetSlug: data.meetSlug ?? null,
          welcomeVariant: (data.welcomeVariant as WelcomeVariant) ?? "first-run",
          guestFirstContext: data.guestFirstContext ?? null,
          hasCalendarWriteScope: !!data.hasCalendarWriteScope,
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Don't render anything until the variant is known. The fetch is fast;
  // showing a flash of generic content while the server decides which
  // variant we are would be worse than a moment of empty space. (The
  // chip stack above us is already rendered, so the page isn't blank.)
  if (!posture) return null;

  // Active steady-state: no greeting. The chip stack at the top of the
  // feed is the implicit "current setup" affordance.
  if (posture.welcomeVariant === "active") return null;

  // Returning-dormant: stub for now — slot wired but copy/UX deferred.
  // Renders null in this PR; will become a "welcome back" bubble +
  // posture refresher + chips in a follow-up once the design lands.
  // TODO(returning-dormant): light bubble, posture refresher, ForwardChips.
  if (posture.welcomeVariant === "returning-dormant") return null;

  // Guest-first: user came in via someone else's link, signed up,
  // landed on Home. Acknowledge the prior interaction; skip the
  // posture readback (they saw Envoy from the guest side already).
  if (posture.welcomeVariant === "guest-first") {
    return (
      <GuestFirstVariant posture={posture} onSeed={onSeed} />
    );
  }

  // first-run (default): full intro.
  return (
    <div className="flex-1 flex flex-col justify-center py-6 gap-4">
      {/* Welcome — H1 for the page itself. Pin at top, not in the chat
          column, so it reads as a page header rather than another bubble. */}
      <h1 className="text-xl sm:text-2xl font-semibold text-primary px-1">
        🎉 Welcome to AgentEnvoy.
      </h1>

      {/* Combined intro + posture readback — one bubble (one ENVOY label).
          The seeded posture is the load-bearing info; the brand-pitch line
          opens it but doesn't deserve its own labeled bubble. */}
      <EnvoyBubble>
          <div className="mb-2">
            👋 Hey {firstNameOf(posture.name)} — I&rsquo;m Envoy. I run{" "}
            <strong className="font-semibold">personalized</strong>{" "}
            scheduling on your behalf so you don&rsquo;t have to chase
            calendars. Share a link, your invitee chats with me, I work out
            a time tailored to each guest.
          </div>
      </EnvoyBubble>

      {/* Posture readback — same speaker, label suppressed. */}
      <PostureBubble p={posture} showLabel={false} />

      {/* Calendar picker — only renders when the user has 2+ connected
          calendars; otherwise silent. WISHLIST §1n item 1. Same speaker,
          label suppressed. */}
      <CalendarPickerBubble showLabel={false} />

      {/* Standalone link-card — pulled out of the posture bubble per the
          mockup so the link reads as its own "ready to share" affordance
          rather than a footnote. Only rendered for first-run (existing
          users on the dormant variant haven't been issued a fresh link). */}
      {posture.meetSlug && (
        <PrimaryLinkReadyCard url={`agentenvoy.ai/meet/${posture.meetSlug}`} />
      )}

      {/* Single CTA — nudge new hosts into the preference-tuning flow.
          Other options removed so there is one clear next step. */}
      <EnvoyBubble showLabel={false}>
          Take 2 minutes to tune your preferences — it makes every meeting
          better.
      </EnvoyBubble>

      <div className="px-1">
        <button
          type="button"
          onClick={() => onSeed("__primary_link_flow__")}
          className="text-xs px-4 py-2 rounded-full bg-indigo-600 hover:bg-indigo-500 text-white font-medium transition"
        >
          Continue tuning my preferences →
        </button>
      </div>
    </div>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────

/** Render **bold** and [link](url) markdown in message content */
function renderMarkdown(text: string): React.ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g);
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={i} className="font-semibold">{part.slice(2, -2)}</strong>;
    }
    const linkMatch = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (linkMatch) {
      return <a key={i} href={linkMatch[2]} className="text-purple-400 hover:text-purple-300 underline">{linkMatch[1]}</a>;
    }
    return <span key={i}>{part}</span>;
  });
}

function MeetLinkCard({ url, topic }: { url: string; topic?: string }) {
  const [copied, setCopied] = useState(false);
  const [shareSupported, setShareSupported] = useState(false);
  useEffect(() => {
    setShareSupported(canNativeShare());
  }, []);
  return (
    <div className="mt-3 bg-purple-500/10 border border-purple-500/20 rounded-lg p-3 flex items-center gap-3">
      <code className="text-xs text-purple-400 truncate flex-1">{url}</code>
      {shareSupported && (
        <button
          onClick={() => {
            void shareInvite({ url, topic });
          }}
          className="sm:hidden px-3 py-1.5 bg-purple-500/20 hover:bg-purple-500/30 text-purple-200 text-xs font-medium rounded-md transition flex-shrink-0"
        >
          Share
        </button>
      )}
      <button
        onClick={() => {
          navigator.clipboard.writeText(url);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        }}
        className="px-3 py-1.5 bg-purple-600 hover:bg-purple-500 text-white text-xs font-medium rounded-md transition flex-shrink-0"
      >
        {copied ? "Copied!" : "Copy link"}
      </button>
    </div>
  );
}

// ── Feed component ──────────────────────────────────────────────────────

export default function Feed({ onboardReturnTo }: { onboardReturnTo?: string | null } = {}) {
  const router = useRouter();
  const [messages, setMessages] = useState<ChannelMsg[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  // Progress narration status row (proposal decided 2026-04-21). Shows a
  // rotating calendar-themed status line while the server moves through
  // pipeline stages. Replaced by the final envoy bubble on the `text` frame.
  // Screen-reader behaviour: the visible row is aria-live="off" so we don't
  // queue four intermediate announcements; a single aria-live="polite"
  // "Response ready." fires at the text-frame boundary (§2.3 N9).
  const [statusCopy, setStatusCopy] = useState<string | null>(null);
  // Nonce counter for the aria-live "Response ready." announcement. Bumping
  // this re-mounts the aria-live region (via `key={announcementNonce}` on the
  // div) so screen readers re-announce on consecutive turns — without having
  // to put any unique identifier in the text content itself. Previous approach
  // (`Response ready. ${Date.now()}`) leaked the timestamp to sighted users in
  // production when `sr-only` didn't fully hide the region. Fixed 2026-04-21.
  const [announcementNonce, setAnnouncementNonce] = useState(0);
  // Clarifier quick-replies from the intent router's `unclear` tier. When set,
  // quick-reply pills render beneath the most-recent envoy bubble; click
  // re-submits `originalText` with the selected `userIntentHint`, bypassing
  // the classifier. Proposal: 2026-04-21_dashboard-chat-intent-router §2.6.
  const [clarifierState, setClarifierState] = useState<{
    originalText: string;
    replies: Array<{ label: string; intent: "schedule" | "inquire" }>;
  } | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [calendarConnected, setCalendarConnected] = useState(true);
  const [isCalibrated, setIsCalibrated] = useState(true);
  // Primary-link guided setup flow — toggled from the 🔗 welcome card.
  // Per SPEC §6.6 and proposal `2026-04-30_onboarding-and-tuning-as-chat`:
  // the flow now reads/writes `ChannelMessage`s with subkind=primary-link-tuning
  // via `/api/onboarding/primary-link`. Render gate derives "in progress"
  // from messages, not from `messages.length === 0`.
  const [primaryLinkFlowActive, setPrimaryLinkFlowActive] = useState(false);
  // Continuation flow ("Fine-tune availability + theme"). Activated by the
  // CTA shown after primary-link completion, and auto-resumed on reload if
  // prior preferences-extended messages exist without the terminal flag.
  const [extendedFlowActive, setExtendedFlowActive] = useState(false);
  // Lightweight context for `PrimaryLinkFlow` — fetched once on mount.
  // Not gating: if these are null, the flow degrades gracefully (no
  // primary-link slug in the celebration, no browser tz proposal).
  const [tuningCtx, setTuningCtx] = useState<{
    name: string | null;
    meetSlug: string | null;
    browserTz: string | null;
  }>(() => ({
    name: null,
    meetSlug: null,
    browserTz: (() => {
      try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
      } catch {
        return null;
      }
    })(),
  }));
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const hasLoadedRef = useRef(false);

  // ── Onboarding state ──────────────────────────────────────────────────
  const [onboardingPhase, setOnboardingPhase] = useState<OnboardingPhase | null>(null);
  const [activeOptions, setActiveOptions] = useState<QuickReplyOption[] | null>(null);
  const [optionsLocked, setOptionsLocked] = useState(false);
  const [inputPlaceholder, setInputPlaceholder] = useState<string | null>(null);
  const pendingSendRef = useRef<string | null>(null);
  const onboardingInitRef = useRef(false);

  const isOnboarding = !isCalibrated && onboardingPhase !== null && onboardingPhase !== "complete";

  // Composer prefill bus — two delivery paths feed the same primitive:
  //
  //  1. **CustomEvent** (`envoy:prefill-composer`) — fires from in-page
  //     dispatchers that don't navigate (MyLinksPopover, mobile Event
  //     Links sheet). Feed is already mounted; the listener catches it.
  //  2. **sessionStorage** (`envoy:pending-prefill`) — used by surfaces
  //     that DO navigate to /dashboard (desktop event-links page).
  //     CustomEvents don't survive route changes, and a setTimeout-after-
  //     push race gets lost when Feed mounts later than expected. The
  //     stashed value is consumed once on mount and cleared.
  useEffect(() => {
    function applyPrefill(text: string) {
      if (!text) return;
      setInput(text);
      textareaRef.current?.focus();
      const el = textareaRef.current;
      if (el) {
        const len = text.length;
        try { el.setSelectionRange(len, len); } catch {}
      }
    }
    function onPrefill(e: Event) {
      const ce = e as CustomEvent<string>;
      const text = typeof ce.detail === "string" ? ce.detail : "";
      applyPrefill(text);
    }
    window.addEventListener("envoy:prefill-composer", onPrefill);
    // Drain any pending prefill from a cross-route navigation (desktop
    // event-links → /dashboard). Wrapped in try/catch — sessionStorage
    // can throw in private-mode browsers.
    try {
      const pending = sessionStorage.getItem("envoy:pending-prefill");
      if (pending) {
        sessionStorage.removeItem("envoy:pending-prefill");
        applyPrefill(pending);
      }
    } catch {
      // ignore
    }
    return () => window.removeEventListener("envoy:prefill-composer", onPrefill);
  }, []);

  // Load channel history
  useEffect(() => {
    if (hasLoadedRef.current) return;
    hasLoadedRef.current = true;
    async function loadMessages() {
      try {
        const res = await fetch("/api/channel/messages");
        if (res.ok) {
          const data = await res.json();
          setMessages(data.messages || []);
          if (data.calendarConnected !== undefined) setCalendarConnected(data.calendarConnected);
          if (data.lastCalibratedAt !== undefined) setIsCalibrated(!!data.lastCalibratedAt);
        }
      } catch (e) {
        console.error("Failed to load channel messages:", e);
      } finally {
        setInitialLoading(false);
      }
    }
    loadMessages();
  }, []);

  // Fetch tuning context (name + meetSlug) once. Used by PrimaryLinkFlow's
  // celebration card and resume detection. Cheap enough that we don't
  // gate it behind a lazy mount.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/me/scheduling-defaults")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        setTuningCtx((prev) => ({
          ...prev,
          name: data.name ?? null,
          meetSlug: data.meetSlug ?? null,
        }));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Auto-resume tuning if the channel has unfinished tuning history. Per
  // proposal §2.3: `primaryLinkFlowActive` is the React signal but
  // "in-progress vs done" derives from messages. Same logic for the
  // preferences-extended continuation flow.
  useEffect(() => {
    if (initialLoading) return;
    const tuning = messages.filter((m) => {
      const meta = m.metadata as { kind?: string; subkind?: string } | null;
      return meta?.kind === "onboarding" && meta?.subkind === "primary-link-tuning";
    });
    if (tuning.length > 0) {
      const terminal = tuning.some(
        (m) => (m.metadata as { terminal?: boolean } | null)?.terminal === true,
      );
      if (!terminal) setPrimaryLinkFlowActive(true);
    }

    const extended = messages.filter((m) => {
      const meta = m.metadata as { kind?: string; subkind?: string } | null;
      return meta?.kind === "onboarding" && meta?.subkind === "preferences-extended";
    });
    if (extended.length > 0) {
      const terminal = extended.some(
        (m) => (m.metadata as { terminal?: boolean } | null)?.terminal === true,
      );
      if (!terminal) setExtendedFlowActive(true);
    }
  }, [initialLoading, messages]);

  // ── Calibrated user with onboardReturnTo → bounce immediately ──────────
  // If the user arrived at /dashboard?onboardReturnTo=... but is already
  // calibrated (returning host, no onboarding to run), honor the returnTo
  // instead of showing the dashboard. Proposal §2.3.
  useEffect(() => {
    if (initialLoading || !isCalibrated || !onboardReturnTo) return;
    router.replace(onboardReturnTo);
  }, [initialLoading, isCalibrated, onboardReturnTo, router]);

  // ── Initialize onboarding when uncalibrated ───────────────────────────
  useEffect(() => {
    if (initialLoading || isCalibrated || onboardingInitRef.current) return;
    onboardingInitRef.current = true;

    async function initOnboarding() {
      try {
        // Seed the server with the browser-detected tz so the welcome can
        // assume a reasonable zone before Google Calendar settings are
        // consulted. Server validates + stamps `timezoneSource:"browser-detected"`;
        // invalid values are ignored.
        const browserTz = (() => {
          try {
            return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
          } catch {
            return "";
          }
        })();
        const params = new URLSearchParams();
        if (onboardReturnTo) params.set("hasReturnTo", "1");
        if (browserTz) params.set("browserTz", browserTz);
        const qs = params.toString();
        const url = qs ? `/api/onboarding/chat?${qs}` : "/api/onboarding/chat";
        const res = await fetch(url);
        if (!res.ok) return;
        const data = await res.json();

        if (data.redirect) {
          window.location.href = data.redirect;
          return;
        }

        // If we already loaded persisted onboarding history from the channel,
        // don't re-add the current-phase messages — just sync phase + options.
        // Otherwise we'd duplicate the last turn on every reload.
        const hasPersistedHistory = messages.some(
          (m) => (m.metadata as { kind?: string } | null)?.kind === "onboarding"
        );
        if (hasPersistedHistory) {
          setOnboardingPhase(data.phase);
          setInputPlaceholder(data.placeholder || null);
          const lastMsg = data.messages?.[data.messages.length - 1];
          if (lastMsg?.options?.length > 0) {
            setActiveOptions(lastMsg.options);
            setOptionsLocked(false);
          }
          return;
        }

        processOnboardingResult(data);
      } catch (e) {
        console.error("Failed to initialize onboarding:", e);
      }
    }
    initOnboarding();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialLoading, isCalibrated]);

  // ── Process onboarding API result ─────────────────────────────────────
  const processOnboardingResult = useCallback(
    (data: {
      phase: OnboardingPhase;
      messages: Array<{ content: string; options?: QuickReplyOption[]; delay?: number }>;
      autoAdvance?: boolean;
      onboardingComplete?: boolean;
      /** Server short-circuited because `lastCalibratedAt` was already
       *  set (cold-mount race protection — see onboarding/chat
       *  route.ts comment). Treat as state-sync only: flip
       *  isCalibrated, clear phase/options, do NOT emit any messages,
       *  do NOT re-arm the demo-draft. Diagnosed 2026-04-26. */
      alreadyCalibrated?: boolean;
      placeholder?: string;
    },
    // Belt-and-suspenders gate for the demo auto-draft: only arm the
    // Anderson draft when we arrived at `complete` by advancing from the
    // terminal phase in THIS session — never on a stale re-POST or a GET
    // that lands an already-complete user back on /dashboard. The server
    // already gates `onboardingComplete: true` to the terminal phase
    // advance, so this is defense-in-depth.
    fromPhase?: OnboardingPhase,
    ) => {
      // Server already-calibrated short-circuit — sync state, no emits.
      // This response shape comes from the duplicate-fire race fix; both
      // racing POSTs arrive but only the first does any real work.
      if (data.alreadyCalibrated) {
        setIsCalibrated(true);
        setOnboardingPhase(null);
        setActiveOptions(null);
        setInputPlaceholder(null);
        return;
      }

      // Onboarding finished — switch to normal chat mode (no reload)
      if (data.onboardingComplete) {
        for (const msg of data.messages) {
          addEnvoyMessage(msg.content);
        }
        setOnboardingPhase(null);
        setInputPlaceholder(null);
        setActiveOptions(null);
        setIsCalibrated(true);

        // onboardReturnTo path: user came in mid-flow (e.g. booking a deal
        // room). Bounce them to the original destination instead of the
        // demo-meeting auto-fire, so they resume the interrupted task.
        if (onboardReturnTo) {
          setTimeout(() => {
            router.replace(onboardReturnTo);
          }, 1200);
          return;
        }

        // Only arm the demo auto-draft if this complete came from advancing
        // the terminal phase (`intro`) in this session. initOnboarding calls
        // this fn with no fromPhase, so a resumed already-complete user
        // never arms the draft. (Post-2026-04-23 the terminal advance is
        // intro→complete; the sunset `defaults_confirm` beat is still
        // accepted as a legacy value for in-flight users.)
        if (fromPhase !== "intro" && fromPhase !== "defaults_confirm") {
          return;
        }

        // Cross-mount idempotency guard for the demo-draft. Server-side
        // already-calibrated short-circuit catches the common case, but
        // a sessionStorage flag survives any pathological remount path
        // (Next.js prefetch, parallel mount in dev, etc.) and ensures
        // the auto-draft only fires once per signed-in browser session.
        // Diagnosed 2026-04-26: cold-mount race produced 2× demo drafts
        // and 2× orphan link cards.
        try {
          if (sessionStorage.getItem("envoy:demo-draft-fired") === "1") {
            return;
          }
          sessionStorage.setItem("envoy:demo-draft-fired", "1");
        } catch {
          // sessionStorage unavailable (private mode, SSR window): the
          // server short-circuit and React mount semantics are still in
          // place; proceed without the cross-mount guard.
        }

        // Auto-fire a test meeting after a short pause so the user sees the
        // "watch what happens..." message first, then Envoy creates the demo
        // invite in front of their eyes.
        setTimeout(() => {
          // Tone note: phrase this as a concrete, completed-sounding request
          // so the LLM's reply is a short acknowledgement ("Ok, here's the
          // invite I drafted for John — [slot/link]. Let me know any tweaks.")
          // rather than a performative recap of what it's about to do.
          pendingSendRef.current = "Draft a 5-minute meet & greet video call with John Anderson, founder of AgentEnvoy, at my next available time. Keep your reply short — just confirm the draft with the time + link and invite tweaks.";
          setInput(pendingSendRef.current);
        }, 2500);
        return;
      }

      setOnboardingPhase(data.phase);
      setInputPlaceholder(data.placeholder || null);

      // Add envoy messages
      for (const msg of data.messages) {
        addEnvoyMessage(msg.content);
      }

      // Get options from last message (if any)
      const lastMsg = data.messages[data.messages.length - 1];
      if (lastMsg?.options && lastMsg.options.length > 0) {
        setActiveOptions(lastMsg.options);
        setOptionsLocked(false);
      } else {
        setActiveOptions(null);
      }

      // Auto-advance phases: show content, then auto-POST to advance
      if (data.autoAdvance) {
        setActiveOptions(null);
        setTimeout(() => {
          advanceOnboarding(data.phase, "auto");
        }, 2500);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  function addEnvoyMessage(content: string) {
    const msg: ChannelMsg = {
      id: `onboarding-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      role: "envoy",
      content,
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, msg]);
  }

  function addUserMessage(content: string) {
    const msg: ChannelMsg = {
      id: `onboarding-user-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      role: "user",
      content,
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, msg]);
  }

  // ── Advance onboarding ────────────────────────────────────────────────
  async function advanceOnboarding(
    phase: OnboardingPhase,
    response: string,
    extra?: Record<string, unknown>
  ) {
    setLoading(true);
    setOptionsLocked(true);
    try {
      const res = await fetch("/api/onboarding/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phase, response, ...extra }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error || "Failed to advance onboarding");
      }
      const data = await res.json();
      processOnboardingResult(data, phase);
    } catch (e) {
      console.error("Onboarding advance error:", e);
      addEnvoyMessage("Something went wrong. Please try again.");
      setOptionsLocked(false);
    } finally {
      setLoading(false);
    }
  }

  // ── Handle quick reply selection ──────────────────────────────────────
  function handleQuickReply(value: string, label: string) {
    if (optionsLocked || !onboardingPhase) return;
    addUserMessage(label);
    setActiveOptions(null);
    advanceOnboarding(onboardingPhase, value, { responseLabel: label });
  }

  // Auto-send after post-onboarding quick reply sets the input
  useEffect(() => {
    if (pendingSendRef.current && input === pendingSendRef.current) {
      pendingSendRef.current = null;
      handleSend();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input]);

  // Scroll feed container to bottom. On new messages (OR on message-array
  // identity changes — e.g., post-turn refetch that rehydrates `thread` data
  // on the last Envoy message without changing array length), we pin to the
  // bottom (stickToBottomRef). A ResizeObserver on the inner content pins
  // again if async card content (ThreadCard, calendar, images) grows the
  // wrapper. And a short rAF-retry loop pins on every frame for ~300ms after
  // each message change — this is the fallback for late-rendering content
  // that the observer's timing can miss (observer fires after React commit
  // but before final browser paint; scrollHeight read may be stale).
  //
  // Reported 2026-04-21: prior two fixes (#46 adds observer + pb-8, #51
  // instant-scroll) still left ThreadCards clipped under the composer because
  // (a) the post-turn `setMessages` REPLACES the array at the same length, so
  // the length-based scroll trigger didn't fire, and (b) pb-8 (32px) is less
  // than a ThreadCard's full post-hydration height (~80px), so the observer
  // was the only mechanism — and it sometimes missed.
  const prevMessageCount = useRef(0);
  const stickToBottomRef = useRef(true);
  const prevMessagesRef = useRef<ChannelMsg[]>([]);

  useEffect(() => {
    if (messages.length === 0) {
      prevMessageCount.current = 0;
      prevMessagesRef.current = messages;
      return;
    }
    const container = scrollContainerRef.current;
    if (!container) return;

    const lengthGrew = messages.length > prevMessageCount.current;
    const initial = prevMessageCount.current === 0;
    // Array identity check — post-turn refetch replaces the array even when
    // length is stable (e.g., the last Envoy message gets `thread` hydrated).
    // That refetch often produces the biggest layout growth (ThreadCard) and
    // therefore the most clipping risk; detect it here.
    const arrayChanged = messages !== prevMessagesRef.current;

    if (initial || lengthGrew || arrayChanged) {
      stickToBottomRef.current = true;
      // rAF retry loop — pin on every frame for ~300ms. Each tick is idempotent
      // (no-op when scrollTop already equals scrollHeight). Catches async
      // content that renders after the initial pin AND after the observer
      // would have fired.
      const deadline = performance.now() + 300;
      const tick = () => {
        if (!stickToBottomRef.current) return;
        if (!scrollContainerRef.current) return;
        const c = scrollContainerRef.current;
        c.scrollTop = c.scrollHeight;
        if (performance.now() < deadline) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }
    prevMessageCount.current = messages.length;
    prevMessagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    const end = messagesEndRef.current;
    if (!container || !end) return;
    const onScroll = () => {
      // Widened from 24px to 96px (≈ composer height). User scrolled up by
      // less than a composer's worth of pixels (trackpad overshoot, mobile
      // momentum) still counts as "at the bottom, please keep pinning."
      const nearBottom =
        container.scrollHeight - container.scrollTop - container.clientHeight < 96;
      stickToBottomRef.current = nearBottom;
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    const observer = new ResizeObserver(() => {
      if (!stickToBottomRef.current) return;
      container.scrollTop = container.scrollHeight;
    });
    const inner = end.parentElement;
    if (inner) observer.observe(inner);
    return () => {
      container.removeEventListener("scroll", onScroll);
      observer.disconnect();
    };
  }, []);

  // Auto-resize textarea
  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    const el = e.target;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 120) + "px";
  }, []);

  // Open deal room in a new tab so host doesn't lose the dashboard context.
  function navigateToThread(thread: NonNullable<ChannelMsg["thread"]>) {
    const url = thread.link.code
      ? `/meet/${thread.link.slug}/${thread.link.code}`
      : `/meet/${thread.link.slug}`;
    window.open(url, "_blank", "noopener,noreferrer");
  }

  // Archive a thread
  async function handleArchive(sessionId: string) {
    try {
      await fetch("/api/negotiate/archive", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, archived: true }),
      });
      const res = await fetch("/api/channel/messages");
      if (res.ok) {
        const data = await res.json();
        setMessages(data.messages || []);
      }
    } catch (e) {
      console.error("Archive error:", e);
    }
  }

  // Send message
  const handleSend = async (
    overrideText?: string,
    intentHint?: "schedule" | "inquire",
  ) => {
    const text = (overrideText ?? input).trim();
    if (!text || loading) return;
    // Any new turn invalidates previous clarifier quick-replies.
    setClarifierState(null);

    // ── Onboarding freeform input (about_you, protection_blocks, etc.) ──
    // Intro phase is an exception: freetext during the welcome dwell falls
    // through to normal channel chat so a fresh user can type
    // "Book time w/ Danny..." the moment the welcome renders, using the
    // seeded tz, without being blocked by a phase that no longer asks for
    // anything.
    if (isOnboarding && onboardingPhase && onboardingPhase !== "intro") {
      setInput("");
      if (textareaRef.current) textareaRef.current.style.height = "auto";
      addUserMessage(text);
      setActiveOptions(null);
      advanceOnboarding(onboardingPhase, text);
      return;
    }

    // Host directive: :: prefix
    if (text.startsWith("::")) {
      const directive = text.slice(2).trim();
      if (!directive) return;
      setInput("");
      if (textareaRef.current) textareaRef.current.style.height = "auto";
      try {
        await fetch("/api/negotiate/directive", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: directive }),
        });
        setMessages((prev) => [
          ...prev,
          {
            id: `directive-${Date.now()}`,
            role: "system",
            content: `Directive saved: "${directive}"`,
            createdAt: new Date().toISOString(),
          },
        ]);
      } catch {}
      return;
    }

    setInput("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";

    // Optimistic add user message
    const userMsg: ChannelMsg = {
      id: `temp-${Date.now()}`,
      role: "user",
      content: text,
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMsg]);
    setLoading(true);

    try {
      const res = await fetch("/api/channel/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          ...(intentHint ? { userIntentHint: intentHint } : {}),
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

      if (contentType.includes("application/json")) {
        const data = await res.json();
        // Trim trailing whitespace on the main message before concatenating
        // the share note — the LLM often emits messages ending in a newline,
        // and combining that with our literal \n\n separator produces \n\n\n
        // inside a `whitespace-pre-wrap` bubble, which shows as a visible
        // blank line mid-message. Trimming restores a clean single gap.
        const envoyContent = data.shareNote
          ? `${(data.message ?? "").trimEnd()}\n\n${data.shareNote}`
          : data.message;

        const envoyMsg: ChannelMsg = {
          id: `temp-envoy-${Date.now()}`,
          role: "envoy",
          content: envoyContent,
          createdAt: new Date().toISOString(),
        };
        setMessages((prev) => [...prev, envoyMsg]);

        // Reload messages to get the full thread card from the server
        const refreshRes = await fetch("/api/channel/messages");
        if (refreshRes.ok) {
          const refreshData = await refreshRes.json();
          setMessages(refreshData.messages || []);
        }
      } else {
        // JSON-lines stream (application/x-ndjson). Status frames update the
        // inline status row; the terminating text frame renders the final
        // envoy bubble. Proposal: envoy-progress-reasoning-narration
        // (decided 2026-04-21). Minimum 400ms dwell: a status update that
        // would be superseded by the next frame within 400ms is skipped.
        //
        // Duplicate seq is allowed (renders twice, cosmetic only — §2.4 N7).
        // Garbage lines are ignored by the parser; we treat zero frames as
        // a silent success with empty text.
        const MIN_DWELL_MS = 400;
        const parser = new ChannelChatStreamParser();
        let finalText: string | null = null;
        // Wrapped in an object so TS retains narrow typing through closure
        // mutation — a bare `let` reassigned inside handleFrames narrows to
        // `never` at the post-stream check.
        const clarifierBox: {
          value: {
            replies: Array<{ label: string; intent: "schedule" | "inquire" }>;
          } | null;
        } = { value: null };
        let pendingCopy: string | null = null;
        let pendingAt = 0;
        let rafTimer: ReturnType<typeof setTimeout> | null = null;
        const maybeRender = () => {
          const now = Date.now();
          const since = now - pendingAt;
          if (pendingCopy === null) return;
          if (since >= MIN_DWELL_MS) {
            setStatusCopy(pendingCopy);
            pendingCopy = null;
            if (rafTimer) { clearTimeout(rafTimer); rafTimer = null; }
          } else {
            if (rafTimer) clearTimeout(rafTimer);
            rafTimer = setTimeout(() => {
              if (pendingCopy !== null) {
                setStatusCopy(pendingCopy);
                pendingCopy = null;
              }
              rafTimer = null;
            }, MIN_DWELL_MS - since);
          }
        };
        const handleFrames = (frames: ChannelChatFrame[]) => {
          for (const f of frames) {
            if (f.type === "text") {
              finalText = f.content;
              continue;
            }
            if (f.type === "clarifier") {
              finalText = f.text;
              clarifierBox.value = { replies: f.quickReplies };
              continue;
            }
            if (f.type === "reaction") {
              // Patch the optimistic user message with the reaction emoji.
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === userMsg.id
                    ? { ...m, metadata: { ...(m.metadata ?? {}), reaction: f.emoji } }
                    : m,
                ),
              );
              continue;
            }
            // status frame — supersede any pending one; dwell-gate on render.
            if (f.type !== "status") continue;
            pendingCopy = f.copy;
            pendingAt = Date.now();
            maybeRender();
          }
        };

        const reader = res.body?.getReader();
        if (reader) {
          const decoder = new TextDecoder();
          // eslint-disable-next-line no-constant-condition
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value, { stream: true });
            const { frames } = parser.feed(chunk);
            handleFrames(frames);
          }
          const tail = parser.flush();
          handleFrames(tail.frames);
        } else {
          // Body-less response — fall through to empty content.
          const txt = await res.text();
          const { frames } = parser.feed(txt);
          handleFrames(frames);
          const tail = parser.flush();
          handleFrames(tail.frames);
        }

        if (rafTimer) { clearTimeout(rafTimer); rafTimer = null; }
        setStatusCopy(null);

        const content = finalText ?? "";
        const displayContent = content
          .replace(/```agentenvoy-action\s*\n?[\s\S]*?\n?```/g, "")
          .replace(/\s*\[ACTION\].*?\[\/ACTION\]\s*/g, "")
          .trim();

        // Chitchat reactions produce no envoy bubble — finalText is null.
        if (finalText !== null) {
          const envoyMsg: ChannelMsg = {
            id: `temp-envoy-${Date.now()}`,
            role: "envoy",
            content: displayContent || content,
            createdAt: new Date().toISOString(),
          };
          setMessages((prev) => [...prev, envoyMsg]);
        }
        if (clarifierBox.value) {
          setClarifierState({
            originalText: text,
            replies: clarifierBox.value.replies,
          });
        }
        // Single polite announcement at the text-frame boundary (§2.3 N9).
        // Bumping the nonce forces the aria-live region to re-mount (via
        // `key={announcementNonce}`) so screen readers re-announce without
        // the visible text ever changing. Prevents the timestamp-in-text
        // leak that was visible to sighted users in production.
        setAnnouncementNonce((n) => n + 1);

        // Refresh messages to pick up thread cards created during streaming
        const refreshRes = await fetch("/api/channel/messages");
        if (refreshRes.ok) {
          const refreshData = await refreshRes.json();
          setMessages(refreshData.messages || []);
        }
      }
    } catch (e) {
      console.error("Send error:", e);
      const errorContent = e instanceof Error ? e.message : "Failed to send message. Please try again.";
      setMessages((prev) => [
        ...prev,
        {
          id: `error-${Date.now()}`,
          role: "system",
          content: errorContent,
          createdAt: new Date().toISOString(),
        },
      ]);
    } finally {
      setLoading(false);
      setStatusCopy(null);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // Determine placeholder text
  const placeholder = isOnboarding && inputPlaceholder
    ? inputPlaceholder
    : "Tell Envoy what to schedule...";

  if (initialLoading) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex-1 flex items-center justify-center">
          <div className="flex gap-1">
            <div className="w-1.5 h-1.5 rounded-full bg-muted animate-bounce" style={{ animationDelay: "0ms" }} />
            <div className="w-1.5 h-1.5 rounded-full bg-muted animate-bounce" style={{ animationDelay: "150ms" }} />
            <div className="w-1.5 h-1.5 rounded-full bg-muted animate-bounce" style={{ animationDelay: "300ms" }} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Messages — scroll container spans full column width so the scrollbar
          lands at the sidebar divider; inner wrapper re-centers the content. */}
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto min-h-0">
        <div className="max-w-3xl mx-auto w-full min-h-full px-4 sm:px-6 pt-5 pb-16 flex flex-col gap-1.5">
        {/* First-run welcome — calibrated users with no real chat yet.
            "Real chat" excludes onboarding-tagged messages so a user mid-
            tuning doesn't see the welcome card. When the user picks the 🔗
            primary-link card, we set `primaryLinkFlowActive` and swap to
            the tuning surface. */}
        {(() => {
          const hasRealChat = messages.some((m) => {
            const meta = m.metadata as { kind?: string } | null;
            return meta?.kind !== "onboarding";
          });
          const showWelcome =
            !hasRealChat && !loading && isCalibrated && !primaryLinkFlowActive;
          const showTuning = !loading && isCalibrated && primaryLinkFlowActive;
          return (
            <>
              {showWelcome && (
                <FirstRunWelcome
                  onSeed={(seed) => {
                    if (seed === "__primary_link_flow__") {
                      setPrimaryLinkFlowActive(true);
                      return;
                    }
                    // §1n item 6: chips auto-SUBMIT (not just fill the composer).
                    handleSend(seed);
                  }}
                />
              )}
              {showTuning && (
                <PrimaryLinkFlow
                  messages={messages}
                  onAppendMessage={(m) => setMessages((prev) => [...prev, m])}
                  browserTz={tuningCtx.browserTz}
                  hostName={tuningCtx.name}
                  meetSlug={tuningCtx.meetSlug}
                  onDismiss={() => setPrimaryLinkFlowActive(false)}
                  onPostFlowSeed={(seed) => {
                    setPrimaryLinkFlowActive(false);
                    handleSend(seed);
                  }}
                />
              )}
            </>
          );
        })()}

        {/* Continue-setup CTA — shows once primary-link tuning is complete
            and the preferences-extended flow hasn't yet started. Single
            button beneath the chat thread; dismissing the celebration
            doesn't auto-advance — the user opts in. SPEC §6.6 invariant
            still holds: this CTA bubble is rendered from React state, but
            *clicking* it kicks off a server-route flow whose turns persist. */}
        {(() => {
          if (loading || !isCalibrated) return null;
          if (primaryLinkFlowActive || extendedFlowActive) return null;
          const primaryDone = messages.some((m) => {
            const meta = m.metadata as { kind?: string; subkind?: string; terminal?: boolean } | null;
            return (
              meta?.kind === "onboarding" &&
              meta?.subkind === "primary-link-tuning" &&
              meta?.terminal === true
            );
          });
          const extendedStarted = messages.some((m) => {
            const meta = m.metadata as { kind?: string; subkind?: string } | null;
            return meta?.kind === "onboarding" && meta?.subkind === "preferences-extended";
          });
          if (!primaryDone || extendedStarted) return null;
          return (
            <div className="flex flex-col gap-2 mt-2">
              <EnvoyBubble showLabel={false}>
                Want to keep going? Fine-tune your availability (buffer,
                custom rules, evenings) and pick a theme — about 90 seconds.
              </EnvoyBubble>
              <div className="px-1">
                <button
                  type="button"
                  onClick={() => setExtendedFlowActive(true)}
                  className="text-xs px-4 py-2 rounded-full bg-indigo-600 hover:bg-indigo-500 text-white font-medium transition"
                >
                  Continue setting up →
                </button>
              </div>
            </div>
          );
        })()}

        {/* Preferences-extended continuation flow. */}
        {!loading && isCalibrated && extendedFlowActive && (
          <PreferencesExtendedFlow
            messages={messages}
            onAppendMessage={(m) => setMessages((prev) => [...prev, m])}
            onDismiss={() => setExtendedFlowActive(false)}
          />
        )}

        {messages.map((msg, i) => {
          // Skip primary-link tuning messages here ONLY while
          // PrimaryLinkFlow is mounted — it renders them itself. Once
          // the flow dismisses, they fall back to the default text-
          // bubble render path so the user can scroll back through
          // the conversation. SPEC §6.6.
          if (primaryLinkFlowActive) {
            const meta = msg.metadata as { kind?: string; subkind?: string } | null;
            if (meta?.kind === "onboarding" && meta?.subkind === "primary-link-tuning") {
              return null;
            }
          }
          if (extendedFlowActive) {
            const meta = msg.metadata as { kind?: string; subkind?: string } | null;
            if (meta?.kind === "onboarding" && meta?.subkind === "preferences-extended") {
              return null;
            }
          }
          // Thread card — skip archived
          if (msg.threadId && msg.thread) {
            if (msg.thread.archived) return null;

            const isGroup = msg.thread.isGroupEvent || msg.thread.link.mode === "group";
            const guestParticipants = (msg.thread.participants || []).filter((p) => p.role === "guest");

            const status = isGroup && guestParticipants.length > 0
              ? computeGroupThreadStatus(
                  guestParticipants.map((p) => ({ name: p.name || "Unknown", status: p.status })),
                  msg.thread.status
                )
              : computeThreadStatus({
                  status: msg.thread.status,
                  inviteeName: msg.thread.link.inviteeName,
                  guestEmail: msg.thread.link.inviteeEmail,
                });

            const canArchive =
              msg.thread.status === "agreed" ||
              msg.thread.status === "expired" ||
              (msg.thread.agreedTime && new Date(msg.thread.agreedTime) < new Date());

            return (
              <div key={msg.id} className="self-start flex flex-col gap-2 w-full max-w-[440px]">
                {msg.content && (
                  <div className="rounded-2xl px-4 py-3 text-sm leading-relaxed bg-black/5 dark:bg-white/7 rounded-bl-sm">
                    <div className="text-[10px] font-semibold uppercase tracking-wide mb-1 text-purple-400">Envoy</div>
                    <div className="whitespace-pre-wrap">{renderMarkdown(msg.content)}</div>
                  </div>
                )}
                <ThreadCard
                  title={msg.thread.title || "Thread"}
                  statusLabel={status.label}
                  statusColor={status.color}
                  activityIcon={msg.thread.link.activityIcon || undefined}
                  recurrence={(msg.thread.link as Record<string, unknown> | null | undefined)?.recurrence as Parameters<typeof ThreadCard>[0]["recurrence"]}
                  subtitle={(() => {
                    // ✏️ pencil suffix on deferred fields per 2026-04-29
                    // feedback iter 2: pencil icon replaces "(proposed)"
                    // text. Signals "editable — guest can suggest" without
                    // colliding with the 📍 map pin which is location-only.
                    const gp = (msg.thread.link as Record<string, unknown> | null | undefined)?.guestPicks as Record<string, unknown> | null | undefined;
                    const formatDeferred = gp?.format === true || Array.isArray(gp?.format);
                    const durationDeferred = gp?.duration === true || Array.isArray(gp?.duration);
                    const formatLabel = msg.thread.format === "phone" ? "Phone call" : msg.thread.format === "video" ? "Video" : msg.thread.format;
                    return [
                      formatLabel ? `${formatLabel}${formatDeferred ? " ✏️" : ""}` : null,
                      msg.thread.duration ? `${formatDuration(msg.thread.duration)}${durationDeferred ? " ✏️" : ""}` : null,
                      isGroup ? `${guestParticipants.length} participant${guestParticipants.length !== 1 ? "s" : ""}` : null,
                    ].filter(Boolean).join(" · ") || undefined;
                  })()}
                  deferralLine={(() => {
                    // "Gathering John's suggestions on the location" line —
                    // surfaces deferral state in human prose alongside the
                    // existing ✏️ pencil suffixes on the subtitle. Suppressed
                    // once the meeting is confirmed; deferrals stop mattering
                    // after a slot is locked. Date deferral is intentionally
                    // skipped (calendar widget IS the day picker).
                    if (msg.thread.status === "agreed") return undefined;
                    const gp = (msg.thread.link as Record<string, unknown> | null | undefined)?.guestPicks as Record<string, unknown> | null | undefined;
                    if (!gp) return undefined;
                    const deferred: DeferralFieldNoun[] = [];
                    if (gp.location === true) deferred.push("location");
                    if (gp.duration === true || (Array.isArray(gp.duration) && gp.duration.length > 0)) deferred.push("length");
                    if (gp.format === true || Array.isArray(gp.format)) deferred.push("format");
                    const list = formatDeferralFieldsList(deferred);
                    if (!list) return undefined;
                    const firstName = (msg.thread.link.inviteeName || "").split(/\s+/)[0] || "the guest";
                    return `🤔 Gathering ${firstName}'s suggestions on ${list}`;
                  })()}
                  inviteeName={msg.thread.link.inviteeName || undefined}
                  inviteeEmail={msg.thread.link.inviteeEmail || undefined}
                  messageCount={msg.thread._count.messages}
                  linkSlug={msg.thread.link.slug}
                  linkCode={msg.thread.link.code || undefined}
                  canArchive={!!canArchive}
                  onArchive={() => handleArchive(msg.thread!.id)}
                  onClick={() => navigateToThread(msg.thread!)}
                  isGroupEvent={isGroup}
                  participants={msg.thread.participants || undefined}
                  isVip={msg.thread.isVip ?? false}
                  guestTimezoneLabel={msg.thread.guestTimezoneLabel || undefined}
                  inviteeCount={
                    Array.isArray(msg.thread.link.inviteeNames) && msg.thread.link.inviteeNames.length > 0
                      ? msg.thread.link.inviteeNames.length
                      : msg.thread.link.inviteeName
                      ? 1
                      : 0
                  }
                />
              </div>
            );
          }

          // System message
          if (msg.role === "system") {
            if (msg.metadata?.kind === "gcal_update_proposal") {
              return (
                <div key={msg.id} className="py-2">
                  <GcalUpdateCard proposal={msg.metadata as unknown as Parameters<typeof GcalUpdateCard>[0]["proposal"]} />
                </div>
              );
            }
            // Office Hours rule_proposal (Phase 1 PR 5):
            //   Desktop = in-thread card (no backdrop, doesn't trap chat)
            //   Mobile  = bottom sheet sliding up over the thread
            // Both are mounted; Tailwind responsive utilities pick one. The
            // proposal stays editable until the host taps "Looks good"
            // (POST /api/availability-rules/confirm) or Cancel. Once
            // confirmed (`metadata.confirmed === true`) the card collapses
            // to a one-liner; the sheet is hidden.
            if (msg.metadata?.kind === "rule_proposal") {
              const meta = msg.metadata as Record<string, unknown>;
              const proposal = meta.proposal as OfficeHoursProposal | undefined;
              const alreadyConfirmed = meta.confirmed === true;
              if (!proposal) {
                return (
                  <div key={msg.id} className="text-center text-xs text-muted py-2">
                    {msg.content}
                  </div>
                );
              }
              const handleConfirmed = async () => {
                // Refresh the channel so the confirmation row + any
                // server-side follow-ups appear inline.
                try {
                  const r = await fetch("/api/channel/messages");
                  if (r.ok) {
                    const data = await r.json();
                    setMessages(data.messages || []);
                  }
                } catch (e) {
                  console.warn("[feed] refresh after rule confirm failed:", e);
                }
              };
              const handleCancelled = () => {
                // Mark the row's metadata locally so the card unmounts;
                // server keeps the row for audit. No extra fetch needed.
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === msg.id
                      ? {
                          ...m,
                          metadata: { ...(m.metadata ?? {}), dismissed: true },
                        }
                      : m,
                  ),
                );
              };
              if (alreadyConfirmed || (msg.metadata as { dismissed?: boolean })?.dismissed) {
                if (alreadyConfirmed) {
                  return (
                    <div
                      key={msg.id}
                      className="self-start w-[92%] max-w-[480px] rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-3.5 py-2.5 text-[12px] text-emerald-700 dark:text-emerald-300"
                    >
                      ✓ Created Office Hours link · {proposal.title}
                    </div>
                  );
                }
                return null;
              }
              return (
                <div key={msg.id}>
                  {/* Desktop card — inline in the thread, no backdrop */}
                  <div className="hidden md:block py-2">
                    <RuleConfirmCard
                      proposalMessageId={msg.id}
                      initialProposal={proposal}
                      onConfirmed={handleConfirmed}
                      onCancelled={handleCancelled}
                    />
                  </div>
                  {/* Mobile bottom sheet — slides up over the thread */}
                  <div className="md:hidden">
                    <RuleConfirmSheet
                      proposalMessageId={msg.id}
                      initialProposal={proposal}
                      open={true}
                      onConfirmed={handleConfirmed}
                      onDismiss={handleCancelled}
                    />
                  </div>
                </div>
              );
            }
            return (
              <div key={msg.id} className="text-center text-xs text-muted py-2">
                {msg.content}
              </div>
            );
          }

          // Chat bubble
          const isUser = msg.role === "user";
          const meetLinkMatch = !isUser ? msg.content.match(/(https?:\/\/[^\s]+\/meet\/[^\s]+)/) : null;
          const reaction = isUser ? (msg.metadata?.reaction as string | undefined) : undefined;
          // §1n item 2: suppress speaker label on consecutive same-speaker bubbles
          // (modern messaging-app convention). Treat threads / system messages as
          // structural breaks — the label always shows after one of those.
          const prev = i > 0 ? messages[i - 1] : null;
          const sameSpeakerAsPrev =
            !!prev && !prev.threadId && prev.role === msg.role && (prev.role === "user" || prev.role === "envoy");
          return (
            <div key={msg.id} className={`relative max-w-[88%] ${isUser ? "self-end" : "self-start"}`}>
              <div
                className={`rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                  isUser
                    ? "bg-purple-600 text-white rounded-br-sm"
                    : "bg-black/5 dark:bg-white/7 rounded-bl-sm"
                }`}
              >
                {!sameSpeakerAsPrev && (
                  <div
                    className={`text-[10px] font-semibold uppercase tracking-wide mb-1 ${
                      isUser ? "text-white/60" : "text-purple-400"
                    }`}
                  >
                    {isUser ? "You" : "Envoy"}
                  </div>
                )}
                <div className="whitespace-pre-wrap">{renderMarkdown(msg.content)}</div>
                {meetLinkMatch && <MeetLinkCard url={meetLinkMatch[1]} />}
              </div>
              {reaction && (
                <div className="absolute -bottom-3 right-2 bg-white dark:bg-zinc-800 border border-black/10 dark:border-white/10 rounded-full px-1.5 py-0.5 text-sm shadow-sm select-none">
                  {reaction}
                </div>
              )}
            </div>
          );
        })}

        {/* Quick replies — below the last envoy message */}
        {activeOptions && activeOptions.length > 0 && (
          <div className="self-start max-w-[72%] mt-1">
            <QuickReplies
              options={activeOptions}
              onSelect={handleQuickReply}
              disabled={optionsLocked || loading}
            />
          </div>
        )}

        {/* Intent-clarifier quick-replies — rendered after an `unclear`-tier
            turn from the chat intent router. Clicking a pill re-submits the
            original utterance with the chosen `userIntentHint`, bypassing
            the classifier. Proposal: 2026-04-21_dashboard-chat-intent-router. */}
        {clarifierState && clarifierState.replies.length > 0 && !loading && (
          <div className="self-start flex flex-wrap gap-2 mt-1">
            {clarifierState.replies.map((reply, i) => (
              <button
                key={i}
                onClick={() => {
                  const { originalText, replies } = clarifierState;
                  const chosen = replies[i];
                  setClarifierState(null);
                  handleSend(originalText, chosen.intent);
                }}
                className="px-3 py-1.5 bg-purple-500/10 hover:bg-purple-500/20 border border-purple-500/30 text-purple-300 text-xs font-medium rounded-full transition"
              >
                {reply.label}
              </button>
            ))}
          </div>
        )}

        {/* Typing indicator + progress narration status row. When the server
            has emitted a status frame, show the copy in place of the spinner.
            aria-live="off" on the visible row (see §2.3 N9) — we announce
            only the terminal "Response ready" via the hidden polite region
            below, to avoid screen-reader queue-drain on JAWS/NVDA/VoiceOver. */}
        {loading && (
          <div
            className="self-start bg-black/5 dark:bg-white/7 rounded-2xl rounded-bl-sm px-4 py-3 flex items-center gap-2"
            aria-live="off"
            role="presentation"
          >
            {statusCopy ? (
              <span className="text-xs italic text-muted">{statusCopy}</span>
            ) : (
              <>
                <div className="w-1.5 h-1.5 rounded-full bg-muted animate-bounce" style={{ animationDelay: "0ms" }} />
                <div className="w-1.5 h-1.5 rounded-full bg-muted animate-bounce" style={{ animationDelay: "150ms" }} />
                <div className="w-1.5 h-1.5 rounded-full bg-muted animate-bounce" style={{ animationDelay: "300ms" }} />
              </>
            )}
          </div>
        )}
        {/* Single polite announcement at the `type:"text"` frame boundary.
            Kept outside the loading row so removal of the row from the
            accessibility tree can't re-read stale status text.

            Remounted via `key={announcementNonce}` on every turn so screen
            readers re-announce the identical "Response ready." text. This
            replaces the earlier pattern of appending Date.now() to the
            announcement text — which leaked the timestamp to sighted users
            in production when sr-only wasn't sufficient to hide the region.
            Now the visible text is always constant; the nonce never touches
            user-visible DOM. Belt-and-suspenders: also using inline styles
            in case a CSS regression ever breaks sr-only.
        */}
        {announcementNonce > 0 && (
          <div
            key={announcementNonce}
            aria-live="polite"
            aria-atomic="true"
            className="sr-only"
            style={{
              position: "absolute",
              width: 1,
              height: 1,
              padding: 0,
              margin: -1,
              overflow: "hidden",
              clip: "rect(0, 0, 0, 0)",
              whiteSpace: "nowrap",
              borderWidth: 0,
            }}
          >
            Response ready.
          </div>
        )}

        <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Input */}
      <div className="px-4 sm:px-6 py-4 border-t border-black/5 dark:border-white/5 flex-shrink-0">
        <div className="max-w-3xl mx-auto w-full">
        {/* Calendar connection prompt — only show for calibrated users without calendar */}
        {!calendarConnected && isCalibrated && (
          <div className="flex items-center gap-3 bg-amber-50 border border-amber-200 dark:bg-amber-500/10 dark:border-amber-500/20 rounded-xl px-4 py-3 mb-3">
            <span className="text-amber-400 text-lg flex-shrink-0">&#128197;</span>
            <div className="flex-1">
              <p className="text-sm text-primary">Connect your Google Calendar</p>
              <p className="text-xs text-muted">Envoy needs access to your schedule to find available times.</p>
            </div>
            <a
              href="/dashboard/account"
              className="px-3 py-1.5 bg-amber-600 hover:bg-amber-500 text-white text-xs font-medium rounded-lg transition flex-shrink-0"
            >
              Connect
            </a>
          </div>
        )}
        <div className="flex gap-2 items-end">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            rows={1}
            className="flex-1 bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl px-4 py-3 text-sm text-primary placeholder-muted resize-none outline-none focus:border-purple-500/50 min-h-[44px] max-h-[120px]"
          />
          <button
            onClick={() => handleSend()}
            disabled={!input.trim() || loading}
            className="w-11 h-11 rounded-xl bg-purple-600 text-white flex items-center justify-center flex-shrink-0 hover:bg-purple-700 transition-colors disabled:opacity-30 disabled:cursor-default text-lg"
          >
            &uarr;
          </button>
        </div>
        <div className="mt-2 flex justify-end">
          <SendFeedbackLink />
        </div>
        </div>
      </div>
    </div>
  );
}
