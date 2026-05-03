"use client";

/**
 * Apply a time-of-day default theme on guest-facing `/meet/*` surfaces.
 *
 * Revised 2026-05-03 (report cmop8qfvo0013h1vv6x3erlus): changed from
 * hardcoded "light" to `resolveTimeOfDayTheme()` so pages render dark after
 * 18:00 local. The previous always-light behavior broke the host's "auto
 * mode" setting when they previewed their own links at night.
 *
 * Previously revised 2026-04-29 from auth-gated to unconditional: deal rooms
 * are guest-facing surfaces. The auth-gated version caused a freshly-signed-up
 * guest (now authenticated) to see `<ThemePreferenceSync>` snap the page dark
 * right after OAuth. `<ThemePreferenceSync>` still early-returns on `/meet/`
 * so the two components don't race.
 *
 * Mounted as a sibling to `<DealRoom>` on both `/meet/[slug]` and
 * `/meet/[slug]/[code]` pages. Returns null, no UI.
 */

import { useTheme } from "next-themes";
import { useEffect } from "react";
import { resolveTimeOfDayTheme } from "@/lib/time-of-day-theme";

export function GuestLightTheme() {
  const { setTheme } = useTheme();

  useEffect(() => {
    setTheme(resolveTimeOfDayTheme());
  }, [setTheme]);

  return null;
}
