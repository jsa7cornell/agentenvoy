"use client";

/**
 * Force light theme on guest-facing `/meet/*` surfaces — unconditional.
 *
 * Why unconditional (revised 2026-04-29 from auth-gated): deal rooms are
 * guest-facing brand surfaces. The original auth-gated version only fired
 * when status="unauthenticated", which meant a freshly-signed-up guest
 * (now authenticated) saw `<ThemePreferenceSync>` snap the page to their
 * stored themeMode ("dark" by default) right after OAuth — the exact
 * "page goes dark mid-flow" jank John reported.
 *
 * Companion change: `<ThemePreferenceSync>` early-returns when pathname
 * starts with `/meet/`, so the two don't race for control of the theme
 * on this surface. ThemePreferenceSync resumes ownership on `/dashboard`
 * and other host-side surfaces.
 *
 * Mounted as a sibling to `<DealRoom>` on both `/meet/[slug]` and
 * `/meet/[slug]/[code]` pages. Returns null, no UI.
 */

import { useTheme } from "next-themes";
import { useEffect } from "react";

export function GuestLightTheme() {
  const { setTheme } = useTheme();

  useEffect(() => {
    setTheme("light");
  }, [setTheme]);

  return null;
}
