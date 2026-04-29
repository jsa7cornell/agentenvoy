/**
 * Google Calendar onboarding seed — read whatever Google will give us at
 * first sign-in and lift it into `User.preferences.explicit.*` defaults.
 *
 * Principle (decided 2026-04-26): seed everything we can pull. A brand-new
 * user shouldn't have to re-tell us what their connected Google account
 * already knows (timezone, locale, week-start, time-format, default
 * meeting length, video-call autoadd preference).
 *
 * Single round-trip: `settings.list()` returns every user-level Calendar
 * setting in one response. Per-field `.get()` would be N round-trips for
 * the same data.
 *
 * NOT pulled (no public API surface today):
 *   - `workingHours` — UI feature, not in `settings.list()`. We keep our
 *     hardcoded 9–5 default until V2 carves out a way to source it
 *     (likely sniffing past events / explicit "what hours do you work?"
 *     prompt during the first-run flow).
 *   - Per-event-template defaults (e.g. "I always use Zoom") — would
 *     require querying past events, deferred.
 *
 * Defensive: every field is independently optional. If `settings.list()`
 * fails entirely, returns `{}` and the caller falls back to hardcoded
 * defaults. If one field is unparseable (e.g. defaultEventLength=
 * "60.5"), that field is omitted and the rest still seed.
 *
 * NEVER blocks signup. Errors log and return `{}`.
 */

import { google } from "googleapis";
import { prisma } from "@/lib/prisma";

export interface GoogleOnboardingSeed {
  /** IANA timezone, e.g. "America/Los_Angeles". Highest-confidence field
   *  Google exposes — virtually every account has one set. */
  timezone?: string;
  /** BCP-47 locale string, e.g. "en". Useful for date/number formatting
   *  when we surface times in emails or greetings. */
  locale?: string;
  /** Week-start: 0 = Sunday, 1 = Monday, 6 = Saturday. Used by the
   *  weekly-calendar component for column ordering. */
  weekStart?: number;
  /** Whether the user prefers 24h time display. Display-only; we always
   *  store times as minute-of-day internally. */
  use24HourTime?: boolean;
  /** Default event length in minutes — rounded to one of our supported
   *  durations [15, 30, 45, 60, 90]. */
  defaultDuration?: number;
  /** Whether Google auto-adds Meet to new events. Soft signal — keeps
   *  `videoProvider: "google_meet"` (our default) when true; absent
   *  signal otherwise. */
  prefersMeet?: boolean;
  /** The Google Calendar API id of the user's primary calendar. Resolves
   *  the literal alias "primary" to the actual calendar id (typically
   *  the user's email address) so downstream filters in the UI — the
   *  manage-calendars dropdown, scoring filters, the host's primary-link
   *  flow — can match on the same enumerated id Google returns from
   *  `calendarList.list()`. Without resolution, the seed default
   *  `activeCalendarIds: ["primary"]` mismatches the email-keyed entries
   *  the dropdown enumerates and no calendar reads as primary in the UI. */
  primaryCalendarId?: string;
}

const ALLOWED_DURATIONS = [15, 30, 45, 60, 90];

/** Round Google's `defaultEventLength` (any positive integer) to the
 *  nearest value in our allowed-duration set, biased toward shorter. */
function roundDuration(minutes: number): number | undefined {
  if (!Number.isFinite(minutes) || minutes <= 0) return undefined;
  // Find closest allowed value; tie-break to the shorter (Envoy bias:
  // when in doubt, less time committed).
  let best = ALLOWED_DURATIONS[0];
  let bestDelta = Math.abs(minutes - best);
  for (const d of ALLOWED_DURATIONS) {
    const delta = Math.abs(minutes - d);
    if (delta < bestDelta || (delta === bestDelta && d < best)) {
      best = d;
      bestDelta = delta;
    }
  }
  return best;
}

/** Fetch every onboarding-relevant Calendar setting in one call. Returns
 *  `{}` on any failure — callers must always merge over hardcoded
 *  defaults, never assume any field is present. */
export async function fetchGoogleOnboardingSeed(
  userId: string,
): Promise<GoogleOnboardingSeed> {
  const out: GoogleOnboardingSeed = {};

  try {
    const account = await prisma.account.findFirst({
      where: { userId, provider: "google" },
    });
    if (!account?.access_token) return out;

    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
    );
    oauth2Client.setCredentials({
      access_token: account.access_token,
      refresh_token: account.refresh_token,
    });
    const calendar = google.calendar({ version: "v3", auth: oauth2Client });

    // settings.list() returns ALL user-level Calendar settings as a flat
    // list of {id, value} pairs. One round-trip beats six .get() calls.
    const res = await calendar.settings.list();
    const items = res.data.items ?? [];
    const map = new Map<string, string>();
    for (const item of items) {
      if (item.id && item.value !== undefined && item.value !== null) {
        map.set(item.id, item.value);
      }
    }

    // timezone — IANA string, virtually always present.
    const tz = map.get("timezone");
    if (tz && typeof tz === "string" && tz.length > 0) {
      out.timezone = tz;
    }

    // locale — BCP-47, e.g. "en".
    const locale = map.get("locale");
    if (locale && typeof locale === "string" && locale.length > 0) {
      out.locale = locale;
    }

    // weekStart — Google returns "0".."6" as a string.
    const ws = map.get("weekStart");
    if (ws !== undefined) {
      const parsed = parseInt(ws, 10);
      if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 6) {
        out.weekStart = parsed;
      }
    }

    // format24HourTime — "true" / "false".
    const fmt24 = map.get("format24HourTime");
    if (fmt24 === "true") out.use24HourTime = true;
    else if (fmt24 === "false") out.use24HourTime = false;

    // defaultEventLength — minutes as a string. Round to allowed set.
    const dur = map.get("defaultEventLength");
    if (dur !== undefined) {
      const parsed = parseInt(dur, 10);
      const rounded = roundDuration(parsed);
      if (rounded !== undefined) out.defaultDuration = rounded;
    }

    // autoAddVideoCalls — "true" / "false". Soft signal that Meet is
    // their preferred provider. We don't switch away from Meet on
    // "false" because Google doesn't expose what they DO prefer.
    const autoVideo = map.get("autoAddVideoCalls");
    if (autoVideo === "true") out.prefersMeet = true;

    // primaryCalendarId — second round-trip to calendarList. Google's
    // canonical alias "primary" is a valid id at the API level but doesn't
    // match the email-keyed entries that calendarList.list() enumerates.
    // The manage-calendars dropdown + scoring filters compare
    // activeCalendarIds against those enumerated ids, so storing the
    // literal "primary" produces zero matches and no calendar reads as
    // primary in the UI. Resolving once at signup eliminates the literal-
    // vs-enumerated drift everywhere downstream. Defensive: failure of
    // this call returns the rest of the seed unchanged — the literal
    // "primary" fallback in seed-defaults still works for scoring (Google
    // resolves the alias server-side), the only loss is the UI badge.
    try {
      const calList = await calendar.calendarList.list();
      const primary = (calList.data.items ?? []).find((c) => c.primary);
      if (primary?.id) out.primaryCalendarId = primary.id;
    } catch (innerErr) {
      console.warn(
        "[google-onboarding-seed] calendarList fetch failed; primaryCalendarId omitted:",
        innerErr,
      );
    }
  } catch (e) {
    console.error("[google-onboarding-seed] fetch failed:", e);
    // Return whatever was populated before the failure (likely {}).
  }

  return out;
}
