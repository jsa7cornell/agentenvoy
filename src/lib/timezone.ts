/**
 * Canonical timezone module.
 *
 * Single source of truth for:
 *   1. Reading a user's timezone (getUserTimezone)
 *   2. Validating a timezone against the supported list (isSupportedTimezone)
 *   3. Rendering a timezone as short/long human labels
 *
 * Design rules:
 *   - IANA strings are the ONLY concrete form used for calculations.
 *   - LLMs never emit an IANA string into stored data. Action handlers
 *     ignore any `timezone` field in LLM output and look up the host's
 *     canonical TZ via getUserTimezone().
 *   - Short labels are safe: we only emit an abbreviation when it is
 *     globally unambiguous. Ambiguous zones (CST-China, IST-India,
 *     BST-Bangladesh) fall back to "GMT+N" rather than risk collision
 *     with their US/UK counterparts.
 */

export interface TimezoneEntry {
  /** IANA identifier — the only form used for date math. */
  iana: string;
  /** Short abbreviation for compact UI (calendar headers, badges). */
  short: string;
  /** Short abbreviation when DST is active, if different. */
  shortDst?: string;
  /** Long human label for prose (greetings, tooltips). */
  long: string;
  /** Region grouping for onboarding/account dropdowns. */
  region: "Americas" | "Europe" | "Asia" | "Pacific";
}

/**
 * The supported timezone table.
 *
 * Ordering matters — this is the order shown in onboarding and the
 * account page dropdown. Add new zones in the appropriate region block.
 *
 * When picking `short`: Intl's `timeZoneName: "short"` is the source
 * of truth for Americas + UK (it handles DST automatically). For other
 * zones we hand-pick an unambiguous abbreviation. If no unambiguous
 * abbreviation exists, leave `short` as a GMT offset — never reuse an
 * abbreviation that collides with another zone in this table.
 */
export const TIMEZONE_TABLE: TimezoneEntry[] = [
  // Americas
  { iana: "America/New_York",    short: "EST",  shortDst: "EDT",  long: "Eastern time",    region: "Americas" },
  { iana: "America/Chicago",     short: "CST",  shortDst: "CDT",  long: "Central time",    region: "Americas" },
  { iana: "America/Denver",      short: "MST",  shortDst: "MDT",  long: "Mountain time",   region: "Americas" },
  { iana: "America/Los_Angeles", short: "PST",  shortDst: "PDT",  long: "Pacific time",    region: "Americas" },
  { iana: "America/Phoenix",     short: "MST",                    long: "Arizona time",    region: "Americas" },
  { iana: "America/Anchorage",   short: "AKST", shortDst: "AKDT", long: "Alaska time",     region: "Americas" },
  { iana: "Pacific/Honolulu",    short: "HST",                    long: "Hawaii time",     region: "Americas" },

  // Europe
  { iana: "Europe/London",       short: "GMT",  shortDst: "BST",  long: "UK time",         region: "Europe" },
  { iana: "Europe/Paris",        short: "CET",  shortDst: "CEST", long: "Central European time", region: "Europe" },
  { iana: "Europe/Berlin",       short: "CET",  shortDst: "CEST", long: "Central European time", region: "Europe" },

  // Asia — note: "IST" is ambiguous (India/Ireland/Israel), "CST" is
  // ambiguous with US Central, so Kolkata/Shanghai use GMT offsets.
  { iana: "Asia/Tokyo",          short: "JST",                    long: "Japan time",      region: "Asia" },
  { iana: "Asia/Shanghai",       short: "GMT+8",                  long: "China time",      region: "Asia" },
  { iana: "Asia/Singapore",      short: "SGT",                    long: "Singapore time",  region: "Asia" },
  { iana: "Asia/Hong_Kong",      short: "HKT",                    long: "Hong Kong time",  region: "Asia" },
  { iana: "Asia/Kolkata",        short: "GMT+5:30",               long: "India time",      region: "Asia" },

  // Pacific
  { iana: "Australia/Sydney",    short: "AEST", shortDst: "AEDT", long: "Sydney time",     region: "Pacific" },
  { iana: "Australia/Perth",     short: "AWST",                   long: "Perth time",      region: "Pacific" },
  { iana: "Pacific/Auckland",    short: "NZST", shortDst: "NZDT", long: "New Zealand time", region: "Pacific" },
];

const BY_IANA: Map<string, TimezoneEntry> = new Map(
  TIMEZONE_TABLE.map((e) => [e.iana, e])
);

export const DEFAULT_TIMEZONE = "America/Los_Angeles";

// ─── User preference reading ─────────────────────────────────────────────────

/**
 * The ONLY supported shape for reading a host's timezone.
 *
 * Reads `preferences.explicit.timezone`. The top-level legacy field
 * `preferences.timezone` is NOT consulted — it has been migrated.
 *
 * Returns a validated IANA string, falling back to DEFAULT_TIMEZONE.
 * Logs a warning when falling back so latent bugs surface instead of
 * silently rendering in LA.
 */
