"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useTheme } from "next-themes";
import { computeAutoTheme } from "@/components/theme-preference-sync";
import { useRouter } from "next/navigation";
import ThreadCard from "./thread-card";
import { ChannelChatStreamParser, type ChannelChatFrame } from "@/lib/channel-chat-stream";
import { computeThreadStatus, computeGroupThreadStatus } from "@/lib/thread-status";
import { formatDuration } from "@/lib/format-duration";
import { formatDeferralFieldsList, type DeferralFieldNoun } from "@/agent/greetings/registry";
import { PrimaryLinkFlow } from "./onboarding/primary-link-flow";
import { PreferencesExtendedFlow } from "./onboarding/preferences-extended-flow";
import { DormantReturnBubble, type DormantContext } from "./onboarding/DormantReturnBubble";
import { tuningInProgress } from "@/lib/onboarding/dormant-eligibility";
import { GcalUpdateCard } from "./gcal-update-card";
// RuleConfirmCard / RuleConfirmSheet imports retired 2026-05-03 — the
// bookable-link create flow is now chat-driven (proposal §3.8). The
// `BookableLinkProposal` type is still imported because legacy
// `rule_proposal` system messages pre-deploy use it for display.
import type { BookableLinkProposal } from "./onboarding/rule-form-fields";
import { SendFeedbackLink } from "./send-feedback";
import { ThumbsDownFeedback } from "./thumbs-down-feedback";
import { useOAuthSignIn } from "./oauth/use-oauth-signin";
import { canNativeShare, shareInvite } from "@/lib/share-invite";
import { TurnCostOverlay } from "./turn-cost-overlay";

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
  /** True when the user has explicitly Submitted their calendar picker.
   *  Gates the posture-readback bubble and primary-link card in
   *  FirstRunWelcome — until confirmed, only the welcome + picker show. */
  calendarSelectionConfirmed: boolean;
  /** Drift summary for returning-dormant hosts. Null for all other variants. */
  dormantContext: DormantContext | null;
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

/** Standalone "your primary link is ready" card — renders below the
 *  calendar picker in the first-run welcome (after the calendar-bullets
 *  message has been written to chat by `/api/onboarding/calibrate-opener`).
 *  Indigo-ringed, uppercase micro-label header, URL + Copy in a tinted
 *  inset row.
 *
 *  HOTFIX-2 (2026-05-05): the sibling `<PostureBubble>` it used to render
 *  next to was removed — the four Google-seed bullets are now persisted
 *  as the FIRST Envoy ChannelMessage in the channel (subkind:
 *  "calibrate-seed-info") so they survive `hasRealChat` flipping and
 *  survive reload. See `src/lib/onboarding/calibrate-seed-info-text.ts`. */
