"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { GoogleButton } from "./google-button";

export type PreConsentMode = "first-connect" | "reconnect" | "upgrade-scope" | "login";

interface Props {
  open: boolean;
  mode: PreConsentMode;
  onConfirm: () => void;
  onCancel: () => void;
  /** Login mode only: called when user clicks "Continue with Google" from the
   *  sign-in view (uses prompt=select_account, no forced consent re-screen). */
  onSignIn?: () => void;
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
 *   - login         → sign-in view first (select_account, no re-consent); "New
 *                     here? See how it works →" toggles to the first-connect
 *                     pitch. Cookie-present returning users skip this modal
 *                     entirely via `useOAuthSignIn`'s trigger gate — so the
 *                     copy here is neutral, not "welcome back" (that would
 *                     greet first-time visitors as returning users).
 */
export function PreConsentExplainer({ open, mode, onConfirm, onCancel, onSignIn }: Props) {
  const [showPitch, setShowPitch] = useState(false);

  useEffect(() => {
    if (!open) setShowPitch(false);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;

  const showLoginView = mode === "login" && !showPitch;
  const isFirstConnect = mode === "first-connect" || (mode === "login" && showPitch);

  const modal = (
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
        {showLoginView && onSignIn && (
          <LoginBody onSignIn={onSignIn} onNewHere={() => setShowPitch(true)} onCancel={onCancel} />
        )}

        {mode === "reconnect" && <ReconnectBody />}
        {mode === "upgrade-scope" && <UpgradeScopeBody />}
        {isFirstConnect && <FirstConnectBody />}

        {isFirstConnect && (
          <div className="pt-2 space-y-3">
            <GoogleButton onClick={onConfirm} block />
            {mode === "login" && (
              <button
                type="button"
                onClick={() => setShowPitch(false)}
                className="block w-full text-center text-xs text-muted hover:text-secondary underline underline-offset-2 transition py-1"
              >
                ← Back
              </button>
            )}
            <button
              type="button"
              onClick={onCancel}
              className="block w-full text-center text-xs text-muted hover:text-secondary underline underline-offset-2 transition py-1"
            >
              Maybe later
            </button>
          </div>
        )}

        {(mode === "reconnect" || mode === "upgrade-scope") && (
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

  return createPortal(modal, document.body);
}

function LoginBody({ onSignIn, onNewHere, onCancel }: {
  onSignIn: () => void;
  onNewHere: () => void;
  onCancel: () => void;
}) {
  return (
    <>
      <h2 id="pre-consent-title" className="text-xl font-semibold text-primary leading-tight">
        Sign in to AgentEnvoy.
      </h2>
      <p className="text-sm text-secondary leading-relaxed">
        Continue with the Google account linked to your AgentEnvoy profile. New
        here? See how it works below.
      </p>
      <div className="pt-2 space-y-3">
        <GoogleButton onClick={onSignIn} block />
        <button
          type="button"
          onClick={onNewHere}
          className="block w-full text-center text-xs text-muted hover:text-secondary underline underline-offset-2 transition py-1"
        >
          New here? See how it works →
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="block w-full text-center text-xs text-muted hover:text-secondary underline underline-offset-2 transition py-1"
        >
          Maybe later
        </button>
      </div>
    </>
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