export function getUserTimezone(
  preferences: Record<string, unknown> | null | undefined
): string {
  if (!preferences) return DEFAULT_TIMEZONE;
  const explicit = (preferences.explicit as Record<string, unknown> | undefined) || {};
  const raw = explicit.timezone as string | undefined;
  if (!raw) {
    // Legacy field — log so we know migration is incomplete, but still honor it.
    const legacy = (preferences as Record<string, unknown>).timezone as string | undefined;
    if (legacy) {
      if (typeof console !== "undefined") {
        console.warn(
          `[timezone] Reading legacy preferences.timezone="${legacy}" — migrate to preferences.explicit.timezone`
        );
      }
      return safeTimezone(legacy);
    }
    return DEFAULT_TIMEZONE;
  }
  return safeTimezone(raw);
}

/**
 * Validate an IANA timezone string. Returns the timezone if valid, or
 * DEFAULT_TIMEZONE. Logs loudly when falling back.
 */
export function safeTimezone(tz: string | undefined | null): string {
  if (!tz) return DEFAULT_TIMEZONE;
  try {
    // Throws if tz is not a valid IANA identifier.
    new Intl.DateTimeFormat(undefined, { timeZone: tz });
    return tz;
  } catch {
    if (typeof console !== "undefined") {
      console.warn(`[timezone] Invalid IANA string "${tz}" — falling back to ${DEFAULT_TIMEZONE}`);
    }
    return DEFAULT_TIMEZONE;
  }
}

/** True if the given IANA string is in TIMEZONE_TABLE. */
export function isSupportedTimezone(iana: string): boolean {
  return BY_IANA.has(iana);
}

/** Look up a table entry, or null if unknown. */
export function getTimezoneEntry(iana: string): TimezoneEntry | null {
  return BY_IANA.get(iana) ?? null;
}

// ─── Display labels ──────────────────────────────────────────────────────────

/**
 * Short label for compact UI — "PST", "PDT", "CET", "GMT+5:30".
 *
 * Resolution order:
 *   1. Native Intl `timeZoneName: "short"` — wins for Americas + UK and
 *      handles DST automatically.
 *   2. TIMEZONE_TABLE entry with DST awareness.
 *   3. Intl's `GMT+N` fallback.
 *
 * Always pass a Date when you need a deterministic answer (tests,
 * server-rendered greetings for a specific slot).
 */
export function shortTimezoneLabel(
  iana: string,
  date: Date = new Date()
): string {
  // 1. Try native Intl. It returns real abbreviations for US/UK zones
  //    and "GMT+N" for most others. Accept only the real ones.
  try {
    const native = new Intl.DateTimeFormat("en-US", {
      timeZone: iana,
      timeZoneName: "short",
    })
      .formatToParts(date)
      .find((p) => p.type === "timeZoneName")?.value;

    if (native && !/^(GMT|UTC)[+\-]/.test(native)) {
      return native;
    }
  } catch {
    // fall through to table lookup
  }

  // 2. Use the table. Handle DST if `shortDst` is set.
  const entry = BY_IANA.get(iana);
  if (entry) {
    if (entry.shortDst && isDstActive(iana, date)) return entry.shortDst;
    return entry.short;
  }

  // 3. Last resort: Intl's GMT offset.
  try {
    const fallback = new Intl.DateTimeFormat("en-US", {
      timeZone: iana,
      timeZoneName: "short",
    })
      .formatToParts(date)
      .find((p) => p.type === "timeZoneName")?.value;
    return fallback ?? iana;
  } catch {
    return iana;
  }
}

/**
 * Long label for prose — "Pacific time", "Japan time", "Central European time".
 *
 * Used in guest greetings where a friendly name reads better than an
 * abbreviation. Prefers the hand-curated TIMEZONE_TABLE entry; falls
 * back to Intl's long name with US zones collapsed ("Pacific Daylight
 * Time" → "Pacific time") for zones not in the table.
 */
export function longTimezoneLabel(iana: string): string {
  const entry = BY_IANA.get(iana);
  if (entry) return entry.long;

  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: iana,
      timeZoneName: "long",
    }).formatToParts(new Date());
    const name = parts.find((p) => p.type === "timeZoneName")?.value || iana;
    return name.replace(
      /\b(Pacific|Eastern|Central|Mountain|Atlantic|Alaska|Hawaii(?:-Aleutian)?)\s+(Daylight|Standard)\s+Time\b/,
      "$1 time"
    );
  } catch {
    return iana;
  }
}

// ─── DST detection ───────────────────────────────────────────────────────────

/** True if the given zone observes DST and is in the DST half of the year. */
function isDstActive(iana: string, date: Date): boolean {
  const jan = new Date(date.getFullYear(), 0, 1);
  const janOffset = getOffsetMinutes(iana, jan);
  const nowOffset = getOffsetMinutes(iana, date);
  return nowOffset !== janOffset && nowOffset > janOffset;
}

function getOffsetMinutes(iana: string, date: Date): number {
  // Compute the offset by comparing the same instant rendered as UTC vs in the zone.
  const utcString = date.toLocaleString("en-US", { timeZone: "UTC" });
  const zoneString = date.toLocaleString("en-US", { timeZone: iana });
  const utc = new Date(utcString);
  const zone = new Date(zoneString);
  return (zone.getTime() - utc.getTime()) / 60000;
}
