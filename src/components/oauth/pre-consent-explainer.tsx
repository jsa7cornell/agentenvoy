"use client";

import { useEffect } from "react";

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
 *   - first-connect → full value-prop + permission breakdown + footnote
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

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="pre-consent-title"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-md bg-surface border border-secondary rounded-xl shadow-xl p-6 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        {mode === "reconnect" ? <ReconnectBody /> : null}
        {mode === "upgrade-scope" ? <UpgradeScopeBody /> : null}
        {mode === "first-connect" ? <FirstConnectBody /> : null}

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
      </div>
    </div>
  );
}

function FirstConnectBody() {
  return (
    <>
      <h2 id="pre-consent-title" className="text-lg font-semibold text-primary">
        Before you connect Google Calendar
      </h2>
      <p className="text-sm text-secondary leading-relaxed">
        AgentEnvoy reads your calendar so it can suggest times that work for
        you, and writes confirmed meetings back so you don&apos;t have to.
      </p>
      <ul className="text-xs text-secondary space-y-2 leading-relaxed">
        <li>
          <span className="text-primary font-medium">What we read:</span> events
          on the calendars you choose. Titles and times only — never
          attachments, file contents, or who else is looking at your calendar.
        </li>
        <li>
          <span className="text-primary font-medium">What we write:</span> only
          meetings you confirm. We never modify or delete anything we
          didn&apos;t create.
        </li>
        <li>
          <span className="text-primary font-medium">What you control:</span>{" "}
          which calendars we read (change any time on the Account page).
          Disconnecting AgentEnvoy in your Google account immediately revokes
          access.
        </li>
        <li>
          <span className="text-primary font-medium">What we don&apos;t do:</span>{" "}
          sell your data, share it with other users, or use it to train AI
          models.
        </li>
      </ul>
      <p className="text-[11px] text-muted leading-relaxed">
        More detail in our{" "}
        <a href="/privacy" target="_blank" rel="noreferrer" className="underline hover:text-secondary">
          privacy policy
        </a>{" "}
        and{" "}
        <a href="/faq" target="_blank" rel="noreferrer" className="underline hover:text-secondary">
          FAQ
        </a>
        .
      </p>
    </>
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