function PrimaryLinkReadyCard({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="self-start w-full max-w-lg bg-surface border border-indigo-500/40 rounded-xl px-3.5 py-3 flex flex-col gap-2">
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted">
        <span aria-hidden="true">🔗</span>
        Primary link
      </div>
      <p className="text-sm text-primary leading-relaxed">
        Okay, I&rsquo;ve got what I need, and we&rsquo;ve set you up with your primary bookable meeting link. This is a link you can copy and share with anyone — it lets them book time with you using your primary availability.
      </p>
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
function CalendarPickerBubble({
  showLabel,
  alreadyConfirmed,
  onConfirm,
}: {
  showLabel?: boolean;
  /** When true, the picker renders in a read-only summary mode (no Submit). */
  alreadyConfirmed?: boolean;
  /** Fires after a successful Submit (server-side confirm + schedule warmup). */
  onConfirm?: () => void;
}) {
  const [calendars, setCalendars] = useState<ConnectedCalendar[] | null>(null);
  const [activeIds, setActiveIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [submitting, setSubmitting] = useState(false);

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

  // Auto-confirm for users with 0 or 1 calendar — there's nothing to pick.
  // POSTs the confirm flag too so the parent's state stays in sync after
  // reload. Best-effort (POST failure is harmless; parent re-confirms).
  useEffect(() => {
    if (alreadyConfirmed) return;
    if (!calendars) return;
    if (calendars.length >= 2) return;
    let cancelled = false;
    void fetch("/api/me/calendar-confirmation", { method: "POST" })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) onConfirm?.();
      });
    return () => { cancelled = true; };
  }, [calendars, alreadyConfirmed, onConfirm]);

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

  // Sort: Primary first (activeIds[0]), then Included calendars in their
  // saved order, then Ignored calendars last. Stable across re-renders so
  // the user's selected primary doesn't bounce around as they pick.
  const sortedCalendars = (() => {
    const byId = new Map(calendars.map((c) => [c.id, c]));
    const out: ConnectedCalendar[] = [];
    for (const id of activeIds) {
      const cal = byId.get(id);
      if (cal) out.push(cal);
    }
    for (const cal of calendars) {
      if (!activeIds.includes(cal.id)) out.push(cal);
    }
    return out;
  })();

  async function handleSubmit() {
    if (submitting) return;
    setSubmitting(true);
    try {
      // Stamp the explicit confirmation flag — drives the next render in
      // FirstRunWelcome.
      await fetch("/api/me/calendar-confirmation", { method: "POST" }).catch(() => {});
      // Warm the schedule cache so the calendar widget has events ready
      // before the next bubble renders. Best-effort — failure here just
      // means the widget will refetch later.
      await fetch("/api/tuner/schedule").catch(() => {});
    } finally {
      setSubmitting(false);
      // Tell AvailabilityPanel to refetch its events (the right-side
      // calendar widget) and tell Feed to scroll to the new content.
      // Single event covers both; both listeners are wired in their own
      // useEffects so they don't have to know about each other.
      try {
        window.dispatchEvent(new CustomEvent("envoy:calendar-confirmed"));
      } catch {
        // SSR / no-window guard
      }
      onConfirm?.();
    }
  }

  return (
    <EnvoyBubble showLabel={showLabel}>
        <div className="mb-2">
          {alreadyConfirmed
            ? <>I&rsquo;m reading from your selected Google calendar(s). You can change this any time.</>
            : <>I use your Google calendar(s) to determine your availability and send invites. You&rsquo;ve got {calendars.length} Google calendars — your primary is at the top. Add or change as needed, then hit Submit.</>}
        </div>
        <ul className="space-y-1.5">
          {sortedCalendars.map((cal) => {
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
                  disabled={busy || submitting || alreadyConfirmed}
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
        {!alreadyConfirmed && (
          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={handleSubmit}
              disabled={submitting || busy}
              className="text-xs px-4 py-1.5 rounded-full bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white font-medium transition"
            >
              {submitting ? "Loading your calendar…" : "Submit"}
            </button>
            {submitting && (
              <span className="text-[11px] text-muted">Reading events from Google…</span>
            )}
          </div>
        )}
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

function FirstRunWelcome({
  onSeed,
  messages: msgList,
  onCalendarConfirmed,
}: {
  onSeed: (seed: string) => void;
  messages: ChannelMsg[];
  /** Fired exactly once after the picker bubble's submit handler completes
   *  (or auto-confirm for single-calendar users). Parent uses this seam to
   *  dispatch a synthetic host message that classifies to
   *  `recalibrate.first-time` — auto-launching the conversational
   *  calibration arc per `2026-05-05_conversational-onboarding-vision` §3.2.
   *  Only fires on the active-submit transition, not on a fresh page load
   *  where `calendarSelectionConfirmed` was already true server-side. */
  onCalendarConfirmed?: () => void;
}) {
  const [posture, setPosture] = useState<SeededPosture | null>(null);
  // Local "calendar confirmed" state — initial value comes from
  // posture.calendarSelectionConfirmed once the fetch lands; flips to true
  // when the user clicks Submit on the picker. Once true, the rest of the
  // first-run flow (posture readback + primary link card + tuning CTA)
  // unlocks. Single-calendar users auto-confirm via an effect inside
  // CalendarPickerBubble.
  const [calendarConfirmed, setCalendarConfirmed] = useState(false);

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
          calendarSelectionConfirmed: !!data.calendarSelectionConfirmed,
          dormantContext: (data.dormantContext as DormantContext | null) ?? null,
        });
        if (data.calendarSelectionConfirmed) setCalendarConfirmed(true);
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

  // Returning-dormant: show the DormantReturnBubble unless a PrimaryLinkFlow
  // is currently in progress (Q3 guard — auto-resumed PrimaryLinkFlow wins).
  if (posture.welcomeVariant === "returning-dormant") {
    // Q3 guard: if tuning is in progress, yield to the tuning UI.
    // The outer render tree already handles showing PrimaryLinkFlow;
    // we just don't overlay the dormant bubble on top of it.
    const guardActive = tuningInProgress(msgList);
    if (guardActive || !posture.dormantContext) return null;
    return (
      <DormantReturnBubble
        name={posture.name}
        dormantContext={posture.dormantContext}
        onRetune={(msg) => onSeed(msg)}
        onDismiss={() => {
          // No DB write needed — posture re-fetch on next visit will
          // determine variant again based on message recency.
        }}
      />
    );
  }

  // Guest-first: user came in via someone else's link, signed up,
  // landed on Home. Acknowledge the prior interaction; skip the
  // posture readback (they saw Envoy from the guest side already).
  if (posture.welcomeVariant === "guest-first") {
    return (
      <GuestFirstVariant posture={posture} onSeed={onSeed} />
    );
  }

  // first-run (default): full intro.
  // Render order is gated on calendarConfirmed:
  //   1. Always: H1 + welcome bubble + calendar picker
  //   2. After Submit (or auto-confirm for <2 calendars): "Great, I now have
  //      what I need" bubble + posture readback + primary link card + tuning CTA
  return (
    <div className="flex-1 flex flex-col justify-center py-6 gap-4">
      {/* Welcome — H1 for the page itself. Pin at top, not in the chat
          column, so it reads as a page header rather than another bubble. */}
      <h1 className="text-xl sm:text-2xl font-semibold text-primary px-1">
        🎉 Welcome to AgentEnvoy.
      </h1>

      {/* Intro bubble — brand pitch only. Posture readback now lives below,
          gated on the calendar-picker Submit. */}
      <EnvoyBubble>
          <div className="mb-2">
            👋 Hey {firstNameOf(posture.name)} — I&rsquo;m Envoy. I run{" "}
            <strong className="font-semibold">personalized</strong>{" "}
            scheduling on your behalf so you don&rsquo;t have to chase
            calendars. Share a link, your invitee chats with me, I work out
            a time tailored to each guest.
          </div>
          <div>
            First, let me know which Google calendar(s) I should read for
            your availability. Once you submit, I&rsquo;ll load your events
            and we&rsquo;ll keep going.
          </div>
      </EnvoyBubble>

      {/* Calendar picker — always shown. Self-hides for users with <2
          calendars and auto-fires onConfirm. Submit button confirms +
          warms the schedule cache. Same speaker, label suppressed.
          ── PR-B (conversational-onboarding §3.2): on the active-submit
          transition, fire `onCalendarConfirmed` so the parent can dispatch
          the synthetic recalibrate.first-time trigger. Guarded against
          double-fire from the single-calendar auto-confirm effect. */}
      <CalendarPickerBubble
        showLabel={false}
        alreadyConfirmed={calendarConfirmed}
        onConfirm={() => {
          if (calendarConfirmed) return;
          setCalendarConfirmed(true);
          onCalendarConfirmed?.();
        }}
      />

      {/* Everything below is gated on the Submit click (or auto-confirm
          for single-calendar users). The previous "Take 2 minutes / Continue
          tuning my preferences" CTA + cold-mount auto-trigger of
          <PrimaryLinkFlow> was REMOVED in PR-B per the 2026-05-05
          conversational-onboarding proposal (Author Response B3 — full
          retirement of the deterministic 5-step flow as the cold-mount
          default; Calibrate is the sole path). The parent now dispatches a
          synthetic recalibrate.first-time message via `onCalendarConfirmed`,
          and the conversational arc opens the next chat turn.
          <PrimaryLinkFlow> auto-resume continues to work for users who were
          mid-flow when this deployed — that path lives in the
          `loadMessages` effect of the parent (driven by `tuningInProgress`
          on the message list, untouched by this PR). */}
      {/* HOTFIX-2 (2026-05-05): the "Great — I now have what I need" bubble
          and `<PostureBubble>` (Google-seed bullets) used to render here on
          calendarConfirmed. Both have been promoted to a persisted Envoy
          ChannelMessage written by `/api/onboarding/calibrate-opener`
          (subkind: "calibrate-seed-info") so they survive the moment
          `hasRealChat` flips and `<FirstRunWelcome>` unmounts. The
          `PrimaryLinkReadyCard` stays here — it's a distinct affordance
          (link CTA), not the seed-bullets bubble. */}
      {calendarConfirmed && posture.meetSlug && (
        <PrimaryLinkReadyCard url={`agentenvoy.ai/meet/${posture.meetSlug}`} />
      )}
    </div>
  );
}

// ── Calibrate choice panel ───────────────────────────────────────────────

/**
 * Two-path choice shown after the seed-info bubble lands in the feed.
 * Replaces the old "auto-launch calibration opener" behaviour — the host
 * now explicitly picks depth:
 *   (a) "This is good enough to start" → asks one more question (theme),
 *       then closes onboarding.
 *   (b) "Customize my preferences (recommended)" → writes the calibrate-opener
 *       message and proceeds to the full conversational calibration arc.
 *
 * Not persisted — ephemeral UI rendered from local state. A reload after
 * the seed-info POST but before a choice is harmless: the panel re-appears
 * from the same message condition (`hasSeedInfo && !hasOpener`).
 */
type CalibratePanelStage = "choice" | "theme" | "done";

function CalibrateChoicePanel({
  onChoiceB,
  onDone,
}: {
  /** Called when the host picks path (b). Parent posts calibrate-proceed. */
  onChoiceB: () => void;
  /** Called after path (a) completion — parent marks choice done. */
  onDone: () => void;
}) {
  const [stage, setStage] = useState<CalibratePanelStage>("choice");
  const [savingTheme, setSavingTheme] = useState(false);
  const { setTheme } = useTheme();

  async function handleThemePick(mode: "light" | "dark" | "auto") {
    if (savingTheme) return;
    setSavingTheme(true);
    if (mode === "auto") {
      setTheme(computeAutoTheme(new Date().getHours()));
    } else {
      setTheme(mode);
    }
    try {
      await fetch("/api/me/ui-prefs", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ themeMode: mode }),
      });
    } catch {
      // Swallow — local theme is already applied
    } finally {
      setSavingTheme(false);
    }
    setStage("done");
    setTimeout(() => onDone(), 1200);
  }

  if (stage === "done") {
    return (
      <EnvoyBubble showLabel={false}>
        You&rsquo;re all set — your primary link is ready to share. Ask me anything.
      </EnvoyBubble>
    );
  }

  if (stage === "theme") {
    return (
      <div className="flex flex-col gap-3">
        <EnvoyBubble showLabel={false}>
          One quick thing — which display mode do you prefer?
        </EnvoyBubble>
        <div className="flex flex-wrap gap-2 px-1">
          {(
            [
              { label: "☀️ Light", value: "light" },
              { label: "🌙 Dark", value: "dark" },
              { label: "💻 Auto", value: "auto" },
            ] as const
          ).map(({ label, value }) => (
            <button
              key={value}
              type="button"
              disabled={savingTheme}
              onClick={() => handleThemePick(value)}
              className="text-xs px-3 py-1.5 rounded-full border border-secondary/60 hover:border-purple-500/60 hover:bg-purple-500/5 text-primary transition disabled:opacity-50"
            >
              {label}
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap gap-2 px-1">
      <button
        type="button"
        onClick={() => setStage("theme")}
        className="text-xs px-3 py-1.5 rounded-full border border-secondary/60 hover:border-purple-500/60 hover:bg-purple-500/5 text-primary transition"
      >
        This is good enough to start
      </button>
      <button
        type="button"
        onClick={onChoiceB}
        className="text-xs px-3 py-1.5 rounded-full bg-purple-600 hover:bg-purple-500 text-white font-medium transition"
      >
        Customize my preferences{" "}
        <span className="opacity-75">(recommended)</span>
      </button>
    </div>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────

/** Render **bold**, _italic_, and [link](url) markdown in message content.
 *  Italic support added in PR-B (conversational-onboarding) so the
 *  recalibrate.first-time fragment's worked-example sentence renders in
 *  italics per Q5b — visually separates the user-could-say demonstration
 *  from Envoy's voice. Mirrors `renderTuningMarkdown` in primary-link-flow.tsx. */
function renderMarkdown(text: string): React.ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*|_[^_\n]+_|\[[^\]]+\]\([^)]+\))/g);
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={i} className="font-semibold">{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("_") && part.endsWith("_") && part.length > 2) {
      return <em key={i} className="text-secondary">{part.slice(1, -1)}</em>;
    }
    const linkMatch = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (linkMatch) {
      return <a key={i} href={linkMatch[2]} className="text-purple-400 hover:text-purple-300 underline">{linkMatch[1]}</a>;
    }
    return <span key={i}>{part}</span>;
  });
}

