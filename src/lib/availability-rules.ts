/**
 * Structured availability rules — types, deterministic compiler, and lifecycle helpers.
 *
 * Rules are stored in preferences.explicit.structuredRules as an array.
 * The deterministic compiler converts active rules into the same CompiledRules
 * format consumed by the scoring engine — no LLM needed at compilation time.
 */

import type { CompiledRules, BlockedWindow, ProtectedWindow, AllowWindow, CompiledBuffer, CompiledPriorityBucket } from "./scoring";
import type { LinkRecurrence } from "./recurrence";

// --- Types ---

/**
 * A structured availability rule row. Authored by the host via natural language;
 * compiled deterministically into `CompiledRules` by `compileStructuredRules()`.
 *
 * DB column is `AvailabilityPreference` (legacy name — unchanged to avoid migration).
 * TS type is `AvailabilityRule` (renamed 2026-05-06 for vocabulary clarity).
 *
 * Note: `daysOfWeek` here means "when this rule applies" — separate from Layer 1
 * canvas `AvailabilityWindow.days` ("when the link offers time"). Both coexist;
 * do not conflate.
 */
export interface AvailabilityRule {
  id: string;
  originalText: string;
  type: "ongoing" | "recurring" | "temporary" | "one-time";
  action: "block" | "protect" | "allow" | "buffer" | "prefer" | "limit" | "location" | "bookable" | "no_in_person";
  timeStart?: string;     // "HH:MM" 24h
  timeEnd?: string;       // "HH:MM" 24h
  allDay?: boolean;
  daysOfWeek?: number[];  // 0=Sun, 6=Sat
  effectiveDate?: string; // ISO date
  expiryDate?: string;    // ISO date
  bufferMinutesBefore?: number;
  bufferMinutesAfter?: number;
  bufferAppliesTo?: string;
  locationLabel?: string; // for action: "location" — e.g. "Baja", "NYC"
  /**
   * Bookable link scoping — only present when action === "bookable".
   * Defines a public, shareable booking surface. The rule's time window +
   * days define when bookings are offerable; format/duration/title lock
   * the meeting type. linkCode is the public identifier used in the URL.
   */
  bookable?: {
    /** Link-directory-display name — the host-facing identifier shown in "My links"
     *  and matched by the recall intent ("what's my sales pitch link"). Per-host
     *  unique, case-insensitive. Added 2026-04-23 per reusable-links proposal R1.
     *  Optional for legacy rules created before 2026-04-23 — callers should use
     *  getBookableLinkDisplayName() which falls back to title. */
    name?: string;
    title: string;          // meeting-title semantic for calendar events
    format: "video" | "phone" | "in-person";
    durationMinutes: number;
    linkSlug: string;       // denormalized copy of user.meetSlug for fast URL construction
    linkCode: string;       // generated unique code — the /meet/{slug}/{code} identifier
    /**
     * Host opt-in: per-rule "let guests change format / duration" toggles.
     * Both default to absent/false — guests cannot change anything unless the host
     * flips a toggle. Read at session-creation time and merged into
     * link.parameters.guestPicks (defensive: only writes when the field is absent,
     * so an explicit allow-list set elsewhere is never clobbered). Reusable-link
     * guest-picks proposal, decided 2026-04-28.
     */
    guestPicks?: {
      format?: boolean;
      duration?: boolean;
    };
    /**
     * Recurrence template for child bookings made through this bookable link.
     * When set, every guest who books through the link gets a recurring series
     * anchored at their picked first slot. The child NegotiationLink inherits
     * `recurrence` from this field at session-spawn time. Omit for one-off-per-
     * booking bookable links (sales calls, office hours).
     *
     * The shape uses pre-anchor-commit semantics — `firstDateLocal` and `timeLocal`
     * are not set on the parent template; they're filled in on the child when the
     * guest picks. See `LinkRecurrence` in `lib/recurrence.ts` for the full shape.
     *
     * Added 2026-05-07 (UA refactor — UNIFIEDAGENT.md).
     */
    recurrence?: LinkRecurrence;
  };
  status: "active" | "paused" | "expired";
  priority: number;       // 1-5
  createdAt: string;      // ISO datetime
}

/** @deprecated Use `AvailabilityRule`. DB column name kept for legacy serialization. */
export type AvailabilityPreference = AvailabilityRule;

