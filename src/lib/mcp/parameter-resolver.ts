/**
 * Parameter resolver — single source of truth for §2.3 state envelopes
 * (parent MCP proposal: `2026-04-18_mcp-two-envoy-handshake_reviewed-2026-04-18.md`).
 *
 * Consumed by `get_meeting_parameters`, `propose_parameters`, and
 * `propose_lock` validation. The resolver walks the fallback chain
 *   link-rule → host-profile-default → system-default
 * for each parameter field and emits a `ParameterEnvelope` describing:
 *   - current value (nullable)
 *   - where it came from (`origin`)
 *   - who can change it (`mutability`)
 *   - explicit `allowedValues` / `suggestions` when present
 *   - `guestMustResolve` — the single bit the guest agent checks before
 *     calling `propose_lock`
 *
 * **Mutability states** (from §2.3):
 *   - `locked`       host set it via link rules; guest cannot change
 *   - `host-filled`  server will fill from `User.preferences` at lock time
 *   - `delegated`    guest picks from `allowedValues` (explicit or default)
 *   - `open`         guest any plausible value; host consents async
 *   - `required`     pre-migration link; guest must pick before lock
 *
 * **Format filters (2026-04-20 addendum, SPEC.md §1).** When a caller passes
 * a `slotStart`, we subtract any `formatFilters` (from `CompiledRules`) whose
 * window / weekday / date range matches the slot. An in-person format is
 * removed from `allowedValues` rather than letting it 409 later at
 * `/api/negotiate/confirm` as `in_person_disallowed`.
 *
 * **Parameter-resolver and `normalizeLinkParameters` alignment** (N1 from reviewer).
 * Any new key added to `LinkParameters.guestPicks` or `LinkParameters.guestGuidance`
 * must get a resolver branch here — or agents won't see it. A completeness
 * test (`src/__tests__/unit/parameter-resolver.test.ts`) enforces this at CI.
 */
import type { LinkParameters, UserPreferences, CompiledRules } from "@/lib/scoring";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FormatValue = "video" | "phone" | "in-person";

export type ParameterOrigin =
  | "link-rule"
  | "host-profile-default"
  | "system-default"
  | "unset";

export type ParameterMutability =
  | "locked"
  | "host-filled"
  | "delegated"
  | "open"
  | "required";

export interface ParameterEnvelope<T> {
  value: T | null;
  origin: ParameterOrigin;
  mutability: ParameterMutability;
  allowedValues?: T[];
  suggestions?: T[];
  /**
   * Host's single preferred value within `allowedValues`. Emitted ONLY under
   * `delegated` mutability in v1 (format-only; duration/location/timezone
   * deferred). Invariant: `preferred ∈ allowedValues` whenever both present;
   * the resolver drops `preferred` silently when per-slot narrowing removes
   * it from `allowedValues`. Advisory-only — `propose_lock` validates
   * against `allowedValues`, never against `preferred`.
   *
   * See proposal 2026-04-20_mcp-envelope-preferred-primitive and SPEC §2.3.
   */
  preferred?: T;
  guestMustResolve: boolean;
}

export interface ResolvedParameters {
  format: ParameterEnvelope<FormatValue>;
  duration: ParameterEnvelope<number>;
  location: ParameterEnvelope<string>;
  timezone: ParameterEnvelope<string>;
  /** Union of fields whose `guestMustResolve === true` — convenience for callers. */
  guestMustResolve: Array<keyof Omit<ResolvedParameters, "guestMustResolve">>;
}

