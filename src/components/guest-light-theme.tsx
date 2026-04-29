"use client";

/**
 * Force light theme for unauthenticated viewers of guest-facing surfaces
 * (deal rooms / `/meet/*`). Mounted as a sibling to `<DealRoom>` so it
 * doesn't entangle with the deal-room component itself — sets the theme
 * on mount, returns null, no UI surface.
 *
 * Why: `next-themes` defaults to dark globally (`providers.tsx`), so a
 * guest landing on a host's deal-room sees the dark UI by default. After
 * connecting a calendar via the read-only OAuth flow, ThemePreferenceSync
 * starts firing for the now-authenticated session and snaps the UI to
 * the user's stored theme (default "dark") — visually jarring transition
 * mid-flow. John's 2026-04-29 direction: logged-out guests AND guests
 * who haven't set an explicit preference should default to light on
 * `/meet/*` surfaces.
 *
 * Behavior:
 *   - status === "unauthenticated" → setTheme("light"). One-shot per
 *     mount; downstream user actions (system OS dark-mode toggle, dev
 *     tools) can still override via next-themes.
 *   - status === "authenticated" → no-op. ThemePreferenceSync owns the
 *     theme for signed-in users; we don't fight it.
 *   - status === "loading" → no-op until status resolves.
 *
 * Mirrors the pattern already used on `/` (homepage) per commit 4e4c7e9.
 */

import { useSession } from "next-auth/react";
import { useTheme } from "next-themes";
import { useEffect } from "react";

export function GuestLightTheme() {
  const { status } = useSession();
  const { setTheme } = useTheme();

  useEffect(() => {
    if (status === "unauthenticated") {
      setTheme("light");
    }
  }, [status, setTheme]);

  return null;
}
