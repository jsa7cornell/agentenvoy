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

type HourRangeValue = `${number}-${number}`;

const HOURS_OPTIONS: { number: number; label: string; value: HourRangeValue }[] = [
  { number: 1, label: "8am – 4pm", value: "8-16" },
  { number: 2, label: "9am – 5pm", value: "9-17" },
  { number: 3, label: "9am – 6pm", value: "9-18" },
  { number: 4, label: "10am – 6pm", value: "10-18" },
  { number: 5, label: "Flexible — no restrictions", value: "0-24" },
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

type Step = "intro" | "hours" | "duration" | "buffer" | "done";

interface Answers {
  // Minute-of-day bounds (canonical, 30-min aligned). See proposal
  // `2026-04-23_primary-link-config-convergence` §3.1 Path A.
  businessHoursStartMinutes?: number;
  businessHoursEndMinutes?: number;
  defaultDuration?: number;
  bufferMinutes?: number;
}

/** Format a minute-of-day value for display. 510 → "8:30am", 540 → "9am". */
function formatMinutes(m: number): string {
  const h = Math.floor(m / 60);
  const min = m % 60;
  const suffix = h < 12 || h === 24 ? "am" : "pm";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return min === 0 ? `${h12}${suffix}` : `${h12}:${String(min).padStart(2, "0")}${suffix}`;
}

export function PrimaryLinkFlow() {
  const [meetSlug, setMeetSlug] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [step, setStep] = useState<Step>("intro");
  const [answers, setAnswers] = useState<Answers>({});
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);

  // Fetch slug + current defaults on mount, then kick off the intro.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/me/scheduling-defaults")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        setMeetSlug(data.meetSlug ?? null);
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

  function handleHours(value: string, label: string) {
    const [sRaw, eRaw] = value.split("-");
    const s = parseInt(sRaw, 10);
    const e = parseInt(eRaw, 10);
    if (!Number.isFinite(s) || !Number.isFinite(e)) return;
    // Quick-reply values are whole hours; convert to minute-of-day so the
    // scoring engine stores canonical data. Freetext entry (V1 item 4)
    // will supply fractional values directly.
    const patch = {
      businessHoursStartMinutes: s * 60,
      businessHoursEndMinutes: e * 60,
    };
    setAnswers((a) => ({ ...a, ...patch }));
    setTurns((t) => [
      ...t,
      { role: "user", content: label },
      {
        role: "envoy",
        content: <>Got it. What&rsquo;s your default meeting length?</>,
      },
    ]);
    setStep("duration");
    void persist(patch);
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
    const finalAnswers = { ...answers, ...patch };
    setAnswers(finalAnswers);
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
            meetings
            {finalAnswers.bufferMinutes
              ? `, and keep a ${finalAnswers.bufferMinutes}-minute buffer between them`
              : ""}
            . You can tweak any of this later — just tell me in chat.
          </>
        ),
      },
    ]);
    setStep("done");
    void persist(patch);
  }

  const activeOptions =
    step === "hours"
      ? HOURS_OPTIONS
      : step === "duration"
        ? DURATION_OPTIONS
        : step === "buffer"
          ? BUFFER_OPTIONS
          : null;

  const onSelect =
    step === "hours"
      ? handleHours
      : step === "duration"
        ? handleDuration
        : step === "buffer"
          ? handleBuffer
          : () => {};

  const copyLink = () => {
    if (!meetSlug) return;
    navigator.clipboard.writeText(`https://agentenvoy.ai/meet/${meetSlug}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

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

      {step === "done" && meetSlug && (
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
