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
 * Mounted once inside Providers. No-op when the user isn't authenticated.
 */

import { useSession } from "next-auth/react";
import { useTheme } from "next-themes";
import { useEffect, useRef } from "react";

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

export function ThemePreferenceSync() {
  const { status } = useSession();
  const { setTheme } = useTheme();
  const modeRef = useRef<ThemeMode | null>(null);
  const tzRef = useRef<string>("America/Los_Angeles");

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
        if (mode === "auto") {
          setTheme(computeAutoTheme(currentHourInTimezone(tz)));
        } else {
          setTheme(mode);
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
      setTheme(computeAutoTheme(currentHourInTimezone(tzRef.current)));
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

  return null;
}
