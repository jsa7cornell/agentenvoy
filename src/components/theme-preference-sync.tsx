"use client";

/**
 * Applies the server-persisted themeMode to next-themes on every page load
 * and keeps "auto" mode in sync with wall-clock time in the user's timezone
 * (light 05:00–20:00, dark otherwise).
 *
 * Source of truth is `preferences.explicit.themeMode` — stored server-side
 * so the preference follows the user across devices. localStorage remains
 * as next-themes' local cache to avoid a flash on repeat loads; the server
 * value overrides it on mount.
 *
 * Also renders the **first-flip explainer toast** (progressive profile
 * Category C). The first time the user is in auto mode AND the sync would
 * visibly change the theme (localStorage cache differs from the just-
 * computed auto theme), we show a one-shot toast explaining why. Gated on
 * `preferences.explicit.seenThemeModeExplainer`.
 *
 * Mounted once inside Providers. No-op when the user isn't authenticated.
 */

import { useSession } from "next-auth/react";
import { useTheme } from "next-themes";
import { useEffect, useRef, useState } from "react";

export type ThemeMode = "light" | "dark" | "auto";

/** Compute the effective theme for "auto" mode given a wall-clock hour in
 *  the user's timezone. Light 05:00–19:59, dark 20:00–04:59. */
export function computeAutoTheme(hourInTz: number): "light" | "dark" {
  return hourInTz >= 5 && hourInTz < 20 ? "light" : "dark";
}

function currentHourInTimezone(timezone: string): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "numeric",
      hour12: false,
    }).formatToParts(new Date());
    const hourPart = parts.find((p) => p.type === "hour");
    if (!hourPart) return new Date().getHours();
    // Intl may return "24" for midnight in some implementations.
    const h = parseInt(hourPart.value, 10);
    return Number.isFinite(h) ? h % 24 : new Date().getHours();
  } catch {
    return new Date().getHours();
  }
}

/** Read next-themes' cached theme from localStorage. Returns null on SSR or
 *  when localStorage throws (Safari private mode). */
function readCachedTheme(): "light" | "dark" | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem("theme");
    return raw === "light" || raw === "dark" ? raw : null;
  } catch {
    return null;
  }
}

export function ThemePreferenceSync() {
  const { status } = useSession();
  const { setTheme } = useTheme();
  const modeRef = useRef<ThemeMode | null>(null);
  const tzRef = useRef<string>("America/Los_Angeles");
  const lastAppliedRef = useRef<"light" | "dark" | null>(null);
  const seenExplainerRef = useRef<boolean>(true); // default true — don't show on SSR
  const [showExplainer, setShowExplainer] = useState<"light" | "dark" | null>(null);

  // Fetch preference once per authenticated session.
  useEffect(() => {
    if (status !== "authenticated") return;
    let cancelled = false;

    fetch("/api/me/ui-prefs")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        const mode = (data.themeMode ?? "dark") as ThemeMode;
        const tz = (data.timezone ?? "America/Los_Angeles") as string;
        modeRef.current = mode;
        tzRef.current = tz;
        seenExplainerRef.current = Boolean(data.seenThemeModeExplainer);

        if (mode === "auto") {
          const cached = readCachedTheme();
          const next = computeAutoTheme(currentHourInTimezone(tz));
          lastAppliedRef.current = next;
          setTheme(next);
          // First-flip explainer: show iff auto just changed the theme vs
          // what was cached, and the user hasn't seen the explainer yet.
          if (!seenExplainerRef.current && cached && cached !== next) {
            setShowExplainer(next);
          }
        } else {
          setTheme(mode);
          lastAppliedRef.current = mode;
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [status, setTheme]);

  // Keep "auto" in sync with the wall clock. Recompute every minute and
  // on tab visibility changes (handles laptop-wake and long-idle tabs).
  useEffect(() => {
    if (status !== "authenticated") return;

    const tick = () => {
      if (modeRef.current !== "auto") return;
      const next = computeAutoTheme(currentHourInTimezone(tzRef.current));
      if (lastAppliedRef.current !== next) {
        const prev = lastAppliedRef.current;
        lastAppliedRef.current = next;
        setTheme(next);
        // Mid-session flip (e.g. user leaves tab open through 8pm): surface
        // the explainer on the flip moment too, if not yet seen.
        if (!seenExplainerRef.current && prev !== null) {
          setShowExplainer(next);
        }
      }
    };
    const interval = setInterval(tick, 60_000);
    const onVisibility = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [status, setTheme]);

  const dismissExplainer = async () => {
    setShowExplainer(null);
    seenExplainerRef.current = true;
    try {
      await fetch("/api/me/ui-prefs", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seenThemeModeExplainer: true }),
      });
    } catch {
      // If the write fails, worst case the user sees the toast once more.
    }
  };

  if (!showExplainer) return null;

  const copy =
    showExplainer === "dark"
      ? "I just switched to dark — it's after 8pm in your timezone. I'll flip back to light in the morning. You can pin a preference in Account if you'd rather."
      : "I just switched to light — it's daytime in your timezone. I'll flip to dark at 8pm. You can pin a preference in Account if you'd rather.";

  return (
    <div
      className="fixed bottom-4 right-4 z-[90] max-w-sm rounded-xl border border-purple-500/40 bg-surface shadow-lg px-4 py-3"
      role="status"
    >
      <div className="flex items-start gap-3">
        <div className="flex-1 text-sm text-primary leading-relaxed">{copy}</div>
        <button
          type="button"
          onClick={dismissExplainer}
          aria-label="Dismiss"
          className="text-muted hover:text-primary transition text-lg leading-none -mt-0.5"
        >
          ×
        </button>
      </div>
      <div className="flex justify-end gap-2 mt-2">
        <a
          href="/dashboard/account"
          className="text-[11px] text-purple-400 hover:text-purple-300 underline underline-offset-2"
        >
          Open preferences →
        </a>
        <button
          type="button"
          onClick={dismissExplainer}
          className="text-[11px] text-muted hover:text-primary transition"
        >
          Got it
        </button>
      </div>
    </div>
  );
}
