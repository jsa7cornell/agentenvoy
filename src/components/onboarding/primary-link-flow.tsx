"use client";

/**
 * Guided "set up your primary invite link" flow, triggered from the 🔗
 * card on the first-run welcome screen.
 *
 * Scoped to the welcome page for now — this is the first-time-user primary
 * path (~90% of new users); the 10% who land on it later re-run to tune
 * their scheduling defaults. Intentionally doesn't reuse the heavier
 * `onboarding-machine` phase flow: that machine gates on `!isCalibrated`,
 * and this flow runs for calibrated users too.
 *
 * Three questions — hours, default duration, buffer — each rendered as
 * an Envoy bubble with quick-reply buttons. Each answer POSTs to
 * `/api/me/scheduling-defaults` immediately so a partial completion
 * still leaves the user better-configured than before.
 */

import { useEffect, useState } from "react";
import { QuickReplies } from "./quick-replies";
import { WelcomeCelebration } from "./welcome-celebration";
import { parseBusinessHoursRange } from "@/lib/time-parse";

type HourRangeValue = `${number}-${number}` | "__custom__";

const HOURS_OPTIONS: { number: number; label: string; value: HourRangeValue }[] = [
  { number: 1, label: "8am – 4pm", value: "8-16" },
  { number: 2, label: "9am – 5pm", value: "9-17" },
  { number: 3, label: "9am – 6pm", value: "9-18" },
  { number: 4, label: "10am – 6pm", value: "10-18" },
  { number: 5, label: "Flexible — no restrictions", value: "0-24" },
  { number: 6, label: "Custom hours (type your own)", value: "__custom__" },
];

const DURATION_OPTIONS = [
  { number: 1, label: "30 minutes", value: "30" },
  { number: 2, label: "45 minutes", value: "45" },
  { number: 3, label: "60 minutes", value: "60" },
  { number: 4, label: "15 minutes (quick sync)", value: "15" },
];

const BUFFER_OPTIONS = [
  { number: 1, label: "No buffer", value: "0" },
  { number: 2, label: "5 minutes", value: "5" },
  { number: 3, label: "10 minutes", value: "10" },
  { number: 4, label: "15 minutes", value: "15" },
];

type Turn =
  | { role: "envoy"; content: React.ReactNode }
  | { role: "user"; content: string };

type Step = "intro" | "hours" | "duration" | "buffer" | "theme" | "format" | "guest_flex" | "done";

/**
 * Guest-flexibility options. Reusable-link guest-picks proposal,
 * decided 2026-04-28. Maps directly to `primaryLinkGuestPicks: { format, duration }`.
 * Default-selected option is "1" (locked) — matches the per-link default
 * everywhere else.
 */
type GuestFlexValue = "locked" | "format" | "duration" | "both";
const GUEST_FLEX_OPTIONS: { number: number; label: string; value: GuestFlexValue }[] = [
  { number: 1, label: "Just what I posted — no changes", value: "locked" },
  { number: 2, label: "Format flexibility — phone, video, or in-person are all OK", value: "format" },
  { number: 3, label: "Duration flexibility — longer or shorter slots are OK", value: "duration" },
  { number: 4, label: "Both — format and duration are open", value: "both" },
];

type ThemeMode = "light" | "dark" | "auto";
type FormatValue = "video" | "phone" | "in-person";

interface Answers {
  // Minute-of-day bounds (canonical, 30-min aligned). See proposal
  // `2026-04-23_primary-link-config-convergence` §3.1 Path A.
  businessHoursStartMinutes?: number;
  businessHoursEndMinutes?: number;
  defaultDuration?: number;
  bufferMinutes?: number;
  // §1n item 4 — chained theme + format follow-ups after the buffer step.
  themeMode?: ThemeMode;
  defaultFormat?: FormatValue;
}

const THEME_OPTIONS: { number: number; label: string; value: ThemeMode }[] = [
  { number: 1, label: "Light", value: "light" },
  { number: 2, label: "Dark", value: "dark" },
  { number: 3, label: "Auto (matches time of day)", value: "auto" },
];

const FORMAT_OPTIONS: { number: number; label: string; value: FormatValue }[] = [
  { number: 1, label: "Video call", value: "video" },
  { number: 2, label: "Phone call", value: "phone" },
  { number: 3, label: "In-person", value: "in-person" },
];

/** Format a minute-of-day value for display. 510 → "8:30am", 540 → "9am". */
function formatMinutes(m: number): string {
  const h = Math.floor(m / 60);
  const min = m % 60;
  const suffix = h < 12 || h === 24 ? "am" : "pm";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return min === 0 ? `${h12}${suffix}` : `${h12}:${String(min).padStart(2, "0")}${suffix}`;
}

