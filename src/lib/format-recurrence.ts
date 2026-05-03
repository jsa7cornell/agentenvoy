/**
 * Pure helpers for formatting recurring-meeting metadata in user-facing copy.
 *
 * Consumed by:
 *   - greeting registry (recurring-meeting-anchor / recurring-meeting-followup)
 *   - meeting cards: thread-card, event-links-card, event-links-page-content
 *   - link landing page metadata (generateMetadata iMessage unfurl)
 *
 * All functions are pure — no I/O, no side effects.
 */

import type { LinkRecurrence, RecurrencePattern } from "@/lib/recurrence";

// ─── Cadence word ─────────────────────────────────────────────────────────────

/**
 * Short human-readable cadence phrase, used inline in greeting copy.
 *
 *   weekly               → "weekly"
 *   biweekly             → "every other week"
 *   monthly_nth_weekday  → "monthly"
 *   daily                → "daily"
 *
 * @example
 *   formatCadenceWord(rec) // → "weekly"
 *   // used as: "they are 30 mins long, recurring weekly at the same time"
 */
export function formatCadenceWord(rec: LinkRecurrence): string {
  const map: Record<RecurrencePattern, string> = {
    weekly: "weekly",
    biweekly: "every other week",
    monthly_nth_weekday: "monthly",
    daily: "daily",
  };
  return map[rec.pattern] ?? "regularly";
}

// ─── Count / end label ────────────────────────────────────────────────────────

/**
 * Human-readable series-length label from the `endBy` field.
 *
 *   endBy: { count: 10 }              → "10 sessions"
 *   endBy: { until: "2026-08-30T…" } → "sessions through Aug 30"
 *   (invalid until date)              → "a set number of sessions"
 *   endBy absent (forever default)    → null  ← caller drops the clause
 *
 * Returns `null` when the host hasn't bounded the series — the chat-driven
 * narration model treats default-forever as silent (proposal §3.6 / Rule 24
 * hard rule (d)). Callers that compose the value into copy use `null` as
 * the signal to drop the clause entirely rather than render a placeholder.
 */
export function formatEndByLabel(rec: LinkRecurrence): string | null {
  const { endBy } = rec;
  if (!endBy) return null;
  if ("count" in endBy) {
    const n = endBy.count;
    return `${n} session${n === 1 ? "" : "s"}`;
  }
  const d = new Date(endBy.until);
  if (Number.isNaN(d.getTime())) return "a set number of sessions";
  const dateStr = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
  }).format(d);
  return `sessions through ${dateStr}`;
}

// ─── Card subtitle ────────────────────────────────────────────────────────────

/**
 * Compact subtitle for meeting cards, link landing pages, and iMessage unfurls.
 *
 *   bounded:       "weekly · 30 min · 10 sessions"
 *   forever:       "weekly · 30 min"                ← endBy clause dropped
 *   bounded by date: "every other week · 45 min · sessions through Aug 30"
 *
 * Series length is silent unless the host explicitly bounded it — the count
 * is no longer the headline. Per the 2026-05-03 chat-driven narration reshape.
 */
export function formatRecurrenceSubtitle(rec: LinkRecurrence): string {
  const cadence = formatCadenceWord(rec);
  const dur = `${rec.anchor.durationMin} min`;
  const endLabel = formatEndByLabel(rec);
  const parts = [cadence, dur];
  if (endLabel) parts.push(endLabel);
  return parts.join(" · ");
}