// B4: exported so dispatch-stream.ts bookableMeta cast site can reference it.
export type BookableMeta = {
  title?: string;
  linkUrl?: string;
  daysOfWeek?: number[];
  timeStart?: string;
  timeEnd?: string;
  durationMinutes?: number;
  format?: string;
};

function BookableLinkCard({ url, meta }: { url: string; meta?: BookableMeta }) {
  const DAY_ABBR = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const days = meta?.daysOfWeek?.length ? meta.daysOfWeek.map((d) => DAY_ABBR[d]).join(", ") : "";
  const fmtTime = (t: string) => {
    const [h, m] = t.split(":").map(Number);
    const hour = h % 12 || 12;
    const ampm = h < 12 ? "am" : "pm";
    return m === 0 ? `${hour}${ampm}` : `${hour}:${String(m).padStart(2, "0")}${ampm}`;
  };
  const timeWindow =
    meta?.timeStart && meta?.timeEnd ? `${fmtTime(meta.timeStart)}–${fmtTime(meta.timeEnd)}` : "";
  const duration = meta?.durationMinutes ? `${meta.durationMinutes} min` : "";
  const format =
    meta?.format === "video"
      ? "Video"
      : meta?.format === "phone"
        ? "Phone"
        : meta?.format === "in-person"
          ? "In person"
          : "";
  const summaryParts = [days, timeWindow, duration, format].filter(Boolean);
  return (
    <div className="rounded-lg border border-DEFAULT bg-surface-inset p-3 flex flex-col gap-2 text-sm">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium px-1.5 py-0.5 rounded bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300">
          Bookable
        </span>
        <span className="font-medium">{meta?.title ?? "Bookable Link"}</span>
      </div>
      {summaryParts.length > 0 && (
        <div className="text-xs text-secondary">{summaryParts.join(" · ")}</div>
      )}
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted truncate flex-1">{url}</span>
        <button
          onClick={() => navigator.clipboard.writeText(url)}
          className="text-xs text-secondary hover:text-primary"
        >
          Copy
        </button>
      </div>
    </div>
  );
}

