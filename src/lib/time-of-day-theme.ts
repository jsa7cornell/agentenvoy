/**
 * Time-of-day theme default for guest-facing surfaces.
 *
 * Per deal-room reshape proposal (2026-04-21, thread G): when a guest lands
 * on a deal-room without a saved theme preference, the initial theme should
 * follow their local wall-clock — light during the day, dark at night.
 * Any explicit user toggle (stored in localStorage by next-themes) still
 * wins; this only affects the *initial* pick.
 *
 * Light: 06:00–17:59 local. Dark: 18:00–05:59 local.
 */
export function resolveTimeOfDayTheme(date: Date = new Date()): "light" | "dark" {
  const hour = date.getHours();
  return hour >= 6 && hour < 18 ? "light" : "dark";
}

/**
 * True when the user hasn't explicitly chosen a theme yet, so we're free
 * to apply the time-of-day default. next-themes writes to localStorage
 * under the key "theme" when the user toggles; absent = no preference.
 */
export function hasNoStoredThemePreference(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem("theme") === null;
  } catch {
    return false;
  }
}