interface PrimaryLinkFlowProps {
  /** Fires when the host taps the celebration's "Back to chat" CTA at the
   *  end of the flow. Caller should clear its `primaryLinkFlowActive` state
   *  so the steady-state Home re-renders. Optional — older callers that
   *  don't pass it simply leave the flow rendered (legacy behaviour). */
  onDismiss?: () => void;
  /** §1n item 4: post-flow chips on the celebration card. Caller should
   *  dismiss the flow AND auto-submit the seed message (handleSend path).
   *  When omitted, the celebration shows only "Back to chat". */
  onPostFlowSeed?: (seed: string) => void;
}

export function PrimaryLinkFlow({ onDismiss, onPostFlowSeed }: PrimaryLinkFlowProps = {}) {
  const [meetSlug, setMeetSlug] = useState<string | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [step, setStep] = useState<Step>("intro");
  const [answers, setAnswers] = useState<Answers>({});
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  // Hours freetext composer state — shown when the user picks "Custom hours".
  const [hoursFreetext, setHoursFreetext] = useState("");
  const [hoursFreetextError, setHoursFreetextError] = useState<string | null>(null);
  const [showHoursFreetext, setShowHoursFreetext] = useState(false);

  // Fetch slug + current defaults on mount, then kick off the intro.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/me/scheduling-defaults")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        setMeetSlug(data.meetSlug ?? null);
        setName(data.name ?? null);
        setTurns([
          {
            role: "envoy",
            content: (
              <>
                Great — let&rsquo;s set up your primary invite link.
                {data.meetSlug && (
                  <>
                    {" "}Your link is{" "}
                    <code className="text-purple-400">
                      agentenvoy.ai/meet/{data.meetSlug}
                    </code>
                    .
                  </>
                )}{" "}
                Share it with anyone and they can book time with you.
                I&rsquo;ll take care of the back-and-forth — I just need to
                know a few things first.
              </>
            ),
          },
          {
            role: "envoy",
            content: (
              <>
                What would you like your ordinary available hours to be?
              </>
            ),
          },
        ]);
        setStep("hours");
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  async function persist(patch: Answers) {
    setSaving(true);
    try {
      await fetch("/api/me/scheduling-defaults", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
    } catch {
      // Non-fatal; next step still proceeds. User can tune later in chat.
    } finally {
      setSaving(false);
    }
  }

  function commitHours(startMinutes: number, endMinutes: number, userLabel: string) {
    const patch = {
      businessHoursStartMinutes: startMinutes,
      businessHoursEndMinutes: endMinutes,
    };
    setAnswers((a) => ({ ...a, ...patch }));
    setTurns((t) => [
      ...t,
      { role: "user", content: userLabel },
      {
        role: "envoy",
        content: <>Got it. What&rsquo;s your default meeting length?</>,
      },
    ]);
    setStep("duration");
    setShowHoursFreetext(false);
    setHoursFreetext("");
    setHoursFreetextError(null);
    void persist(patch);
  }

  function handleHoursFreetextSubmit() {
    const parsed = parseBusinessHoursRange(hoursFreetext);
    if (!parsed) {
      setHoursFreetextError(
        'Hmm, I couldn\'t parse that. Try "8:30 to 5:30" or "9am-6pm". Times must be on the half hour.',
      );
      return;
    }
    commitHours(
      parsed.startMinutes,
      parsed.endMinutes,
      `${formatMinutes(parsed.startMinutes)} – ${formatMinutes(parsed.endMinutes)}`,
    );
  }

  function handleHours(value: string, label: string) {
    if (value === "__custom__") {
      setShowHoursFreetext(true);
      setHoursFreetextError(null);
      return;
    }
    const [sRaw, eRaw] = value.split("-");
    const s = parseInt(sRaw, 10);
    const e = parseInt(eRaw, 10);
    if (!Number.isFinite(s) || !Number.isFinite(e)) return;
    // Quick-reply values are whole hours; convert to minute-of-day so the
    // scoring engine stores canonical data.
    commitHours(s * 60, e * 60, label);
  }

  function handleDuration(value: string, label: string) {
    const dur = parseInt(value, 10);
    if (!Number.isFinite(dur)) return;
    const patch = { defaultDuration: dur };
    setAnswers((a) => ({ ...a, ...patch }));
    setTurns((t) => [
      ...t,
      { role: "user", content: label },
      {
        role: "envoy",
        content: (
          <>Last one — do you want a buffer between meetings?</>
        ),
      },
    ]);
    setStep("buffer");
    void persist(patch);
  }

  function handleBuffer(value: string, label: string) {
    const buf = parseInt(value, 10);
    if (!Number.isFinite(buf)) return;
    const patch = { bufferMinutes: buf };
    setAnswers((a) => ({ ...a, ...patch }));
    setTurns((t) => [
      ...t,
      { role: "user", content: label },
      {
        role: "envoy",
        content: (
          <>A few quick visual + meeting-default touch-ups. Theme?</>
        ),
      },
    ]);
    setStep("theme");
    void persist(patch);
  }

  async function handleTheme(value: string, label: string) {
    const themeMode = value as ThemeMode;
    if (themeMode !== "light" && themeMode !== "dark" && themeMode !== "auto") return;
    const patch = { themeMode };
    setAnswers((a) => ({ ...a, ...patch }));
    setTurns((t) => [
      ...t,
      { role: "user", content: label },
      {
        role: "envoy",
        content: (
          <>And how do you usually meet — video, phone, or in person?</>
        ),
      },
    ]);
    setStep("format");
    // Theme persists to /api/me/ui-prefs (different endpoint than the
    // scheduling defaults — the theme primitive is global and gets read by
    // theme-preference-sync.tsx on every page mount).
    setSaving(true);
    try {
      await fetch("/api/me/ui-prefs", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ themeMode }),
      });
    } catch {
      // Non-fatal. User can change theme later via /dashboard/account.
    } finally {
      setSaving(false);
    }
  }

  function handleFormat(value: string, label: string) {
    if (value !== "video" && value !== "phone" && value !== "in-person") return;
    const patch = { defaultFormat: value as FormatValue };
    setAnswers((a) => ({ ...a, ...patch }));
    setTurns((t) => [
      ...t,
      { role: "user", content: label },
      {
        role: "envoy",
        content: (
          <>
            One last thing — by default, can guests <strong>adjust the format or duration</strong> of meetings you post? You can change this per link later.
          </>
        ),
      },
    ]);
    setStep("guest_flex");
    void persist(patch);
  }

  /**
   * Persist the host's guest-flexibility pick to
   * `preferences.explicit.primaryLinkGuestPicks`. Reusable-link guest-picks
   * proposal, decided 2026-04-28.
   */
  async function persistGuestFlex(picks: { format: boolean; duration: boolean }) {
    setSaving(true);
    try {
      await fetch("/api/me/primary-link-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ guestPicks: picks }),
      });
    } catch {
      // Non-fatal — host can flip the toggles later in /dashboard/my-links.
    } finally {
      setSaving(false);
    }
  }

  function handleGuestFlex(value: string, label: string) {
    if (
      value !== "locked" &&
      value !== "format" &&
      value !== "duration" &&
      value !== "both"
    )
      return;
    const picks = {
      format: value === "format" || value === "both",
      duration: value === "duration" || value === "both",
    };
    const finalAnswers = answers;
    setTurns((t) => [
      ...t,
      { role: "user", content: label },
      {
        role: "envoy",
        content: (
          <>
            All set! Here&rsquo;s your primary link:
            {meetSlug && (
              <>
                {" "}
                <code className="text-purple-400">
                  agentenvoy.ai/meet/{meetSlug}
                </code>
              </>
            )}
            . I&rsquo;ll offer times{" "}
            <strong>
              {formatMinutes(
                finalAnswers.businessHoursStartMinutes ?? 540,
              )}
              –
              {formatMinutes(
                finalAnswers.businessHoursEndMinutes ?? 1020,
              )}
            </strong>
            , default to{" "}
            <strong>{finalAnswers.defaultDuration ?? 30}-minute</strong>{" "}
            <strong>{finalAnswers.defaultFormat ?? "video"}</strong> meetings
            {finalAnswers.bufferMinutes
              ? `, and keep a ${finalAnswers.bufferMinutes}-minute buffer between them`
              : ""}
            {picks.format || picks.duration
              ? `, and guests can ${picks.format && picks.duration ? "adjust format or duration" : picks.format ? "pick a different format" : "ask for a longer or shorter slot"}`
              : ""}
            . You can tweak any of this later — just tell me in chat.
          </>
        ),
      },
    ]);
    setStep("done");
    void persistGuestFlex(picks);
  }

  const activeOptions =
    step === "hours"
      ? HOURS_OPTIONS
      : step === "duration"
        ? DURATION_OPTIONS
        : step === "buffer"
          ? BUFFER_OPTIONS
          : step === "theme"
            ? THEME_OPTIONS
            : step === "format"
              ? FORMAT_OPTIONS
              : step === "guest_flex"
                ? GUEST_FLEX_OPTIONS
                : null;

  const onSelect =
    step === "hours"
      ? handleHours
      : step === "duration"
        ? handleDuration
        : step === "buffer"
          ? handleBuffer
          : step === "theme"
            ? handleTheme
            : step === "format"
              ? handleFormat
              : step === "guest_flex"
                ? handleGuestFlex
              : () => {};

  // Legacy copy handler — kept for the fallback link card below the
  // celebration when no `onDismiss` is wired (older callers). New callers
  // get the celebration's own Copy button + Back-to-chat CTA.
  const copyLink = () => {
    if (!meetSlug) return;
    navigator.clipboard.writeText(`https://agentenvoy.ai/meet/${meetSlug}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  /** First-name extract for the celebration headline. Mirrors feed.tsx's
   *  `firstNameOf`; kept local so the onboarding tree doesn't depend on
   *  the feed component. */
  function firstNameOf(n: string | null): string | null {
    if (!n) return null;
    const first = n.split(/\s+/)[0]?.trim();
    return first ? first : null;
  }

  return (
    <div className="flex-1 flex flex-col py-6 gap-3">
      {turns.map((turn, i) =>
        turn.role === "envoy" ? (
          <div key={i} className="flex flex-col gap-1">
            <span className="text-purple-400 text-[10px] font-semibold uppercase tracking-wide px-1">
              Envoy
            </span>
            <div className="bg-black/5 dark:bg-white/[0.07] rounded-2xl rounded-bl-sm px-4 py-3 text-sm text-primary max-w-lg leading-relaxed">
              {turn.content}
            </div>
          </div>
        ) : (
          <div key={i} className="self-end">
            <div className="bg-purple-600 text-white rounded-2xl rounded-br-sm px-4 py-2.5 text-sm max-w-lg leading-relaxed">
              {turn.content}
            </div>
          </div>
        ),
      )}

      {activeOptions && (
        <div className="self-start max-w-[72%] mt-1">
          <QuickReplies
            options={activeOptions}
            onSelect={onSelect}
            disabled={saving}
          />
        </div>
      )}

      {step === "hours" && showHoursFreetext && (
        <div className="self-start max-w-[72%] mt-2 flex flex-col gap-1.5">
          <form
            onSubmit={(ev) => {
              ev.preventDefault();
              handleHoursFreetextSubmit();
            }}
            className="flex gap-2"
          >
            <input
              type="text"
              autoFocus
              value={hoursFreetext}
              onChange={(ev) => {
                setHoursFreetext(ev.target.value);
                if (hoursFreetextError) setHoursFreetextError(null);
              }}
              placeholder="e.g. 8:30 to 5:30"
              className="flex-1 text-sm px-3.5 py-2.5 rounded-xl border border-indigo-500/30 bg-indigo-500/5 text-primary placeholder:text-primary/40 focus:outline-none focus:border-indigo-500/60"
              disabled={saving}
            />
            <button
              type="submit"
              disabled={saving || !hoursFreetext.trim()}
              className="px-4 py-2 bg-purple-600 hover:bg-purple-500 disabled:opacity-40 text-white text-sm font-medium rounded-xl transition"
            >
              Set
            </button>
          </form>
          {hoursFreetextError && (
            <span className="text-xs text-rose-400 px-1">{hoursFreetextError}</span>
          )}
        </div>
      )}

      {/* Tune-preferences flow completion. The "All set!" Envoy recap
          bubble (above) does the literal readback; the celebration drops
          in alongside as the moment-marker, per mockups/mobile-v2.html
          §1 Frame 5 + CODEBASE-CLEANUP item 21.
          When no `onDismiss` is wired (legacy callers), fall through to a
          calm link card so the host still has a copy affordance. */}
      {step === "done" && onDismiss && (
        <WelcomeCelebration
          firstName={firstNameOf(name)}
          meetSlug={meetSlug}
          onDismiss={onDismiss}
          onPostFlowSeed={onPostFlowSeed}
        />
      )}

      {step === "done" && !onDismiss && meetSlug && (
        <div className="self-start mt-2 bg-purple-500/10 border border-purple-500/20 rounded-lg p-3 flex items-center gap-3 max-w-lg">
          <code className="text-xs text-purple-400 truncate flex-1">
            agentenvoy.ai/meet/{meetSlug}
          </code>
          <button
            type="button"
            onClick={copyLink}
            className="px-3 py-1.5 bg-purple-600 hover:bg-purple-500 text-white text-xs font-medium rounded-md transition flex-shrink-0"
          >
            {copied ? "Copied!" : "Copy link"}
          </button>
        </div>
      )}
    </div>
  );
}
