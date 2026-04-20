"use client";

import { useEffect } from "react";
import { GoogleButton } from "./google-button";

export type PreConsentMode = "first-connect" | "reconnect" | "upgrade-scope";

interface Props {
  open: boolean;
  mode: PreConsentMode;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Modal shown between the user's click and the Google consent screen.
 *
 * Trust is built in our voice, with our copy, before Google's chrome appears
 * — not by Google's "AgentEnvoy wants to: View and edit events…" line.
 *
 * Mode controls density:
 *   - first-connect → agent-first value-prop, personalization lead, "Continue with Google" Google-branded button
 *   - reconnect     → one-sentence banner, immediate Continue (sub-second)
 *   - upgrade-scope → explains what new permission we need and why
 */
export function PreConsentExplainer({ open, mode, onConfirm, onCancel }: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;

  const isFirstConnect = mode === "first-connect";

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="pre-consent-title"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-md bg-surface border border-secondary rounded-2xl shadow-2xl p-7 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        {mode === "reconnect" ? <ReconnectBody /> : null}
        {mode === "upgrade-scope" ? <UpgradeScopeBody /> : null}
        {isFirstConnect ? <FirstConnectBody /> : null}

        {isFirstConnect ? (
          <div className="pt-2 space-y-3">
            <GoogleButton onClick={onConfirm} block />
            <button
              type="button"
              onClick={onCancel}
              className="block w-full text-center text-xs text-muted hover:text-secondary underline underline-offset-2 transition py-1"
            >
              Maybe later
            </button>
          </div>
        ) : (
          <div className="flex gap-2 pt-2">
            <button
              type="button"
              onClick={onCancel}
              className="flex-1 px-3 py-2 text-sm font-medium text-secondary border border-secondary rounded-md hover:border-DEFAULT hover:text-primary transition"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onConfirm}
              className="flex-1 px-3 py-2 text-sm font-semibold bg-indigo-600 hover:bg-indigo-500 text-white rounded-md transition"
              autoFocus
            >
              Continue to Google →
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function FirstConnectBody() {
  return (
    <>
      <h2 id="pre-consent-title" className="text-xl font-semibold text-primary leading-tight">
        A scheduling agent that knows you.
      </h2>
      <p className="text-sm text-primary leading-relaxed">
        <span className="text-emerald-300 font-medium">Envoy is your personal scheduling agent.</span>{" "}
        It learns when you&apos;re at your best, who you actually want to meet
        with, and how to safely match the right time — without the
        back-and-forth.
      </p>
      <div className="rounded-xl bg-surface-secondary border border-secondary p-4 space-y-3">
        <Bullet
          icon="🧠"
          title="Learns your patterns."
          body="Your real hours, your protected time, your people. Not a free/busy lookup."
        />
        <Bullet
          icon="⚡"
          title="Skips the email tag."
          body="Envoy proposes mutual times and sends the invite once you confirm."
        />
        <Bullet icon="🔌" title="Disconnect anytime." body="From Google or your Envoy account." />
      </div>
      <p className="text-[11px] text-muted leading-relaxed">
        Envoy reads event times only — never titles or attendees.{" "}
        <a href="/privacy" target="_blank" rel="noreferrer" className="underline hover:text-secondary">
          Privacy
        </a>{" "}
        ·{" "}
        <a href="/faq" target="_blank" rel="noreferrer" className="underline hover:text-secondary">
          FAQ
        </a>
      </p>
    </>
  );
}

function Bullet({ icon, title, body }: { icon: string; title: string; body: string }) {
  return (
    <div className="flex items-start gap-3 text-xs">
      <span className="w-5 flex-shrink-0 text-center text-base leading-none mt-0.5" aria-hidden>
        {icon}
      </span>
      <span className="text-secondary leading-relaxed">
        <span className="text-primary font-medium">{title}</span> {body}
      </span>
    </div>
  );
}

function ReconnectBody() {
  return (
    <>
      <h2 id="pre-consent-title" className="text-lg font-semibold text-primary">
        Reconnect Google Calendar
      </h2>
      <p className="text-sm text-secondary leading-relaxed">
        Your Google access expired or was revoked. Continue to refresh
        permissions — same scopes as before.
      </p>
    </>
  );
}

function UpgradeScopeBody() {
  return (
    <>
      <h2 id="pre-consent-title" className="text-lg font-semibold text-primary">
        Grant write access to Google Calendar
      </h2>
      <p className="text-sm text-secondary leading-relaxed">
        To put confirmed meetings on your calendar, AgentEnvoy needs write
        access. We&apos;ll only ever modify meetings we create.
      </p>
      <p className="text-[11px] text-muted leading-relaxed">
        See the{" "}
        <a href="/privacy" target="_blank" rel="noreferrer" className="underline hover:text-secondary">
          privacy policy
        </a>{" "}
        for the full picture.
      </p>
    </>
  );
}
