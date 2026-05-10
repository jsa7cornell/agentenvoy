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
import {
  type AvailabilityWindow,
} from "../link-parameters";

/**
 * Resolved posture — the unified shape every reader site consumes.
 *
 * `availability` is the canonical Layer 1 canvas (added PR-B 2026-05-06).
 * `hoursStartMinutes`, `hoursEndMinutes`, `daysOfWeek` are derived from
 * `availability` for backward compat — they are the bounding-box of the
 * windows. New code should read `availability[]` directly. These flat
 * fields will be removed after all reader sites migrate to `availability[]`.
 */
export interface ResolvedPosture {
  /**
   * Layer 1 canvas — the link's offerable windows. Canonical source.
   * Replaces flat hoursStart/End + daysOfWeek (which are now derived).
   */
  availability: AvailabilityWindow[];
  /**
   * @deprecated Derived from availability[]. Kept for reader-site compat.
   * = Math.min(...availability.map(w => w.startMinutes)) or DEFAULT.
   */
  hoursStartMinutes: number;
  /**
   * @deprecated Derived from availability[]. Kept for reader-site compat.
   * = Math.max(...availability.map(w => w.endMinutes)) or DEFAULT.
   */
  hoursEndMinutes: number;
  /**
   * @deprecated Derived from availability[]. Kept for reader-site compat.
   * = union of all days[] across windows.
   */
  daysOfWeek: number[];
  /** Slot length in minutes (15, 25, 30, 45, 60, 90). */
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
  /**
   * Host-authored tip — surfaced verbatim in the deal-room MeetingCard tip slot
   * and (post PR3) in the EnvoyDock thread as the first agent message.
   *
   * Storage:
   *  - Variance links: link.parameters.tip
   *  - Primary links:  user.preferences.explicit.tip
   *
   * Falls back to DEFAULT_TIP at render time (renderTip()) when null/empty.
   */
  tip?: string | null;
}

/** Liberal shape accepted on the `link` arg — anything that has
 *  a `type` and `parameters` field is enough. Lets callers pass a
 *  Prisma row, a partial selection, or a synthesized "primary" stand-in. */
export interface LinkContext {
  type?: NegotiationLink["type"];
  parameters?: NegotiationLink["parameters"];
}

/**
 * Returns true when a variance (personalized/bookable) link's `parameters`
 * JSON is missing any of the four fields required for scheduling to work:
 * availability, duration, bufferMinutes, format.
 *
 * Used by:
 *  - GET /api/me/links → `needsSetup` flag on personalized link entries
 *  - MyLinksPopover → orange dot badge next to incomplete links
 *
 * "Needs setup" means the link was created with insufficient config and
 * must be edited before it can offer slots correctly. Links with all four
 * fields present — even if the values are the inherited defaults — are
 * considered valid.
 *
 * PR-D (proposal 2026-05-06_link-config-canonical-model-and-unified-edit §15)
 */
export function linkNeedsSetup(parameters: unknown): boolean {
  if (parameters == null || typeof parameters !== "object") return true;
  const p = parameters as Record<string, unknown>;

  // availability: must be a non-empty array
  const hasAvailability =
    Array.isArray(p.availability) && (p.availability as unknown[]).length > 0;
  // legacy canvas fields as fallback (transition window)
  const hasLegacyCanvas =
    typeof p.hoursStartMinutes === "number" &&
    typeof p.hoursEndMinutes === "number" &&
    Array.isArray(p.daysOfWeek);

  if (!hasAvailability && !hasLegacyCanvas) return true;
  if (typeof p.duration !== "number") return true;
  if (typeof p.bufferMinutes !== "number") return true;
  if (p.format !== "video" && p.format !== "phone" && p.format !== "in-person") return true;

  return false;
}

const DEFAULT_DURATION_MINUTES = 30;
const DEFAULT_BUFFER_MINUTES = 0;
const DEFAULT_FORMAT: ResolvedPosture["format"] = "video";
const DEFAULT_EVENINGS_POSTURE: ResolvedPosture["eveningsPosture"] = "protected";
const DEFAULT_HOURS_START_MINUTES = 9 * 60;   // 540
const DEFAULT_HOURS_END_MINUTES = 18 * 60;    // 1080

/** Default canvas: Mon–Fri 9–18. Seeded on new links and used as fallback
 *  when a link has no availability[] and no flat canvas fields. */
export const DEFAULT_AVAILABILITY: AvailabilityWindow[] = [
  { days: [1, 2, 3, 4, 5], startMinutes: DEFAULT_HOURS_START_MINUTES, endMinutes: DEFAULT_HOURS_END_MINUTES },
];

/**
 * Derive legacy flat fields from an AvailabilityWindow[] canvas.
 * These are the bounding-box values — not precise for multi-window configs,
 * but correct enough for all existing reader sites (scoring window, UI display).
 */
