/**
 * Structured availability rules — types, deterministic compiler, and lifecycle helpers.
 *
 * Rules are stored in preferences.explicit.structuredRules as an array.
 * The deterministic compiler converts active rules into the same CompiledRules
 * format consumed by the scoring engine — no LLM needed at compilation time.
 */

import type { CompiledRules, BlockedWindow, CompiledBuffer, CompiledPriorityBucket } from "./scoring";

// --- Types ---

export interface AvailabilityRule {
  id: string;
  originalText: string;
  type: "ongoing" | "recurring" | "temporary" | "one-time";
  action: "block" | "allow" | "buffer" | "prefer" | "limit";
  timeStart?: string;     // "HH:MM" 24h
  timeEnd?: string;       // "HH:MM" 24h
  allDay?: boolean;
  daysOfWeek?: number[];  // 0=Sun, 6=Sat
  effectiveDate?: string; // ISO date
  expiryDate?: string;    // ISO date
  bufferMinutesBefore?: number;
  bufferMinutesAfter?: number;
  bufferAppliesTo?: string;
  status: "active" | "paused" | "expired";
  priority: number;       // 1-5
  createdAt: string;      // ISO datetime
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
 * Convert structured rules into the CompiledRules format consumed by the scoring engine.
 * Pure function — no LLM, no async, fully deterministic.
 */
export function compileStructuredRules(
  rules: AvailabilityRule[],
  defaultBizStart: number = 9,
  defaultBizEnd: number = 18,
): CompiledRules {
  const blockedWindows: BlockedWindow[] = [];
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
        // "Allow" rules don't directly map to blocked windows.
        // They're informational for the agent — we store them as blocked windows
        // with a special label prefix so the scoring engine can handle them.
        // For now, allow rules affect business hours (e.g., "calls OK Saturday before 2pm"
        // means Saturday 0:00-14:00 should be scored lower).
        // This is a no-op in the blocked windows model — allow rules are handled
        // by the agent reading the compiled preferences text.
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
    buffers,
    priorityBuckets,
    businessHoursStart: businessHoursStart ?? defaultBizStart,
    businessHoursEnd: businessHoursEnd ?? defaultBizEnd,
    blackoutDays: blackoutDays.length > 0 ? blackoutDays : undefined,
    ambiguities: [],
    compiledAt: new Date().toISOString(),
  };
}