function MeetLinkCard({ url, topic, kind }: { url: string; topic?: string; kind?: "bookable" | "recurring" }) {
  const [copied, setCopied] = useState(false);
  const [shareSupported, setShareSupported] = useState(false);
  useEffect(() => {
    setShareSupported(canNativeShare());
  }, []);
  return (
    <div className="mt-3 bg-purple-500/10 border border-purple-500/20 rounded-lg p-3 flex items-center gap-3">
      {kind === "bookable" && (
        <span className="flex-shrink-0 text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-300 border border-purple-500/30">
          Bookable
        </span>
      )}
      {kind === "recurring" && (
        <span className="flex-shrink-0 text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full bg-blue-500/20 text-blue-300 border border-blue-500/30">
          ↻ Recurring
        </span>
      )}
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
    // PR-E: "event_action" is the new cluster name; "schedule" kept for stale-data compat.
    replies: Array<{ label: string; intent: "event_action" | "inquire" | "schedule" }>;
  } | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [calendarConnected, setCalendarConnected] = useState(true);
  const [isCalibrated, setIsCalibrated] = useState(true);
  // Admin flag — fetched once on mount from /api/me/ui-prefs.
  // Enables TurnCostOverlay on unified-agent turns (Day 6 telemetry).
  const [isAdmin, setIsAdmin] = useState(false);
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
  // True once the host has made their choice via CalibrateChoicePanel (path a
  // or b). Suppresses the panel even if the opener hasn't landed yet (path b
  // is mid-flight). Resets to false on page reload — the panel re-appears
  // until the opener message is written (path b) or the user's first real
  // message lands (hasRealChat).
  const [calibrateChoiceMade, setCalibrateChoiceMade] = useState(false);
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
  // The legacy 9-phase /api/onboarding/chat machine was deleted 2026-05-04
  // — cold sign-up has been seed-everything since 2026-04-26. New users
  // are calibrated at signup (`events.createUser`) and land directly on
  // <FirstRunWelcome>. Tuning is opt-in via PrimaryLinkFlow /
  // PreferencesExtendedFlow, both chat-native and message-persisted.
  const pendingSendRef = useRef<string | null>(null);
  // Tuning-flow composer bridge: PrimaryLinkFlow registers a submit fn here
  // when a freetext step is active (phone, zoom, custom hours). handleSend
  // routes to it instead of /api/channel/chat so the main composer works
  // seamlessly as the input for those steps.
  const tuningComposerRef = useRef<((text: string) => void) | null>(null);
  const [tuningComposerPlaceholder, setTuningComposerPlaceholder] = useState<string | null>(null);

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
      const autoSubmit = sessionStorage.getItem("envoy:pending-autosubmit") === "true";
      if (pending) {
        sessionStorage.removeItem("envoy:pending-prefill");
        sessionStorage.removeItem("envoy:pending-autosubmit");
        if (autoSubmit) {
          // Auto-submit: use pendingSendRef pattern (same as post-onboarding
          // quick-reply) so the input state settles before handleSend fires.
          pendingSendRef.current = pending;
        }
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
          const msgs: ChannelMsg[] = data.messages || [];
          setMessages(msgs);
          if (data.calendarConnected !== undefined) setCalendarConnected(data.calendarConnected);
          if (data.lastCalibratedAt !== undefined) setIsCalibrated(!!data.lastCalibratedAt);
          // Detect in-progress tuning flows synchronously so the welcome card
          // never flashes before the tuning UI on resume. The auto-resume
          // useEffect below is a no-op after this fires.
          const hasTuning = msgs.some((m) => {
            const meta = m.metadata as { kind?: string; subkind?: string } | null;
            return meta?.kind === "onboarding" && meta?.subkind === "primary-link-tuning";
          });
          if (hasTuning) {
            const tuningDone = msgs.some((m) => {
              const meta = m.metadata as { subkind?: string; terminal?: boolean } | null;
              return meta?.subkind === "primary-link-tuning" && meta?.terminal === true;
            });
            if (!tuningDone) setPrimaryLinkFlowActive(true);
          }
          const hasExtended = msgs.some((m) => {
            const meta = m.metadata as { kind?: string; subkind?: string } | null;
            return meta?.kind === "onboarding" && meta?.subkind === "preferences-extended";
          });
          if (hasExtended) {
            const extendedDone = msgs.some((m) => {
              const meta = m.metadata as { subkind?: string; terminal?: boolean } | null;
              return meta?.subkind === "preferences-extended" && meta?.terminal === true;
            });
            if (!extendedDone) setExtendedFlowActive(true);
          }
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

  // Fetch admin flag once for TurnCostOverlay visibility.
  useEffect(() => {
    fetch("/api/me/ui-prefs")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (data?.isAdmin) setIsAdmin(true); })
      .catch(() => {});
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

  // Auto-send after a sessionStorage prefill (e.g. event-links cross-route nav).
  // Gated on !initialLoading: without this guard, handleSend fires while the
  // history fetch is still in-flight. The history fetch then overwrites the
  // optimistic user message, leaving the envoy response appearing before the
  // request until the post-turn refresh corrects the order.
  useEffect(() => {
    if (initialLoading) return;
    if (pendingSendRef.current && input === pendingSendRef.current) {
      pendingSendRef.current = null;
      handleSend();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input, initialLoading]);

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

  // Scroll to bottom when the user submits the calendar picker. The new
  // bubbles ("Great — I now have what I need", posture, primary link,
  // tuning CTA) reveal *below* the picker, so without a nudge they land
  // off-screen below the composer. Force-pin to bottom and scroll there.
  useEffect(() => {
    function onConfirmed() {
      stickToBottomRef.current = true;
      // Wait two RAFs to let the React render + ResizeObserver land before
      // measuring scrollHeight; otherwise we scroll to the height before
      // the new bubbles inflated.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const c = scrollContainerRef.current;
          if (c) c.scrollTop = c.scrollHeight;
        });
      });
    }
    window.addEventListener("envoy:calendar-confirmed", onConfirmed);
    return () => window.removeEventListener("envoy:calendar-confirmed", onConfirmed);
  }, []);

  // PR-B telemetry seam (Author Response N2): record when the posture
  // readback first paints in the FirstRunWelcome flow so we can measure
  // `time_from_posture_render_to_first_keystroke`. Single-fire. Stamped
  // from the `onCalendarConfirmed` callback below; read on first
  // keystroke. Success criterion: <10% within 200ms (animation isn't
  // being skipped past). Failure: >50% within 200ms (animation wasting
  // time; revisit duration). Logged via console for PR-B; no client-side
  // product-event pipeline exists today (a future PR-E telemetry pass
  // can swap in a beacon).
  const posturePaintedAtRef = useRef<number | null>(null);
  const firstKeystrokeLoggedRef = useRef(false);

  // Auto-resize textarea
  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    const el = e.target;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 120) + "px";
    if (
      !firstKeystrokeLoggedRef.current &&
      posturePaintedAtRef.current !== null
    ) {
      firstKeystrokeLoggedRef.current = true;
      const elapsedMs = Date.now() - posturePaintedAtRef.current;
      console.info("[telemetry] onboarding.first_keystroke_after_posture", {
        time_from_posture_render_to_first_keystroke_ms: elapsedMs,
      });
    }
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
    // PR-E: "event_action" is the new cluster hint name; "schedule" for legacy compat.
    intentHint?: "event_action" | "inquire" | "schedule",
  ) => {
    const text = (overrideText ?? input).trim();
    if (!text || loading) return;
    // Any new turn invalidates previous clarifier quick-replies.
    setClarifierState(null);

    // ── Tuning-flow freetext intercept ────────────────────────────────────
    // When a primary-link tuning step expects freetext (phone, zoom, custom
    // hours), PrimaryLinkFlow registers a submit fn via onComposerBridge.
    // Route here instead of /api/channel/chat — PrimaryLinkFlow handles its
    // own saving state and adds the optimistic user bubble.
    if (tuningComposerRef.current) {
      setInput("");
      if (textareaRef.current) textareaRef.current.style.height = "auto";
      tuningComposerRef.current(text);
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
            // PR-E: "event_action" is the new cluster name; "schedule" kept for stale-data compat.
    replies: Array<{ label: string; intent: "event_action" | "inquire" | "schedule" }>;
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

  // Determine placeholder text — tuning freetext steps override the default
  const placeholder = tuningComposerPlaceholder
    ?? "Tell Envoy what to schedule...";

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
          const showTuning = isCalibrated && primaryLinkFlowActive;
          return (
            <>
              {showWelcome && (
                <FirstRunWelcome
                  messages={messages}
                  onSeed={(seed) => {
                    if (seed === "__primary_link_flow__") {
                      setPrimaryLinkFlowActive(true);
                      return;
                    }
                    // §1n item 6: chips auto-SUBMIT (not just fill the composer).
                    handleSend(seed);
                  }}
                  onCalendarConfirmed={() => {
                    // HOTFIX 2026-05-05: replaced PR-B synthetic-message
                    // dispatch ("I just connected my calendar — can we set
                    // things up?") which (a) classified to chat/manage_setup
                    // instead of recalibrate, and (b) bypassed the first-time
                    // fragment. Now we POST to /api/onboarding/calibrate-opener
                    // which persists the deterministic warm anchor opener as
                    // an Envoy ChannelMessage. The next host turn is
                    // force-routed to recalibrate.first-time by the dispatch
                    // override in app/api/channel/chat/route.ts (which keys
                    // The endpoint now writes seed-info only. The host then
                    // sees CalibrateChoicePanel and picks:
                    //   (a) "Good enough" → theme question → done
                    //   (b) "Customize" → calibrate-proceed writes the opener
                    //       → dispatch override routes to recalibrate.first-time
                    //
                    // Q5 beat: a 300ms posture-readback pause, then we set
                    // `loading=true` while the endpoint persists seed-info
                    // — that renders the existing typing-indicator bubble
                    // (the same animation used in the dashboard and deal
                    // room — three bouncing dots, ~line 2073 below). The
                    // beat also stamps `posturePaintedAtRef` for Author
                    // Response N2 telemetry
                    // (`time_from_posture_render_to_first_keystroke`).
                    const POSTURE_TO_DISPATCH_BEAT_MS = 300;
                    posturePaintedAtRef.current = Date.now();
                    setTimeout(async () => {
                      setLoading(true);
                      try {
                        const res = await fetch(
                          "/api/onboarding/calibrate-opener",
                          { method: "POST" },
                        );
                        if (!res.ok) {
                          console.error(
                            "[feed] calibrate-opener POST failed",
                            res.status,
                          );
                          return;
                        }
                        // Endpoint writes seed-info only. Append seedInfo;
                        // ignore opener field (now null/absent). Back-compat:
                        // if an older server returns a full pair (stale deploy
                        // window), still append both so existing users aren't
                        // broken mid-session.
                        const data = (await res.json()) as {
                          seedInfo?: ChannelMsg | null;
                          opener?: ChannelMsg | null;
                          message?: ChannelMsg | null;
                        };
                        const toAppend: ChannelMsg[] = [];
                        if (data?.seedInfo) toAppend.push(data.seedInfo);
                        // Back-compat only: stale server returned opener too
                        if (data?.opener) toAppend.push(data.opener);
                        if (toAppend.length === 0 && data?.message) {
                          toAppend.push(data.message);
                        }
                        if (toAppend.length > 0) {
                          // Idempotency: if any of these were already
                          // persisted (e.g., picker fired twice on a slow
                          // network) the server returns existing rows —
                          // don't append duplicates to local state.
                          setMessages((prev) => {
                            const seen = new Set(prev.map((m) => m.id));
                            const fresh = toAppend.filter((m) => !seen.has(m.id));
                            return fresh.length > 0 ? [...prev, ...fresh] : prev;
                          });
                        }
                      } catch (err) {
                        console.error("[feed] calibrate-opener error", err);
                      } finally {
                        setLoading(false);
                      }
                    }, POSTURE_TO_DISPATCH_BEAT_MS);
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
                  onComposerBridge={(state) => {
                    tuningComposerRef.current = state?.submit ?? null;
                    setTuningComposerPlaceholder(state?.placeholder ?? null);
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
                  <>
                    <div className="rounded-2xl px-4 py-3 text-sm leading-relaxed bg-black/5 dark:bg-white/7 rounded-bl-sm">
                      <div className="text-[10px] font-semibold uppercase tracking-wide mb-1 text-purple-400">Envoy</div>
                      <div className="whitespace-pre-wrap">{renderMarkdown(msg.content)}</div>
                    </div>
                    <div className="flex justify-end -mt-1">
                      <ThumbsDownFeedback
                        sessionId={msg.thread.id}
                        messageContent={msg.content}
                      />
                    </div>
                  </>
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
                <div className="flex justify-end">
                  <ThumbsDownFeedback
                    sessionId={msg.thread.id}
                    messageContent={msg.content || msg.thread.title || "Session"}
                  />
                </div>
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
            // Office Hours rule_proposal: retired from the chat-create flow
            // 2026-05-03 (proposal `2026-05-03_recurring-and-office-hours-widgets`
            // §3.8). The propose-then-confirm pattern was replaced by a
            // chat-driven model: the office_hours action emits → handler
            // commits the rule → composer narrates the full config in prose
            // → host iterates via natural language ("actually 45 min").
            // Any in-flight `rule_proposal` rows that predate the deploy
            // render as a benign one-liner (the URL system message that
            // follows the action result already carries the link).
            if (msg.metadata?.kind === "rule_proposal") {
              const meta = msg.metadata as Record<string, unknown>;
              const proposal = meta.proposal as BookableLinkProposal | undefined;
              const alreadyConfirmed = meta.confirmed === true;
              if (alreadyConfirmed && proposal) {
                return (
                  <div
                    key={msg.id}
                    className="self-start w-[92%] max-w-[480px] rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-3.5 py-2.5 text-[12px] text-emerald-700 dark:text-emerald-300"
                  >
                    ✓ Created Bookable Link · {proposal.title}
                  </div>
                );
              }
              // Pre-confirm row from a legacy session — collapse to a
              // benign one-liner. The host's chat-driven path produces the
              // canonical narration via the LLM directly, so this is dead
              // code for any rule_proposal created post-2026-05-03.
              return null;
            }
            return (
              <div key={msg.id} className="text-center text-xs text-muted py-2">
                {msg.content}
              </div>
            );
          }

          // Chat bubble
          const isUser = msg.role === "user";
          // Prefer URL persisted to metadata (post-2026-05-06 plumbing);
          // fall back to the content regex for legacy rows whose envoy turn
          // was written before `metadata.linkUrl` existed.
          const meetLinkMetaUrl = !isUser
            ? ((msg.metadata as Record<string, unknown> | null)?.linkUrl as string | undefined)
            : undefined;
          const meetLinkRegexMatch = !isUser
            ? msg.content.match(/(https?:\/\/[^\s]+\/meet\/[^\s]+)/)
            : null;
          const meetLinkUrl =
            meetLinkMetaUrl ?? (meetLinkRegexMatch ? meetLinkRegexMatch[1] : undefined);
          const meetLinkKind = (msg.metadata as Record<string, unknown> | null)?.linkKind as "bookable" | "recurring" | undefined;
          const reaction = isUser ? (msg.metadata?.reaction as string | undefined) : undefined;
          // §1n item 2: suppress speaker label on consecutive same-speaker bubbles
          // (modern messaging-app convention). Treat threads / system messages as
          // structural breaks — the label always shows after one of those.
          const prev = i > 0 ? messages[i - 1] : null;
          const sameSpeakerAsPrev =
            !!prev && !prev.threadId && prev.role === msg.role && (prev.role === "user" || prev.role === "envoy");
          return (
            <div key={msg.id} className={`flex items-end gap-1 ${isUser ? "self-end justify-end" : "self-start justify-start"} max-w-[88%]`}>
              <div className="flex flex-col">
                <div className="relative">
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
                    {meetLinkUrl && meetLinkKind === "bookable" ? (
                      <BookableLinkCard
                        url={meetLinkUrl}
                        meta={
                          (msg.metadata as Record<string, unknown> | null)?.bookableMeta as
                            | BookableMeta
                            | undefined
                        }
                      />
                    ) : meetLinkUrl ? (
                      <MeetLinkCard url={meetLinkUrl} kind={meetLinkKind} />
                    ) : null}
                  </div>
                  {reaction && (
                    <div className="absolute -bottom-3 right-2 bg-white dark:bg-zinc-800 border border-black/10 dark:border-white/10 rounded-full px-1.5 py-0.5 text-sm shadow-sm select-none">
                      {reaction}
                    </div>
                  )}
                </div>
                {!isUser && (
                  <TurnCostOverlay
                    metadata={msg.metadata}
                    isAdmin={isAdmin}
                  />
                )}
              </div>
              {!isUser && (
                <ThumbsDownFeedback
                  sessionId={msg.threadId ?? null}
                  messageContent={msg.content}
                />
              )}
            </div>
          );
        })}

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

        {/* Calibrate choice panel — two-path choice shown after seed-info
            lands. Condition: seed-info present, no opener yet, not loading,
            host hasn't chosen yet this session. Path (b) POSTs to
            calibrate-proceed which writes the opener and lets the dispatch
            override route the next host turn to recalibrate.first-time. */}
        {(() => {
          if (loading || calibrateChoiceMade) return null;
          const hasSeedInfo = messages.some((m) => {
            const meta = m.metadata as { kind?: string; subkind?: string } | null;
            return meta?.kind === "onboarding" && meta?.subkind === "calibrate-seed-info";
          });
          const hasOpener = messages.some((m) => {
            const meta = m.metadata as { kind?: string; subkind?: string } | null;
            return meta?.kind === "onboarding" && meta?.subkind === "calibrate-opener";
          });
          // Also suppress if there's already real chat — the calibration arc
          // already ran in a prior session.
          const hasRealChatNow = messages.some((m) => {
            const meta = m.metadata as { kind?: string } | null;
            return meta?.kind !== "onboarding";
          });
          if (!hasSeedInfo || hasOpener || hasRealChatNow) return null;
          return (
            <CalibrateChoicePanel
              onChoiceB={async () => {
                setCalibrateChoiceMade(true);
                setLoading(true);
                try {
                  const res = await fetch("/api/onboarding/calibrate-proceed", {
                    method: "POST",
                  });
                  if (!res.ok) {
                    console.error("[feed] calibrate-proceed POST failed", res.status);
                    return;
                  }
                  const data = (await res.json()) as { opener?: ChannelMsg | null };
                  if (data?.opener) {
                    setMessages((prev) => {
                      const seen = new Set(prev.map((m) => m.id));
                      return seen.has(data.opener!.id) ? prev : [...prev, data.opener!];
                    });
                  }
                } catch (err) {
                  console.error("[feed] calibrate-proceed error", err);
                } finally {
                  setLoading(false);
                }
              }}
              onDone={() => setCalibrateChoiceMade(true)}
            />
          );
        })()}

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
