/**
 * Link-scoped posture resolution.
 *
 * `getLinkPosture(link, user)` returns the resolved scheduling posture for
 * a given link record. Single read primitive that every reader site
 * (scoring engine, agent composer, MCP availability resolver, deal-room
 * context builder, link-landing greeting builder) consumes — eliminates
 * the four-surface drift the April-23 convergence proposal warned about.
 *
 * For variance links (`type !== "primary"`): reads exclusively from
 * `link.parameters.*`. No fallback to `user.preferences` — variance
 * parameters are complete by construction (snapshot at create time +
 * propagation via "Apply to all" or chat fan-out). If a variance is
 * missing a required field, throws — guards against future schema
 * additions, partial saves, or backfill misses leaving sparse data.
 *
 * For Primary (`link == null` or `type === "primary"`): shadows
 * `user.preferences.explicit.*` into the same shape. Primary stays
 * implicit on User per the parent proposal §3.3.
 *
 * Decision references:
 *  - `proposals/2026-05-02_per-link-config-storage-and-scoring-link-scope_*`
 *    §2.2 (helper definition + lint rule), §2.3 (no fallback semantics)
 *  - `proposals/2026-05-02_primary-as-posture-and-reusable-link-propagation_*`
 *    §2.2 (hardcoded full-config per variance, no inheritance)
 */

import type { NegotiationLink } from "@prisma/client";
import {
  parseLinkParameters,
  type ParsedLinkParameters,
} from "../link-parameters";
import type {
  CompiledRules,
  UserPreferences,
} from "../scoring";

/** Resolved posture — the unified shape every reader site consumes.
 *  Fields mirror what `User.preferences.explicit.*` and
 *  `User.preferences.compiled.*` together hold today, plus a few
 *  scalars the V1.5 proposal hoists out of structuredRules. */
export interface ResolvedPosture {
  /** Window start, minute-of-day 0–1440 (30-minute aligned). */
  hoursStartMinutes: number;
  /** Window end, minute-of-day 0–1440 (30-minute aligned). */
  hoursEndMinutes: number;
  /** Days the link is offerable, ISO weekday numbers (0=Sun..6=Sat). */
  daysOfWeek: number[];
  /** Slot length in minutes (15, 30, 45, 60, 90). */
  defaultDuration: number;
  /** Buffer minutes around bookings. 0 = no buffer (explicit). */
  bufferMinutes: number;
  /** Default meeting format. */
  format: "video" | "phone" | "in-person";
  /** Evenings posture: protected (no evenings), vip_only, open. */
  eveningsPosture: "protected" | "vip_only" | "open";
  /** Compiled rule state (buffers + priorityBuckets + allowWindows). */
  compiled: CompiledRules;
  /** Host's default location (private — never surfaced to guests). */
  defaultLocation?: string;
  /** ISO date strings the host is unavailable. */
  blackoutDays: string[];
}

/** Liberal shape accepted on the `link` arg — anything that has
 *  a `type` and `parameters` field is enough. Lets callers pass a
 *  Prisma row, a partial selection, or a synthesized "primary" stand-in. */
export interface LinkContext {
  type?: NegotiationLink["type"];
  parameters?: NegotiationLink["parameters"];
}

const DEFAULT_DAYS_OF_WEEK = [1, 2, 3, 4, 5]; // Mon–Fri
const DEFAULT_DURATION_MINUTES = 30;
const DEFAULT_BUFFER_MINUTES = 0;
const DEFAULT_FORMAT: ResolvedPosture["format"] = "video";
const DEFAULT_EVENINGS_POSTURE: ResolvedPosture["eveningsPosture"] = "protected";
const DEFAULT_HOURS_START_MINUTES = 9 * 60;
const DEFAULT_HOURS_END_MINUTES = 18 * 60;

/** Resolve scheduling posture for a link.
 *
 *  @param link       The link the guest is booking through. Pass `null`
 *                    or any link with `type === "primary"` to get the
 *                    user-level posture (Primary stays implicit on User).
 *  @param user       The host user. Required — variance reads use it
 *                    only as a default-of-last-resort for fields that
 *                    weren't migrated yet (see §below); Primary reads
 *                    use it as the source.
 *
 *  @throws when a variance link is missing a required posture field.
 *          Guards against the silent-fallback class of bugs that V1.5
 *          exists to prevent.
 */
