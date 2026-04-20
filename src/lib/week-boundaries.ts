/**
 * Week-boundary helpers for the dashboard calendar.
 *
 * Lives in lib/ (not inside a .tsx component) so the unit-test environment
 * can import it without transpiling JSX.
 *
 * History: getSunday used to live in components/availability-panel.tsx and
 * formatted its result via `.toISOString().slice(0,10)` — UTC. On a Sunday
 * evening PT, the local clock still said Sunday but UTC had already ticked
 * to Monday, so getSunday returned Monday and the whole week view shifted
 * one day right (Full week rendered Mon–Sun instead of Sun–Sat; Workweek
 * rendered Tue–Sat instead of Mon–Fri). Same UTC-bleed class as the
 * all-day-event bugs fixed in 361c7b4 / 0b05961.
 *
 * Rule enforced by this module (from e401b00): every calendar view starts
 * Sunday on the left and ends Saturday on the right — at every hour of
 * the day, in every timezone.
 */

/**
 * Return the Sunday of the week containing `d`, as a local-tz "YYYY-MM-DD".
 * Never touches UTC.
 */
export function getSunday(d: Date): string {
  const date = new Date(d);
  const day = date.getDay(); // local day-of-week (0 = Sunday)
  date.setDate(date.getDate() - day); // rewind to local Sunday
  // Read back local Y/M/D — do NOT use toISOString (UTC).
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}