/**
 * Compiled bookable link entry — emitted from compileStructuredRules() alongside
 * CompiledRules. Each active bookable rule produces one entry. Consumed by the
 * bookable-links slot transform, not by the core scoring engine.
 */
export interface CompiledBookableLink {
  ruleId: string;
  linkCode: string;
  linkSlug: string;
  title: string;
  format: "video" | "phone" | "in-person";
  durationMinutes: number;
  // Window: when bookings are offerable, in the host's local time
  windowStart: string;    // "HH:MM"
  windowEnd: string;      // "HH:MM"
  daysOfWeek: number[];   // 0=Sun..6=Sat; empty = every day
  expiryDate?: string;    // ISO date
}

/**
 * Resolve the host-facing display name for a bookable link rule. Prefers the
 * explicit `name` field; falls back to `title` for legacy rules created before
 * 2026-04-23. Used for "My links" popover labels, uniqueness checks, and recall
 * matching. Trimmed; case preserved.
 */
export function getBookableLinkDisplayName(bookable: NonNullable<AvailabilityRule["bookable"]>): string {
  const n = (bookable.name ?? "").trim();
  if (n) return n;
  return (bookable.title ?? "").trim() || "Bookable Link";
}

/**
 * Normalize a reusable-link name for uniqueness comparison: lowercase, trim,
 * collapse internal whitespace. "Sales Pitch" == "sales pitch" == " sales  pitch ".
 */
export function normalizeLinkName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Return the active location rule for today, if any.
 * An active rule is one with status "active" whose effectiveDate has started
 * and whose expiryDate has not passed. Picks highest priority.
 */
export function getActiveLocationRule(rules: AvailabilityRule[] | undefined | null): AvailabilityRule | null {
  if (!rules || rules.length === 0) return null;
  const today = new Date().toISOString().slice(0, 10);
  const candidates = rules
    .filter((r) => r.action === "location" && r.status === "active" && r.locationLabel)
    .filter((r) => !r.effectiveDate || r.effectiveDate <= today)
    .filter((r) => !r.expiryDate || r.expiryDate >= today)
    .sort((a, b) => b.priority - a.priority || b.createdAt.localeCompare(a.createdAt));
  return candidates[0] ?? null;
}

// --- Lifecycle ---

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * Expire rules whose expiryDate has passed. Returns the updated list and
 * whether any changes were made.
 */
export function expireRules(rules: AvailabilityRule[]): { rules: AvailabilityRule[]; changed: boolean } {
  const today = new Date().toISOString().slice(0, 10);
  let changed = false;

  const updated = rules.map((rule) => {
    if (rule.status === "active" && rule.expiryDate && rule.expiryDate < today) {
      changed = true;
      return { ...rule, status: "expired" as const };
    }
    return rule;
  });

  return { rules: updated, changed };
}

// --- Deterministic Compiler ---

/**
 * Extract all active bookable link rules as compiled link entries.
 * Separate from compileStructuredRules because bookable rules do NOT
 * affect the global scoring engine — they only apply to sessions spawned
 * from their specific link, and are consumed by the bookable-links slot
 * transform at session time.
 *
 * Pure function — no LLM, no async, fully deterministic.
 */
export function compileBookableLinks(rules: AvailabilityRule[]): CompiledBookableLink[] {
  const today = new Date().toISOString().slice(0, 10);
  const out: CompiledBookableLink[] = [];

  for (const rule of rules) {
    if (rule.action !== "bookable") continue;
    if (rule.status !== "active") continue;
    const bookableData = rule.bookable;
    if (!bookableData) continue;
    if (rule.expiryDate && rule.expiryDate < today) continue;
    if (rule.effectiveDate && rule.effectiveDate > today) continue;

    out.push({
      ruleId: rule.id,
      linkCode: bookableData.linkCode,
      linkSlug: bookableData.linkSlug,
      title: bookableData.title,
      format: bookableData.format,
      durationMinutes: bookableData.durationMinutes,
      windowStart: rule.timeStart || "00:00",
      windowEnd: rule.timeEnd || "23:59",
      daysOfWeek: rule.daysOfWeek || [],
      expiryDate: rule.expiryDate,
    });
  }

  return out;
}

