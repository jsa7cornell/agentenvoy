"use client";

/**
 * Applies the server-persisted themeMode to next-themes on every page load
 * and keeps "auto" mode in sync with wall-clock time in the user's timezone
 * (light 05:00–19:59, dark 20:00–04:59).
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
 *
 * --- STABLE setTheme PATTERN (2026-05-10) ---
 * next-themes 0.4.x: setTheme() is NOT a stable reference. Its useCallback
 * dep is [currentTheme], so every time the theme changes, setTheme gets a
 * new function reference. Including it in useEffect deps caused both effects
 * to re-run on every theme change — triggering a spurious re-fetch that
 * could race the tick's dark application and revert it.
 *
 * Fix: capture setTheme in a ref (setThemeRef). Effects read from the ref
 * instead of closing over the unstable value, and setTheme is excluded from
 * their dep arrays.
 *
 * --- CROSS-COMPONENT SYNC (2026-05-10) ---
 * ThemeToggle saves a new mode to the server but doesn't update modeRef here.
 * Without cross-component sync, the tick() would still fire at 8pm even if
 * the user had just switched to "light" — because modeRef.current was stale.
 * Fix: ThemeToggle dispatches "ae:theme-mode-change" when it saves; this
 * component listens and updates modeRef immediately.
 */

import { useSession } from "next-auth/react";
import { useTheme } from "next-themes";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { HelpBubble } from "@/components/bubbles/help-bubble";

export type ThemeMode = "light" | "dark" | "auto";

/** Custom event dispatched by ThemeToggle when the user saves a new mode.
 *  ThemePreferenceSync listens to this to keep modeRef in sync without a
 *  re-fetch. */
export const AE_THEME_MODE_CHANGE = "ae:theme-mode-change";
export type AeThemeModeChangeEvent = CustomEvent<{ mode: ThemeMode }>;

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
  const pathname = usePathname();
  const modeRef = useRef<ThemeMode | null>(null);
  const tzRef = useRef<string>("America/Los_Angeles");
  const lastAppliedRef = useRef<"light" | "dark" | null>(null);
  const seenExplainerRef = useRef<boolean>(true); // default true — don't show on SSR
  const [showExplainer, setShowExplainer] = useState<"light" | "dark" | null>(null);

  // Stable ref for setTheme — next-themes 0.4.x recreates setTheme on every
  // theme change (its useCallback dep is [currentTheme]). Capturing it in a
  // ref lets effects call the latest version without being in their dep arrays,
  // preventing spurious effect re-runs that would race and revert theme changes.
  const setThemeRef = useRef(setTheme);
  useEffect(() => {
    setThemeRef.current = setTheme;
  }); // no deps — always sync to latest

  // Skip on guest-facing surfaces. /meet/* is the deal-room — a guest-
  // facing brand surface where <GuestLightTheme> owns the theme. If we let
  // ThemePreferenceSync run here it'll race with GuestLightTheme: GuestLightTheme
  // sets the time-of-day theme on mount, then this fetch resolves and overrides
  // with the user's stored mode, producing "page goes dark right after OAuth" jank.
  // See guest-light-theme.tsx for full rationale.
  const isGuestSurface = pathname?.startsWith("/meet/") ?? false;

  // Fetch preference once per authenticated session. Uses setThemeRef (not
  // setTheme) to avoid re-running when setTheme's reference changes.
  useEffect(() => {
    if (status !== "authenticated") return;
    if (isGuestSurface) return;
    let cancelled = false;

    fetch("/api/me/ui-prefs")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        const mode = (data.themeMode ?? "light") as ThemeMode;
        const tz = (data.timezone ?? "America/Los_Angeles") as string;
        modeRef.current = mode;
        tzRef.current = tz;
        seenExplainerRef.current = Boolean(data.seenThemeModeExplainer);

        if (mode === "auto") {
          const cached = readCachedTheme();
          const next = computeAutoTheme(currentHourInTimezone(tz));
          lastAppliedRef.current = next;
          setThemeRef.current(next);
          // First-flip explainer: show iff auto just changed the theme vs
          // what was cached, and the user hasn't seen the explainer yet.
          if (!seenExplainerRef.current && cached && cached !== next) {
            setShowExplainer(next);
          }
        } else {
          setThemeRef.current(mode);
          lastAppliedRef.current = mode;
        }

        // Enable smooth mid-session theme transitions. Deferred to after the
        // initial server preference is applied so the page-load hydration flip
        // (light default → user's stored dark) stays instant. Only mid-session
        // switches (8pm auto-flip, user toggle) will have the CSS transition.
        // Uses requestAnimationFrame to ensure the current frame has painted
        // before transitions are enabled.
        requestAnimationFrame(() => {
          document.documentElement.dataset.themeReady = "true";
        });
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
    // Intentionally excludes setTheme — using setThemeRef.current() instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, isGuestSurface]);

  // Keep "auto" in sync with the wall clock. Recompute every minute and
  // on tab visibility changes (handles laptop-wake and long-idle tabs).
  useEffect(() => {
    if (status !== "authenticated") return;
    if (isGuestSurface) return;

    const tick = () => {
      if (modeRef.current !== "auto") return;
      const next = computeAutoTheme(currentHourInTimezone(tzRef.current));
      if (lastAppliedRef.current !== next) {
        const prev = lastAppliedRef.current;
        lastAppliedRef.current = next;
        setThemeRef.current(next);
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

    // Cross-component sync: ThemeToggle dispatches this event when it saves
    // a new mode. Update modeRef immediately so tick() respects the change
    // without waiting for a page reload.
    const onModeChange = (e: Event) => {
      const { mode } = (e as AeThemeModeChangeEvent).detail;
      modeRef.current = mode;
      if (mode !== "auto") {
        // User pinned a non-auto mode — sync lastApplied so tick() won't
        // flip back on the next minute boundary.
        lastAppliedRef.current = mode;
      }
    };
    window.addEventListener(AE_THEME_MODE_CHANGE, onModeChange);

    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener(AE_THEME_MODE_CHANGE, onModeChange);
    };
    // Intentionally excludes setTheme — using setThemeRef.current() instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, isGuestSurface]);

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

  const message =
    showExplainer === "dark"
      ? "I just switched to dark — it's after 8pm in your timezone. I'll flip back to light in the morning. You can pin a preference in Account if you'd rather."
      : "I just switched to light — it's daytime in your timezone. I'll flip to dark at 8pm. You can pin a preference in Account if you'd rather.";

  return (
    <HelpBubble
      id="theme-auto-flip"
      message={message}
      target="preferences"
      targetLabel="Open preferences"
      onDismiss={dismissExplainer}
    />
  );
}