export interface ResolveInput {
  rules: LinkParameters;
  hostPreferences: UserPreferences | null | undefined;
  /** Host's timezone, fed from `getUserTimezone()`. */
  hostTimezone: string;
  /**
   * Optional: when resolving for a specific slot, subtract matching
   * `formatFilters` from `format.allowedValues`. When absent, the envelope
   * reflects link-level rules only and consumers (e.g. propose_lock) must
   * narrow per-slot themselves.
   */
  slotStart?: Date;
  /**
   * Optional: `CompiledRules` from the host's preferences. Only the
   * `formatFilters` field is read here. When absent, no filter subtraction
   * happens.
   */
  compiledRules?: CompiledRules | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SYSTEM_DEFAULT_FORMATS: FormatValue[] = ["video", "phone", "in-person"];
const SYSTEM_DEFAULT_DURATION_MINUTES = 30;

/**
 * Static cap for guest-proposed durations under `guestPicks.duration: true`.
 * Enforced by the `lock_session_duration` action handler, not the resolver
 * (the envelope omits `allowedValues` for the open boolean form so the chat
 * composer can present the cap dynamically as refusal copy). Reusable-link
 * guest-picks proposal, decided 2026-04-28.
 */
export const GUEST_PICKS_DURATION_MIN_MINUTES = 15;
export const GUEST_PICKS_DURATION_MAX_MINUTES = 240;
const SHORT_DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

// ---------------------------------------------------------------------------
// Format filter subtraction (per SPEC.md addendum §1)
// ---------------------------------------------------------------------------

/**
 * Given a list of allowed formats and the host's `formatFilters`, remove any
 * format that is disallowed at `slotStart` in `timezone`. A filter matches
 * when ALL present guards match: `days`, `start`/`end` (HH:MM), `effective`
 * (ISO date, earliest applicable), and `expires` (ISO date, last applicable).
 *
 * Pure function — exported for unit testing.
 */
export function subtractFormatFilters(
  allowed: FormatValue[],
  formatFilters: NonNullable<CompiledRules["formatFilters"]>,
  slotStart: Date,
  timezone: string
): FormatValue[] {
  if (!formatFilters.length) return allowed;

  // Derive the slot's local weekday and HH:MM in the host's tz, plus its
  // ISO date ("YYYY-MM-DD"). We use `Intl.DateTimeFormat` parts to avoid
  // drifting at DST boundaries.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(slotStart);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const weekday = get("weekday"); // "Mon".."Sun" (en-US short)
  const isoDate = `${get("year")}-${get("month")}-${get("day")}`;
  const hhmm = `${get("hour") === "24" ? "00" : get("hour")}:${get("minute")}`;

  // Normalize weekday to canonical short form used by CompiledRules.
  const canonicalWeekday = SHORT_DAY_NAMES.find(
    (d) => d.toLowerCase() === weekday.toLowerCase()
  );

  const disallowed = new Set<string>();
  for (const f of formatFilters) {
    if (f.effective && isoDate < f.effective) continue;
    if (f.expires && isoDate > f.expires) continue;
    if (f.days?.length && canonicalWeekday && !f.days.includes(canonicalWeekday))
      continue;
    if (f.start && hhmm < f.start) continue;
    if (f.end && hhmm >= f.end) continue;
    for (const fmt of f.disallowFormats) disallowed.add(fmt);
  }

  return allowed.filter((a) => !disallowed.has(a));
}

// ---------------------------------------------------------------------------
// Field resolvers
// ---------------------------------------------------------------------------

function resolveFormat(input: ResolveInput): ParameterEnvelope<FormatValue> {
  const { rules, compiledRules, slotStart, hostTimezone } = input;

  const narrow = (formats: FormatValue[]): FormatValue[] => {
    if (!slotStart || !compiledRules?.formatFilters?.length) return formats;
    return subtractFormatFilters(formats, compiledRules.formatFilters, slotStart, hostTimezone);
  };

  // v1: `preferred` is format-only; see proposal
  // 2026-04-20_mcp-envelope-preferred-primitive. Computed once here, scoped
  // by `preferred ∈ narrowed` so per-slot filter subtraction that removes
  // the host's lean drops it silently rather than emitting a ghost hint.
  const explicitPreferredCandidate = rules.guestGuidance?.preferredFormat;
  const pickPreferred = (narrowed: FormatValue[]): FormatValue | undefined =>
    explicitPreferredCandidate && narrowed.includes(explicitPreferredCandidate)
      ? explicitPreferredCandidate
      : undefined;

  // 1. Host set rules.format AND opted into guestPicks.format → delegated-with-default.
  //    The host's value holds if the guest doesn't engage; the dimension is
  //    flagged as mutable so the chat composer / MCP guest agent may propose
  //    a swap. `preferred` carries the host's lean (rules.format itself, or
  //    guestGuidance.preferredFormat if explicitly different). Reusable-link
  //    guest-picks proposal, decided 2026-04-28.
  if (rules.format && (rules.guestPicks?.format === true || Array.isArray(rules.guestPicks?.format))) {
    const raw = rules.format as FormatValue;
    const allow: FormatValue[] = Array.isArray(rules.guestPicks.format)
      ? (rules.guestPicks.format as FormatValue[])
      : [...SYSTEM_DEFAULT_FORMATS];
    const narrowed = narrow(allow);
    const survived = narrowed.includes(raw);
    // Prefer the explicit preferredFormat if set; otherwise fall back to rules.format
    // when it survived narrowing. preferred ∈ allowedValues invariant enforced.
    const preferred = pickPreferred(narrowed) ?? (survived ? raw : undefined);
    return {
      value: survived ? raw : null,
      origin: "link-rule",
      mutability: "delegated",
      allowedValues: narrowed,
      ...(preferred ? { preferred } : {}),
      guestMustResolve: false,
    };
  }

  // 2. Host picked explicitly → locked (but narrow per formatFilters for
  //    per-slot correctness: if the host locks "in-person" and the slot sits
  //    inside a no_in_person window, the lock is broken and we surface
  //    `value: null` so callers refuse before /confirm does).
  if (rules.format) {
    const raw = rules.format as FormatValue;
    const narrowed = narrow([raw]);
    const survived = narrowed.includes(raw);
    return {
      value: survived ? raw : null,
      origin: "link-rule",
      mutability: "locked",
      guestMustResolve: false,
      allowedValues: narrowed,
    };
  }

  // 3. Guest picks — explicit allow-list (host did NOT lock format).
  if (Array.isArray(rules.guestPicks?.format)) {
    const arr = rules.guestPicks.format as FormatValue[];
    const narrowed = narrow(arr);
    const preferred = pickPreferred(narrowed);
    return {
      value: null,
      origin: "link-rule",
      mutability: "delegated",
      allowedValues: narrowed,
      ...(preferred ? { preferred } : {}),
      guestMustResolve: true,
    };
  }

  // 4. Guest picks — any system-default (host did NOT lock format).
  if (rules.guestPicks?.format === true) {
    const narrowed = narrow([...SYSTEM_DEFAULT_FORMATS]);
    const preferred = pickPreferred(narrowed);
    return {
      value: null,
      origin: "system-default",
      mutability: "delegated",
      allowedValues: narrowed,
      ...(preferred ? { preferred } : {}),
      guestMustResolve: true,
    };
  }

  // 5. Pre-migration link: neither host nor guestPicks declared format.
  //    `scripts/migrate-links-to-guest-picks-format.ts` will backfill these
  //    to `guestPicks.format: true`; until then, format is `required`.
  return {
    value: null,
    origin: "unset",
    mutability: "required",
    allowedValues: narrow([...SYSTEM_DEFAULT_FORMATS]),
    guestMustResolve: true,
  };
}

function resolveDuration(input: ResolveInput): ParameterEnvelope<number> {
  const { rules, hostPreferences } = input;
  const ruleDuration =
    typeof rules.duration === "number" && rules.duration > 0 ? rules.duration : null;
  const suggestions = rules.guestGuidance?.suggestions?.durations;

  // 1. Host set rules.duration AND opted into guestPicks.duration → delegated-with-default.
  //    The host's value holds if the guest doesn't engage; the dimension is
  //    flagged as mutable so the chat composer / MCP guest agent may propose
  //    a different length. Reusable-link guest-picks proposal, decided 2026-04-28.
  //    `preferred` is format-only in v1 (see envelope docblock); duration
  //    expresses the host's lean directly via `value`.
  if (ruleDuration !== null && Array.isArray(rules.guestPicks?.duration)) {
    const list = rules.guestPicks.duration as number[];
    return {
      value: list.includes(ruleDuration) ? ruleDuration : null,
      origin: "link-rule",
      mutability: "delegated",
      allowedValues: list,
      ...(suggestions?.length ? { suggestions } : {}),
      guestMustResolve: false,
    };
  }
  if (ruleDuration !== null && rules.guestPicks?.duration === true) {
    return {
      value: ruleDuration,
      origin: "link-rule",
      mutability: "delegated",
      // No allowedValues — open within static cap [GUEST_PICKS_DURATION_MIN_MINUTES,
      // GUEST_PICKS_DURATION_MAX_MINUTES], enforced by the lock_session_duration
      // action handler. Composer surfaces refusal copy on cap miss.
      ...(suggestions?.length ? { suggestions } : {}),
      guestMustResolve: false,
    };
  }

  // 2. Guest-picks-only (host did NOT lock duration). Pre-existing semantics.
  if (Array.isArray(rules.guestPicks?.duration)) {
    const list = rules.guestPicks.duration as number[];
    return {
      value: null,
      origin: "link-rule",
      mutability: "delegated",
      allowedValues: list,
      ...(suggestions?.length ? { suggestions } : {}),
      guestMustResolve: true,
    };
  }
  if (rules.guestPicks?.duration === true) {
    return {
      value: null,
      origin: "link-rule",
      mutability: "open",
      ...(suggestions?.length ? { suggestions } : {}),
      guestMustResolve: true,
    };
  }

  // 3. Host locked a duration (no guestPicks override).
  if (ruleDuration !== null) {
    return {
      value: ruleDuration,
      origin: "link-rule",
      mutability: "locked",
      guestMustResolve: false,
    };
  }

  // 4. Host-profile default. UserPreferences has two paths (historical):
  //    top-level `defaultDuration` and `explicit.defaultDuration`.
  //    Precedence matches the rest of the codebase (agent/composer.ts:208).
  const profileDefault =
    hostPreferences?.defaultDuration ?? hostPreferences?.explicit?.defaultDuration;
  if (typeof profileDefault === "number" && profileDefault > 0) {
    return {
      value: profileDefault,
      origin: "host-profile-default",
      mutability: "host-filled",
      guestMustResolve: false,
    };
  }

  // 5. System default (30 min).
  return {
    value: SYSTEM_DEFAULT_DURATION_MINUTES,
    origin: "system-default",
    mutability: "host-filled",
    guestMustResolve: false,
  };
}

function resolveLocation(
  input: ResolveInput,
  format: ParameterEnvelope<FormatValue>
): ParameterEnvelope<string> {
  const { rules, hostPreferences } = input;
  const effectiveFormat = format.value;

  // Location only matters for in-person. When format is not yet `in-person`,
  // we still emit the envelope so the guest agent can prefetch the shape,
  // but mutability depends on the link's declared intent.
  const isInPerson = effectiveFormat === "in-person";

  // 1. Host locked a venue in the link.
  if (typeof rules.location === "string" && rules.location.trim()) {
    return {
      value: rules.location,
      origin: "link-rule",
      mutability: "locked",
      guestMustResolve: false,
    };
  }

  // 2. Guest picks location.
  if (rules.guestPicks?.location === true) {
    const suggestions = rules.guestGuidance?.suggestions?.locations;
    return {
      value: null,
      origin: "link-rule",
      mutability: "open",
      ...(suggestions?.length ? { suggestions } : {}),
      // Only blocking when format is (or will become) in-person. For video
      // / phone, location is cosmetic — guest need not resolve.
      guestMustResolve: isInPerson,
    };
  }

  // 3. Host-profile default (`explicit.defaultLocation`). Per §2.3 principle,
  //    this is silent (`host-filled`), never delegated.
  const defaultLocation = hostPreferences?.explicit?.defaultLocation;
  if (typeof defaultLocation === "string" && defaultLocation.trim()) {
    return {
      value: defaultLocation,
      origin: "host-profile-default",
      mutability: "host-filled",
      guestMustResolve: false,
    };
  }

  // 4. Unset. For in-person this is `host_profile_incomplete` at lock time
  //    (§2.3 host-filled-missing case). Surface it so propose_lock can
  //    refuse with that reason rather than creating a venueless event.
  return {
    value: null,
    origin: "unset",
    mutability: isInPerson ? "required" : "host-filled",
    guestMustResolve: isInPerson,
  };
}

function resolveTimezone(input: ResolveInput): ParameterEnvelope<string> {
  return {
    value: input.hostTimezone,
    origin: "host-profile-default",
    mutability: "locked",
    guestMustResolve: false,
  };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function resolveParameters(input: ResolveInput): ResolvedParameters {
  const format = resolveFormat(input);
  const duration = resolveDuration(input);
  const location = resolveLocation(input, format);
  const timezone = resolveTimezone(input);

  const guestMustResolve: ResolvedParameters["guestMustResolve"] = [];
  if (format.guestMustResolve) guestMustResolve.push("format");
  if (duration.guestMustResolve) guestMustResolve.push("duration");
  if (location.guestMustResolve) guestMustResolve.push("location");
  if (timezone.guestMustResolve) guestMustResolve.push("timezone");

  return { format, duration, location, timezone, guestMustResolve };
}