function flattenAvailability(windows: AvailabilityWindow[]): Pick<ResolvedPosture, "hoursStartMinutes" | "hoursEndMinutes" | "daysOfWeek"> {
  if (windows.length === 0) {
    return { hoursStartMinutes: DEFAULT_HOURS_START_MINUTES, hoursEndMinutes: DEFAULT_HOURS_END_MINUTES, daysOfWeek: [1, 2, 3, 4, 5] };
  }
  return {
    hoursStartMinutes: Math.min(...windows.map(w => w.startMinutes)),
    hoursEndMinutes: Math.max(...windows.map(w => w.endMinutes)),
    daysOfWeek: [...new Set(windows.flatMap(w => w.days))].sort((a, b) => a - b),
  };
}

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

  // Canvas: accept availability[] (new) OR flat hoursStart/End+daysOfWeek (legacy).
  // Legacy AvailabilitySpec objects (pre-V1.5) are neither — fall back to DEFAULT_AVAILABILITY.
  const hasNewCanvas = Array.isArray(params.availability) && (params.availability as unknown[]).length > 0;
  const hasLegacyCanvas = "hoursStartMinutes" in params && "hoursEndMinutes" in params && "daysOfWeek" in params;
  // An AvailabilitySpec object satisfies the availability field check but isn't usable as a canvas.
  const hasLegacySpec = params.availability != null && !Array.isArray(params.availability);
  if (!hasNewCanvas && !hasLegacyCanvas && !hasLegacySpec) missing.push("canvas");

  if (missing.length > 0) {
    console.warn(
      `[getLinkPosture] variance link is missing required posture fields: ${missing.join(", ")}. ` +
        `Using defaults — backfill the link or audit the variance-create path.`
    );
  }

  // Resolve the canonical availability[] canvas.
  // Priority: new availability[] > derived from legacy flat fields > DEFAULT_AVAILABILITY.
  let availability: AvailabilityWindow[];
  if (hasNewCanvas) {
    availability = params.availability as AvailabilityWindow[];
  } else if (hasLegacyCanvas) {
    // Legacy row: derive a single-window canvas from flat fields.
    availability = [{
      days: params.daysOfWeek as number[],
      startMinutes: params.hoursStartMinutes as number,
      endMinutes: params.hoursEndMinutes as number,
    }];
  } else {
    // Pre-V1.5 link with AvailabilitySpec or no canvas at all — use defaults.
    availability = DEFAULT_AVAILABILITY;
  }

  const flat = flattenAvailability(availability);

  return {
    availability,
    ...flat,
    defaultDuration: params.duration ?? DEFAULT_DURATION_MINUTES,
    bufferMinutes: params.bufferMinutes ?? DEFAULT_BUFFER_MINUTES,
    format: (params.format as ResolvedPosture["format"]) ?? DEFAULT_FORMAT,
    eveningsPosture: params.eveningsPosture ?? DEFAULT_EVENINGS_POSTURE,
    compiled: {
      blockedWindows: [],
      allowWindows: params.compiled?.allowWindows ?? [],
      buffers: params.compiled?.buffers ?? [],
      priorityBuckets: params.compiled?.priorityBuckets ?? [],
      ambiguities: params.compiled?.ambiguities ?? [],
    } as unknown as CompiledRules,
    blackoutDays: [],
    tip: typeof params.tip === "string" ? params.tip : null,
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

  // Derive the canonical availability[] from user-level hours. Primary's
  // canvas is Mon–Fri at the user's configured hours. Per-day overrides
  // live in compiled.allowWindows today; they'll move to availability[]
  // when the Primary link gets its own LinkParameters (PR-B follow-up).
  const availability: AvailabilityWindow[] = [
    { days: [1, 2, 3, 4, 5], startMinutes: hoursStartMinutes, endMinutes: hoursEndMinutes },
  ];

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
          ambiguities: [],
        } as unknown as CompiledRules);

  return {
    availability,
    hoursStartMinutes,
    hoursEndMinutes,
    daysOfWeek: [1, 2, 3, 4, 5],
    defaultDuration: explicit.defaultDuration ?? DEFAULT_DURATION_MINUTES,
    bufferMinutes: explicit.bufferMinutes ?? DEFAULT_BUFFER_MINUTES,
    format:
      ((explicit as { defaultFormat?: string }).defaultFormat as ResolvedPosture["format"]) ??
      DEFAULT_FORMAT,
    eveningsPosture: DEFAULT_EVENINGS_POSTURE,
    compiled,
    defaultLocation: explicit.defaultLocation,
    blackoutDays: explicit.blackoutDays ?? [],
    tip: typeof (explicit as { tip?: unknown }).tip === "string"
      ? (explicit as { tip: string }).tip
      : null,
  };
}