/**
 * Convert structured rules into the CompiledRules format consumed by the scoring engine.
 * Pure function — no LLM, no async, fully deterministic.
 *
 * Note: bookable rules are NOT processed here — they're compiled separately via
 * compileBookableLinks(). The scoring engine is global; bookable links are per-link.
 */
export function compileStructuredRules(
  rules: AvailabilityRule[],
  defaultBizStart: number = 9,
  defaultBizEnd: number = 18,
): CompiledRules {
  const blockedWindows: BlockedWindow[] = [];
  const protectedWindows: ProtectedWindow[] = [];
  const allowWindows: AllowWindow[] = [];
  const buffers: CompiledBuffer[] = [];
  const priorityBuckets: CompiledPriorityBucket[] = [];
  const blackoutDays: string[] = [];
  const formatFilters: NonNullable<CompiledRules["formatFilters"]> = [];
  let businessHoursStart: number | undefined;
  let businessHoursEnd: number | undefined;

  for (const rule of rules) {
    if (rule.status !== "active") continue;

    switch (rule.action) {
      case "block": {
        // 2026-05-05 hardening: a one-time block rule with an effectiveDate
        // MUST always scope to that date — either as a blackoutDay (all-day
        // or no time bounds) or as a date-scoped BlockedWindow (partial
        // day). This branch runs *regardless* of the allDay flag because
        // the composer has been observed to omit it. Without this guard, a
        // bare `{type: "one-time", effectiveDate: ...}` rule fell through
        // to the time-range branch and produced an unscoped 00:00–23:59
        // window that blocked every day until expires.
        const isOneTimeDateScoped = rule.type === "one-time" && !!rule.effectiveDate;
        if (isOneTimeDateScoped) {
          const hasTimeBounds = !!rule.timeStart || !!rule.timeEnd;
          if (!hasTimeBounds) {
            // All-day, single-date → blackout
            blackoutDays.push(rule.effectiveDate!);
          } else {
            // Partial-day, single-date → date-scoped BlockedWindow
            const bw: BlockedWindow = {
              start: rule.timeStart || "00:00",
              end: rule.timeEnd || "23:59",
              label: rule.originalText,
              date: rule.effectiveDate!,
            };
            blockedWindows.push(bw);
          }
          break;
        }

        if (rule.allDay) {
          if (rule.type === "temporary" && rule.effectiveDate && rule.expiryDate) {
            // Date range → individual blackout days
            const start = new Date(rule.effectiveDate + "T12:00:00");
            const end = new Date(rule.expiryDate + "T12:00:00");
            for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
              blackoutDays.push(d.toISOString().slice(0, 10));
            }
          } else if (rule.daysOfWeek && rule.daysOfWeek.length > 0) {
            // Recurring or ongoing all-day blocks with specific days →
            // blocked window spanning full day on those days
            const bw: BlockedWindow = {
              start: "00:00",
              end: "23:59",
              label: rule.originalText,
              days: rule.daysOfWeek.map(d => DAY_NAMES[d]),
            };
            if (rule.expiryDate) bw.expires = rule.expiryDate;
            blockedWindows.push(bw);
          }
        } else {
          // Time-range blocks → blocked windows
          const bw: BlockedWindow = {
            start: rule.timeStart || "00:00",
            end: rule.timeEnd || "23:59",
            label: rule.originalText,
          };

          if (rule.daysOfWeek && rule.daysOfWeek.length > 0) {
            bw.days = rule.daysOfWeek.map(d => DAY_NAMES[d]);
          }

          if (rule.expiryDate) {
            bw.expires = rule.expiryDate;
          }

          blockedWindows.push(bw);
        }
        break;
      }

      case "protect": {
        // Protect rules produce a soft-subtraction (score 3 / stretch band).
        // The host has declared this time protected but is willing to admit
        // VIPs or explicit overrides. Distinct from "block" (score 5 / hard).
        const pw: ProtectedWindow = {
          start: rule.timeStart || "00:00",
          end: rule.timeEnd || "23:59",
          label: rule.originalText,
        };
        if (rule.daysOfWeek && rule.daysOfWeek.length > 0) {
          pw.days = rule.daysOfWeek.map(d => DAY_NAMES[d]);
        }
        if (rule.expiryDate) pw.expires = rule.expiryDate;
        if (rule.type === "one-time" && rule.effectiveDate) pw.date = rule.effectiveDate;
        protectedWindows.push(pw);
        break;
      }

      case "allow": {
        // Allow rules override event-based blocking during the specified window.
        // E.g. "protein shake reminders at 1pm shouldn't block availability" →
        // events during 1:00–1:05 are treated as transparent.
        const aw: AllowWindow = {
          start: rule.timeStart || "00:00",
          end: rule.timeEnd || "23:59",
          label: rule.originalText,
        };
        if (rule.daysOfWeek && rule.daysOfWeek.length > 0) {
          aw.days = rule.daysOfWeek.map(d => DAY_NAMES[d]);
        }
        if (rule.expiryDate) aw.expires = rule.expiryDate;
        allowWindows.push(aw);
        break;
      }

      case "buffer": {
        if (rule.bufferMinutesBefore || rule.bufferMinutesAfter) {
          buffers.push({
            beforeMinutes: rule.bufferMinutesBefore || 0,
            afterMinutes: rule.bufferMinutesAfter || 0,
            eventFilter: rule.bufferAppliesTo || "all",
          });
        }
        break;
      }

      case "limit": {
        // Limit = "only available during these hours" — block everything outside
        // Creates up to 2 blocked windows: before the limit start, after the limit end
        const limitStart = rule.timeStart || "00:00";
        const limitEnd = rule.timeEnd || "23:59";
        const limitDays = rule.daysOfWeek?.map(d => DAY_NAMES[d]);

        if (limitStart > "00:00") {
          const bw: BlockedWindow = {
            start: "00:00",
            end: limitStart,
            label: `${rule.originalText} (before)`,
          };
          if (limitDays) bw.days = limitDays;
          if (rule.expiryDate) bw.expires = rule.expiryDate;
          blockedWindows.push(bw);
        }
        if (limitEnd < "23:59") {
          const bw: BlockedWindow = {
            start: limitEnd,
            end: "23:59",
            label: `${rule.originalText} (after)`,
          };
          if (limitDays) bw.days = limitDays;
          if (rule.expiryDate) bw.expires = rule.expiryDate;
          blockedWindows.push(bw);
        }
        break;
      }

      case "location": {
        // No-op — location rules don't affect scoring.
        // They're surfaced separately via getActiveLocationRule() for the UI,
        // composer context, and widget display.
        break;
      }

      case "no_in_person": {
        // Disallow in-person meetings on matching days / window. All-day by
        // default; optionally scoped to hours and specific weekdays, and to
        // a temporary date window via effective/expiry.
        const ff: NonNullable<CompiledRules["formatFilters"]>[number] = {
          disallowFormats: ["in-person"],
          label: rule.originalText,
        };
        if (!rule.allDay && rule.timeStart) ff.start = rule.timeStart;
        if (!rule.allDay && rule.timeEnd) ff.end = rule.timeEnd;
        if (rule.daysOfWeek && rule.daysOfWeek.length > 0) {
          ff.days = rule.daysOfWeek.map((d) => DAY_NAMES[d]);
        }
        if (rule.effectiveDate) ff.effective = rule.effectiveDate;
        if (rule.expiryDate) ff.expires = rule.expiryDate;
        formatFilters.push(ff);
        break;
      }

      case "bookable": {
        // No-op in the global compiler. Bookable links don't affect the host's
        // global scored schedule — they're per-link. Use compileBookableLinks()
        // to extract them for the session-time slot transform.
        break;
      }

      case "prefer": {
        // Prefer rules map to priority buckets
        // The original text may contain keywords like "high priority: X, Y"
        const keywords = rule.originalText
          .replace(/^(prefer|high priority|low priority):?\s*/i, "")
          .split(/[,;]+/)
          .map(k => k.trim())
          .filter(Boolean);

        if (keywords.length > 0) {
          priorityBuckets.push({
            level: rule.priority >= 4 ? "high" : "low",
            keywords,
          });
        }
        break;
      }
    }
  }

  return {
    blockedWindows,
    protectedWindows,
    allowWindows,
    buffers,
    priorityBuckets,
    businessHoursStart: businessHoursStart ?? defaultBizStart,
    businessHoursEnd: businessHoursEnd ?? defaultBizEnd,
    blackoutDays: blackoutDays.length > 0 ? blackoutDays : undefined,
    formatFilters: formatFilters.length > 0 ? formatFilters : undefined,
    ambiguities: [],
    compiledAt: new Date().toISOString(),
  };
}