export function getLinkPosture(
  link: LinkContext | null,
  user: { preferences?: UserPreferences | null } | null
): ResolvedPosture {
  const isVariance = !!link && link.type && link.type !== "primary";
  if (isVariance) {
    return resolveFromVariance(link as LinkContext);
  }
  return resolveFromUser(user);
}

function resolveFromVariance(link: LinkContext): ResolvedPosture {
  const params: ParsedLinkParameters = parseLinkParameters(link.parameters);
  const missing: string[] = [];

  // Hours
  if (!("hoursStartMinutes" in params)) missing.push("hoursStartMinutes");
  if (!("hoursEndMinutes" in params)) missing.push("hoursEndMinutes");
  // Days
  if (!("daysOfWeek" in params)) missing.push("daysOfWeek");
  // Duration
  if (!("duration" in params)) missing.push("duration");
  // Buffer
  if (!("bufferMinutes" in params)) missing.push("bufferMinutes");
  // Format
  if (!("format" in params)) missing.push("format");
  // Evenings posture — defaultable; not a hard error if missing
  // Compiled rules — defaultable to empty arrays if missing

  if (missing.length > 0) {
    throw new Error(
      `[getLinkPosture] variance link is missing required posture fields: ${missing.join(
        ", "
      )}. ` +
        `Variance parameters must be complete by construction — backfill the link or audit ` +
        `the variance-create path. See proposal 2026-05-02_per-link-config-storage-and-scoring-link-scope §2.2.`
    );
  }

  return {
    hoursStartMinutes: params.hoursStartMinutes!,
    hoursEndMinutes: params.hoursEndMinutes!,
    daysOfWeek: params.daysOfWeek!,
    defaultDuration: params.duration!,
    bufferMinutes: params.bufferMinutes!,
    format: (params.format as ResolvedPosture["format"]) ?? DEFAULT_FORMAT,
    eveningsPosture: params.eveningsPosture ?? DEFAULT_EVENINGS_POSTURE,
    compiled: {
      blockedWindows: [],
      allowWindows: params.compiled?.allowWindows ?? [],
      buffers: params.compiled?.buffers ?? [],
      priorityBuckets: params.compiled?.priorityBuckets ?? [],
      conditionalBuffers: [],
      ambiguities: params.compiled?.ambiguities ?? [],
      blackoutDays: [],
    } as unknown as CompiledRules,
    blackoutDays: [],
    // defaultLocation intentionally omitted on variance reads — host-private
  };
}

function resolveFromUser(
  user: { preferences?: UserPreferences | null } | null
): ResolvedPosture {
  const prefs = user?.preferences ?? {};
  const explicit = prefs.explicit ?? {};

  // Hours: prefer minute-of-day fields; fall back to hour * 60 for
  // pre-April-23 rows that haven't been migrated yet.
  const hoursStartMinutes =
    explicit.businessHoursStartMinutes ??
    (typeof explicit.businessHoursStart === "number"
      ? explicit.businessHoursStart * 60
      : DEFAULT_HOURS_START_MINUTES);
  const hoursEndMinutes =
    explicit.businessHoursEndMinutes ??
    (typeof explicit.businessHoursEnd === "number"
      ? explicit.businessHoursEnd * 60
      : DEFAULT_HOURS_END_MINUTES);

  // Days: not stored at the user-level today (implicit weekdays). Use
  // Mon–Fri default. Per-day overrides live in compiled.allowWindows.
  const daysOfWeek = DEFAULT_DAYS_OF_WEEK;

  // Compiled rules read straight off preferences (existing convention).
  const compiledRaw = (prefs as { compiled?: unknown }).compiled;
  const compiled =
    compiledRaw && typeof compiledRaw === "object"
      ? (compiledRaw as CompiledRules)
      : ({
          blockedWindows: [],
          allowWindows: [],
          buffers: [],
          priorityBuckets: [],
          conditionalBuffers: [],
          ambiguities: [],
          blackoutDays: [],
        } as unknown as CompiledRules);

  return {
    hoursStartMinutes,
    hoursEndMinutes,
    daysOfWeek,
    defaultDuration: explicit.defaultDuration ?? DEFAULT_DURATION_MINUTES,
    bufferMinutes: explicit.bufferMinutes ?? DEFAULT_BUFFER_MINUTES,
    format:
      (explicit.videoProvider === "zoom" ? "video" : undefined) ??
      DEFAULT_FORMAT,
    eveningsPosture: DEFAULT_EVENINGS_POSTURE,
    compiled,
    defaultLocation: explicit.defaultLocation,
    blackoutDays: explicit.blackoutDays ?? [],
  };
}
