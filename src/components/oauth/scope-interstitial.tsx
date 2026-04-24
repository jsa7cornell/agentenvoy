"use client";

import { useEffect, useState } from "react";
import { useOAuthSignIn } from "./use-oauth-signin";

/**
 * Top-of-dashboard interstitial when the host's Google grant is missing
 * `calendar.events` (write). Surfaces a clear "reconnect with full access"
 * action so confirmed meetings can land on the user's calendar again.
 *
 * Render conditions (all must hold):
 *   - `/api/connections/status` reports a connected Google account whose
 *     `missingRequired` includes the write scope, OR
 *   - URL contains `?scopeMissing=calendar.events` (set by the NextAuth
 *     callback when partial-permission is detected at sign-in time).
 *
 * Dismissible (sessionStorage) so a host who picked partial-on-purpose
 * doesn't see it on every page change. The next sign-in re-arms it.
 */
export function ScopeInterstitial() {
  const [missingWrite, setMissingWrite] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  // `upgrade-scope` mode already forces prompt=consent in `promptForMode`,
  // so the explicit signInParams override is redundant.
  const reconnect = useOAuthSignIn({
    mode: "upgrade-scope",
    callbackUrl: "/dashboard",
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      if (window.sessionStorage.getItem("scope-interstitial-dismissed") === "1") {
        setDismissed(true);
      }
    } catch {
      /* ignore */
    }

    const url = new URL(window.location.href);
    if (url.searchParams.get("scopeMissing") === "calendar.events") {
      setMissingWrite(true);
      url.searchParams.delete("scopeMissing");
      window.history.replaceState({}, "", url.pathname + url.search);
    }

    fetch("/api/connections/status")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        const missing: string[] = data?.google?.missingRequired ?? [];
        if (
          missing.includes("https://www.googleapis.com/auth/calendar.events")
        ) {
          setMissingWrite(true);
        }
      })
      .catch(() => {});
  }, []);

  if (!missingWrite || dismissed) return reconnect.modal;

  return (
    <div className="bg-amber-500/10 border-b border-amber-500/20 px-4 py-2.5">
      <div className="max-w-5xl mx-auto flex items-center gap-3">
        <div className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse flex-shrink-0" />
        <div className="flex-1 text-xs text-amber-100 leading-snug">
          <span className="font-medium">Calendar write access needed.</span>{" "}
          We can read your calendar but can&apos;t put confirmed meetings on it.
          Grant write access so Envoy can add confirmed meetings.
        </div>
        <button
          type="button"
          onClick={reconnect.trigger}
          className="text-[11px] font-semibold bg-amber-500/20 hover:bg-amber-500/30 text-amber-100 px-3 py-1 rounded-md transition flex-shrink-0"
        >
          Grant access
        </button>
        <button
          type="button"
          onClick={() => {
            setDismissed(true);
            try {
              window.sessionStorage.setItem(
                "scope-interstitial-dismissed",
                "1",
              );
            } catch {
              /* ignore */
            }
          }}
          className="text-amber-200/60 hover:text-amber-100 text-xs flex-shrink-0"
          title="Dismiss"
        >
          ✕
        </button>
      </div>
      {reconnect.modal}
    </div>
  );
}
