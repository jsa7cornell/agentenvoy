"use client";

import { useTheme } from "next-themes";
import { useCallback, useEffect, useState } from "react";
import {
  computeAutoTheme,
  type ThemeMode,
  AE_THEME_MODE_CHANGE,
} from "@/components/theme-preference-sync";

/** Get the current hour in a given IANA timezone. Mirrors the helper in
 *  theme-preference-sync.tsx; duplicated to keep this component a leaf. */
function currentHourInTimezone(timezone: string): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "numeric",
      hour12: false,
    }).formatToParts(new Date());
    const hourPart = parts.find((p) => p.type === "hour");
    if (!hourPart) return new Date().getHours();
    const h = parseInt(hourPart.value, 10);
    return Number.isFinite(h) ? h % 24 : new Date().getHours();
  } catch {
    return new Date().getHours();
  }
}

export function ThemeToggle() {
  const { setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [mode, setMode] = useState<ThemeMode>("dark");
  const [saving, setSaving] = useState(false);
  const [timezone, setTimezone] = useState<string>("America/Los_Angeles");

  useEffect(() => {
    setMounted(true);
    fetch("/api/me/ui-prefs")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data) return;
        if (data.themeMode) setMode(data.themeMode as ThemeMode);
        if (data.timezone) setTimezone(data.timezone);
      })
      .catch(() => {});
  }, []);

  const apply = useCallback(
    async (next: ThemeMode) => {
      setMode(next);
      if (next === "auto") {
        setTheme(computeAutoTheme(currentHourInTimezone(timezone)));
      } else {
        setTheme(next);
      }
      setSaving(true);
      try {
        await fetch("/api/me/ui-prefs", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ themeMode: next }),
        });
        // Notify ThemePreferenceSync so modeRef stays in sync immediately.
        // Without this, the 60s tick would still fire at 8pm even if the user
        // just pinned "light" — because modeRef would be stale ("auto").
        window.dispatchEvent(
          new CustomEvent(AE_THEME_MODE_CHANGE, { detail: { mode: next } }),
        );
      } catch {
        // Swallow — localStorage + in-memory state still reflect the change.
      } finally {
        setSaving(false);
      }
    },
    [setTheme, timezone],
  );

  if (!mounted) return null;

  const btn = (active: boolean) =>
    `flex items-center gap-2 px-3 py-2 rounded-lg border text-sm transition ${
      active
        ? "border-purple-500 bg-purple-500/10 text-primary"
        : "border-surface-tertiary/50 bg-surface-secondary/40 text-muted hover:border-secondary"
    } ${saving ? "opacity-80" : ""}`;

  return (
    <div className="flex flex-wrap gap-2">
      <button onClick={() => apply("light")} className={btn(mode === "light")} disabled={saving}>
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v2.25m6.364.386l-1.591 1.591M21 12h-2.25m-.386 6.364l-1.591-1.591M12 18.75V21m-4.773-4.227l-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0z" />
        </svg>
        Light
      </button>
      <button onClick={() => apply("dark")} className={btn(mode === "dark")} disabled={saving}>
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M21.752 15.002A9.718 9.718 0 0118 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 003 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 009.002-5.998z" />
        </svg>
        Dark
      </button>
      <button onClick={() => apply("auto")} className={btn(mode === "auto")} disabled={saving}>
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 3a9 9 0 109 9 7 7 0 01-9-9z" />
        </svg>
        Auto
      </button>
      <p className="w-full text-[10px] text-muted mt-1">
        {mode === "auto"
          ? "Light during the day, dark 8pm–5am in your timezone."
          : "Applies on this and other devices."}
      </p>
    </div>
  );
}
