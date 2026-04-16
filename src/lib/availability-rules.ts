/**
 * Structured availability rules — types, deterministic compiler, and lifecycle helpers.
 *
 * Rules are stored in preferences.explicit.structuredRules as an array.
 * The deterministic compiler converts active rules into the same CompiledRules
 * format consumed by the scoring engine — no LLM needed at compilation time.
 */

import type { CompiledRules, BlockedWindow, AllowWindow, CompiledBuffer, CompiledPriorityBucket } from "./scoring";

// --- Types ---

export interface AvailabilityRule {
  id: string;
  originalText: string;
  type: "ongoing" | "recurring" | "temporary" | "one-time";
  action: "block" | "allow" | "buffer" | "prefer" | "limit" | "location" | "office_hours";
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
   * Office hours scoping — only present when action === "office_hours".
   * Defines a public, shareable booking surface. The rule's time window +
   * days define when bookings are offerable; format/duration/title lock
   * the meeting type. linkCode is the public identifier used in the URL.
   */
  officeHours?: {
    title: string;          // defaults to "Office Hours" on rule creation; host-editable
    format: "video" | "phone" | "in-person";
    durationMinutes: number;
    linkSlug: string;       // denormalized copy of user.meetSlug for fast URL construction
    linkCode: string;       // generated unique code — the /meet/{slug}/{code} identifier
  };
  status: "active" | "paused" | "expired";
  priority: number;       // 1-5
  createdAt: string;      // ISO datetime
}

/**
 * Compiled office-hours link entry — emitted from compileStructuredRules() alongside
 * CompiledRules. Each active office_hours rule produces one entry. Consumed by the
 * office-hours slot transform, not by the core scoring engine.
 */
export interface CompiledOfficeHoursLink {
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
 * Extract all active office-hours rules as compiled link entries.
 * Separate from compileStructuredRules because office-hours rules do NOT
 * affect the global scoring engine — they only apply to sessions spawned
 * from their specific link, and are consumed by the office-hours slot
 * transform at session time.
 *
 * Pure function — no LLM, no async, fully deterministic.
 */
export function compileOfficeHoursLinks(rules: AvailabilityRule[]): CompiledOfficeHoursLink[] {
  const today = new Date().toISOString().slice(0, 10);
  const out: CompiledOfficeHoursLink[] = [];

  for (const rule of rules) {
    if (rule.action !== "office_hours") continue;
    if (rule.status !== "active") continue;
    if (!rule.officeHours) continue;
    if (rule.expiryDate && rule.expiryDate < today) continue;
    if (rule.effectiveDate && rule.effectiveDate > today) continue;

    out.push({
      ruleId: rule.id,
      linkCode: rule.officeHours.linkCode,
      linkSlug: rule.officeHours.linkSlug,
      title: rule.officeHours.title,
      format: rule.officeHours.format,
      durationMinutes: rule.officeHours.durationMinutes,
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
 * Note: office_hours rules are NOT processed here — they're compiled separately via
 * compileOfficeHoursLinks(). The scoring engine is global; office hours are per-link.
 */
export function compileStructuredRules(
  rules: AvailabilityRule[],
  defaultBizStart: number = 9,
  defaultBizEnd: number = 18,
): CompiledRules {
  const blockedWindows: BlockedWindow[] = [];
  const allowWindows: AllowWindow[] = [];
  const buffers: CompiledBuffer[] = [];
  const priorityBuckets: CompiledPriorityBucket[] = [];
  const blackoutDays: string[] = [];
  let businessHoursStart: number | undefined;
  let businessHoursEnd: number | undefined;

  for (const rule of rules) {
    if (rule.status !== "active") continue;

    switch (rule.action) {
      case "block": {
        if (rule.allDay) {
          if (rule.type === "one-time" && rule.effectiveDate) {
            // Single-date blackout
            blackoutDays.push(rule.effectiveDate);
          } else if (rule.type === "temporary" && rule.effectiveDate && rule.expiryDate) {
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

      case "office_hours": {
        // No-op in the global compiler. Office hours don't affect the host's
        // global scored schedule — they're per-link. Use compileOfficeHoursLinks()
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
    allowWindows,
    buffers,
    priorityBuckets,
    businessHoursStart: businessHoursStart ?? defaultBizStart,
    businessHoursEnd: businessHoursEnd ?? defaultBizEnd,
    blackoutDays: blackoutDays.length > 0 ? blackoutDays : undefined,
    ambiguities: [],
    compiledAt: new Date().toISOString(),
  };
}
