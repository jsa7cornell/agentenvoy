"use client";

/**
 * Event Links — desktop full-page body. **V1 redesign (2026-05-02).**
 *
 * Visual contract: `previews/event-links-page-redesign.html`. Three sections:
 *
 *  1. **Your reusable links** — 3-up grid of compact cards (Primary
 *     pinned first, then Office Hours / other variants). Each card carries
 *     a host-prefixed name, a config sub-line, a URL+Copy chip, and an
 *     Edit text-link at the bottom.
 *  2. **Create a reusable link** — three colored type cards (Bookable
 *     Hours · Recurring Sessions · Group Meeting), each with four starter
 *     scenarios. Starters prefill the chat composer. Lives in
 *     `create-link-picker.tsx` so mobile can reuse the data.
 *  3. **Upcoming events** — filterable chips (All / Coordinating /
 *     Confirmed / Complete / Cancelled). Table-like layout with EVENT /
 *     GUEST / WHEN / STATUS columns + per-row actions (Google Calendar
 *     link on Confirmed, Cancel on live, Open on cancelled).
 *
 * **2026-05-02 changes vs PR-3:**
 *  - Reusable list: 1-col → 3-up grid.
 *  - Create flow: dashed-tile → CreateLinkPicker (3 type cards).
 *  - Bucket update: `needs_you` retired, `past` split into `complete`/`cancelled`.
 *  - Event row: row-click opens deal-room; Confirmed shows date+time inline +
 *    Google Calendar link; Cancelled rows dimmed.
 *
 * Vocabulary discipline: "Primary link" (capitalized — SPEC §2.2). "Office
 * Hours" (capitalized — feature name). "Event Links" (page title — plural).
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { AvailabilityPreference } from "@/lib/availability-rules";
import { getOfficeHoursDisplayName } from "@/lib/availability-rules";
import {
  classifySession,
  matchesFilter,
  EVENT_FILTERS,
  EVENT_FILTER_LABELS,
  EVENT_PILL_LABELS,
  type EventBucket,
  type EventFilter,
  type SessionLike,
} from "@/lib/event-links-buckets";
import { type ReusableLinkRow } from "@/components/mobile/event-links-card";
import { EventLinksEditDialog } from "@/components/mobile/event-links-edit-dialog";
import { PrimaryEditDialog } from "@/components/links/primary-edit-dialog";
import { CreateLinkPicker } from "@/components/desktop/create-link-picker";

interface UpcomingEventRow extends SessionLike {
  id: string;
  title?: string | null;
  guestName?: string | null;
  guestEmail?: string | null;
  /** Meeting length in minutes — used to derive the end time on Confirmed
   *  rows. Null on sessions whose duration was never locked. */
  duration?: number | null;
  createdAt: string;
  cancelledAt?: string | null;
  link?: {
    type?: string | null;
    slug?: string | null;
    code?: string | null;
    inviteeName?: string | null;
    inviteeEmail?: string | null;
    topic?: string | null;
  } | null;
}

const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function formatDayList(days: number[] | undefined): string {
  if (!days || days.length === 0) return "Every day";
  if (days.length === 7) return "Every day";
  if (days.length === 5 && [1, 2, 3, 4, 5].every((d) => days.includes(d))) return "Mon–Fri";
  if (days.length === 2 && days.includes(0) && days.includes(6)) return "Sat–Sun";
  return days.slice().sort((a, b) => a - b).map((d) => DAY_SHORT[d]).join(", ");
}

function format12h(hhmm: string | undefined): string {
  if (!hhmm) return "";
  const [hStr, mStr] = hhmm.split(":");
  const h = Number(hStr);
  const m = Number(mStr);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return hhmm;
  const suffix = h >= 12 ? "p" : "a";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${h12}${suffix}` : `${h12}:${String(m).padStart(2, "0")}${suffix}`;
}

function buildOfficeHoursSub(rule: AvailabilityPreference): string {
  const oh = rule.officeHours;
  if (!oh) return "Office Hours";
  const days = formatDayList(rule.daysOfWeek);
  const start = format12h(rule.timeStart);
  const end = format12h(rule.timeEnd);
  const window = start && end ? `${start}–${end}` : "";
  const dur = `${oh.durationMinutes} min`;
  return [dur, days, window].filter(Boolean).join(" · ");
}

function buildEventSub(s: UpcomingEventRow): string {
  const linkType = s.link?.type;
  if (linkType === "primary") return "via primary link";
  if (linkType === "office_hours" && s.link?.slug && s.link?.code) {
    return `via /meet/${s.link.slug}/${s.link.code}`;
  }
  if (linkType === "office_hours") return "via Office Hours";
  if (s.link?.topic) return s.link.topic;
  if (s.link?.inviteeName) return `with ${s.link.inviteeName}`;
  return "";
}

function getDealRoomUrl(s: UpcomingEventRow): string | null {
  if (!s.link?.slug) return null;
  return s.link.code ? `/meet/${s.link.slug}/${s.link.code}` : `/meet/${s.link.slug}`;
}

/** Compact date cell: "May 3" (no year in current year, "May 3 '24" otherwise). */
function formatCompactDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    const thisYear = new Date().getFullYear();
    if (d.getFullYear() === thisYear) {
      return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    }
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "2-digit" });
  } catch {
    return "—";
  }
}

/** Compact time: "10:00 AM" with no leading zero on hour. */
function formatCompactTime(iso: string | null | undefined): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  } catch {
    return "";
  }
}

/** Build a Google Calendar day-view URL for the agreed time. We don't have
 *  enough context to deep-link the specific event here (would need the
 *  calendarId + base64-encoded eventId pair); landing on the day view is
 *  the V1 compromise. */
function buildGcalDayUrl(iso: string): string {
  try {
    const d = new Date(iso);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `https://calendar.google.com/calendar/u/0/r/day/${yyyy}/${mm}/${dd}`;
  } catch {
    return "https://calendar.google.com/calendar/u/0/r";
  }
}

interface PillStyle {
  dot: string;
  text: string;
  bg: string;
}

function statusPillStyle(bucket: EventBucket): PillStyle {
  switch (bucket) {
    case "confirmed":
      return {
        dot: "bg-green-500",
        text: "text-green-700 dark:text-green-400",
        bg: "bg-green-500/10",
      };
    case "complete":
      return {
        dot: "bg-zinc-400",
        text: "text-zinc-600 dark:text-zinc-400",
        bg: "bg-zinc-500/10",
      };
    case "cancelled":
      return {
        dot: "bg-red-500",
        text: "text-red-700 dark:text-red-400",
        bg: "bg-red-500/10",
      };
    case "coordinating":
    default:
      return {
        dot: "bg-indigo-500",
        text: "text-indigo-700 dark:text-indigo-400",
        bg: "bg-indigo-500/10",
      };
  }
}

interface ReusableCardGridProps {
  row: ReusableLinkRow;
  onEdit: (row: ReusableLinkRow) => void;
}

/**
 * Compact 3-up reusable card. Different layout from the mobile-stacked
 * `EventLinksCard` — vertical title block, URL chip in the middle, Edit
 * text-link at the bottom. See `previews/event-links-page-redesign.html`
 * `.rcard` styling.
 */
function ReusableCardGrid({ row, onEdit }: ReusableCardGridProps) {
  const [copied, setCopied] = useState(false);
  const isPrimary = row.kind === "primary";

  function copy() {
    if (typeof navigator === "undefined" || !navigator.clipboard) return;
    navigator.clipboard.writeText(row.url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div
      className={`rounded-xl border p-4 flex flex-col gap-3 min-h-[160px] ${
        isPrimary
          ? "border-accent/40 bg-accent-surface/30"
          : "border-secondary bg-surface-secondary/40"
      }`}
      data-testid={`desktop-reusable-card-${row.kind}`}
    >
      <div className="flex items-start gap-2">
        <div
          className="w-7 h-7 rounded-md bg-surface/80 flex items-center justify-center text-sm flex-shrink-0"
          aria-hidden
        >
          {row.icon}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-primary truncate">{row.name}</div>
          <div className="text-[11px] text-muted truncate leading-snug mt-0.5">{row.sub}</div>
        </div>
        {isPrimary && (
          <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-accent/10 text-accent flex-shrink-0">
            Default
          </span>
        )}
      </div>

      <div className="flex items-center gap-2 rounded-lg bg-surface/60 border border-secondary/60 px-2.5 py-1.5">
        <span className="text-[11px] font-mono text-secondary truncate flex-1 min-w-0">
          {row.url.replace(/^https?:\/\//, "")}
        </span>
        <button
          type="button"
          onClick={copy}
          className="text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded bg-surface-secondary/80 hover:bg-surface-tertiary text-secondary hover:text-accent transition flex-shrink-0"
          data-testid={`desktop-reusable-copy-${row.kind}`}
          aria-label={`Copy ${row.name} URL`}
        >
          {copied ? <span className="text-emerald-500">Copied</span> : "Copy"}
        </button>
      </div>

      <button
        type="button"
        onClick={() => onEdit(row)}
        className="text-[12px] text-secondary hover:text-accent transition self-start mt-auto"
        data-testid={`desktop-reusable-edit-${row.kind}`}
        aria-label={`Edit ${row.name}`}
      >
        Edit
      </button>
    </div>
  );
}

export function EventLinksPageContent() {
  const [reusableRows, setReusableRows] = useState<ReusableLinkRow[]>([]);
  const [reusableLoaded, setReusableLoaded] = useState(false);
  const [events, setEvents] = useState<UpcomingEventRow[]>([]);
  const [eventsLoaded, setEventsLoaded] = useState(false);
  const [filter, setFilter] = useState<EventFilter>("all");
  const [editing, setEditing] = useState<ReusableLinkRow | null>(null);
  const [editingPrimary, setEditingPrimary] = useState(false);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [confirmCancelId, setConfirmCancelId] = useState<string | null>(null);
  const [hostFirstName, setHostFirstName] = useState<string>("");

  // Route the Edit click on a Primary card to the PrimaryEditDialog;
  // office_hours / other variance rows continue to use EventLinksEditDialog.
  function handleEditClick(row: ReusableLinkRow) {
    if (row.kind === "primary") {
      setEditingPrimary(true);
    } else {
      setEditing(row);
    }
  }

  function refetchReusable() {
    fetch("/api/tuner/preferences")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data) return;
        const origin = typeof window !== "undefined" ? window.location.origin : "";
        const slug = data.meetSlug as string | null | undefined;
        const out: ReusableLinkRow[] = [];
        // Host first name for the "John's Primary Link" label pattern.
        const fullName = (data.name as string | undefined) ?? "";
        const first = fullName.split(/\s+/)[0] ?? "";
        if (first) setHostFirstName(first);
        if (slug) {
          const primaryName = (data.generalLinkName as string) || (first ? `${first}'s Primary Link` : "Primary link");
          const defaultDur =
            typeof data.defaultMeetingMinutes === "number" ? data.defaultMeetingMinutes : 30;
          out.push({
            key: "primary",
            kind: "primary",
            name: primaryName,
            sub: `${defaultDur} min · video`,
            url: `${origin}/meet/${slug}`,
            icon: "🔗",
          });
          const structured = (data.structuredRules as AvailabilityPreference[]) ?? [];
          for (const r of structured) {
            // `r.status` may be undefined on rules created before the status
            // field was introduced — treat missing status as "active" for
            // backward compatibility. Only skip explicitly paused/expired rules.
            const rStatus = r.status as string | undefined;
            if (r.action !== "office_hours" || (rStatus && rStatus !== "active") || !r.officeHours) continue;
            const oh = r.officeHours;
            if (!oh.linkCode || !oh.linkSlug) continue;
            out.push({
              key: r.id,
              kind: "office_hours",
              name: getOfficeHoursDisplayName(oh),
              sub: buildOfficeHoursSub(r),
              url: `${origin}/meet/${oh.linkSlug}/${oh.linkCode}`,
              icon: "🕐",
              ruleId: r.id,
              recurringWindowConfig: {
                title: oh.title,
                name: oh.name,
                format: oh.format,
                durationMinutes: oh.durationMinutes,
                timeStart: r.timeStart ?? "09:00",
                timeEnd: r.timeEnd ?? "17:00",
                daysOfWeek: r.daysOfWeek ?? [1, 2, 3, 4, 5],
                effectiveDate: r.effectiveDate,
                expiryDate: r.expiryDate,
                originalText: r.originalText ?? "",
                ...(oh.guestPicks ? { guestPicks: oh.guestPicks } : {}),
              },
            });
          }
        }
        setReusableRows(out);
      })
      .finally(() => setReusableLoaded(true));
  }

  function refetchEvents() {
    fetch("/api/negotiate/sessions?archived=false")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data?.sessions) return;
        setEvents(data.sessions as UpcomingEventRow[]);
      })
      .finally(() => setEventsLoaded(true));
  }

  useEffect(() => {
    refetchReusable();
    refetchEvents();
  }, []);

  // Counts per bucket — surface them on each filter chip per the mockup
  // (`All · 4`, `Coordinating · 2`, etc.).
  const bucketCounts = useMemo(() => {
    const now = Date.now();
    const counts: Record<EventBucket, number> = {
      coordinating: 0,
      confirmed: 0,
      complete: 0,
      cancelled: 0,
    };
    for (const s of events) {
      const b = classifySession(s, now);
      counts[b] += 1;
    }
    return counts;
  }, [events]);

  const filteredEvents = useMemo(() => {
    if (filter === "all") return events;
    const now = Date.now();
    return events.filter((s) => matchesFilter(s, filter, now));
  }, [events, filter]);

  async function handleCancel(sessionId: string) {
    setCancelling(sessionId);
    try {
      const res = await fetch("/api/negotiate/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
      if (res.ok) {
        // Refetch to pull updated cancelled status (and let the row drift
        // into the "cancelled" bucket where it stays visible, dimmed).
        refetchEvents();
      }
    } catch {
      // silent
    } finally {
      setCancelling(null);
      setConfirmCancelId(null);
    }
  }

  return (
    <div
      className="hidden md:block min-h-[720px] mx-auto max-w-[1280px] px-12 py-8"
      data-testid="desktop-event-links-page"
    >
      <div className="flex flex-col gap-10">
        {/* GROUP 1 — Reusable links (3-up grid) */}
        <section aria-labelledby="reusable-links-heading">
          <h2
            id="reusable-links-heading"
            className="text-[11px] font-semibold tracking-wider uppercase text-muted mb-3"
          >
            Your reusable links
          </h2>
          {!reusableLoaded ? (
            <div className="px-3 py-2 text-sm text-muted">Loading…</div>
          ) : reusableRows.length === 0 ? (
            <div className="px-3 py-2 text-sm text-muted">No links yet.</div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {reusableRows.map((r) => (
                <ReusableCardGrid key={r.key} row={r} onEdit={handleEditClick} />
              ))}
            </div>
          )}
        </section>

        {/* GROUP 2 — Create a reusable link (3 type cards) */}
        <CreateLinkPicker />

        {/* GROUP 3 — Upcoming events */}
        <section aria-labelledby="upcoming-events-heading">
          <h2
            id="upcoming-events-heading"
            className="text-[11px] font-semibold tracking-wider uppercase text-muted mb-3"
          >
            Upcoming events
          </h2>

          {/* Filter chips (with counts) */}
          <div
            className="flex gap-1.5 mb-3 flex-wrap"
            role="tablist"
            aria-label="Filter upcoming events"
            data-testid="desktop-event-links-filter-chips"
          >
            {EVENT_FILTERS.map((f) => {
              const active = f === filter;
              const count = f === "all" ? events.length : bucketCounts[f as EventBucket];
              return (
                <button
                  key={f}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setFilter(f)}
                  className={`px-3 py-1 rounded-full text-[11.5px] font-medium border transition ${
                    active
                      ? "border-accent text-accent bg-accent/10"
                      : "border-secondary text-secondary hover:border-accent/40"
                  }`}
                  data-testid={`desktop-event-links-filter-${f}`}
                >
                  {EVENT_FILTER_LABELS[f]} · {count}
                </button>
              );
            })}
          </div>

          {!eventsLoaded ? (
            <div className="px-3 py-2 text-sm text-muted">Loading…</div>
          ) : filteredEvents.length === 0 ? (
            <div className="px-3 py-6 text-sm text-muted text-center border border-secondary rounded-xl">
              {filter === "all" ? "No upcoming events." : "Nothing in this filter."}
            </div>
          ) : (
            <div
              className="rounded-xl border border-secondary overflow-hidden"
              data-testid="desktop-event-links-table"
            >
              {/* Table header (desktop only — mobile-narrow viewports get
                  the stacked sheet via the topbar pill).
                  Columns: Event · Guest · Created · Confirmed · Meeting · Status · Actions */}
              <div
                className="grid grid-cols-[2fr_1fr_0.85fr_0.85fr_1.1fr_0.9fr_1fr] gap-3 px-4 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-muted bg-surface-secondary/40 border-b border-secondary"
                role="row"
              >
                <div>Event</div>
                <div>Guest</div>
                <div>Created</div>
                <div>Confirmed</div>
                <div>Meeting</div>
                <div>Status</div>
                <div className="text-right" />
              </div>

              <ul role="list">
                {filteredEvents.map((s, idx) => {
                  const bucket = classifySession(s, Date.now());
                  const pill = statusPillStyle(bucket);
                  const guestLabel =
                    s.guestName ||
                    s.link?.inviteeName ||
                    s.guestEmail ||
                    s.link?.inviteeEmail ||
                    "Guest";
                  const title = s.title || s.link?.topic || `Meeting with ${guestLabel}`;
                  const sub = buildEventSub(s);
                  const dealUrl = getDealRoomUrl(s);
                  const isCoordinating = bucket === "coordinating";
                  const isConfirmed = bucket === "confirmed";
                  const isCancelled = bucket === "cancelled";

                  // Inline cancel-confirm state
                  if (confirmCancelId === s.id) {
                    return (
                      <li
                        key={s.id}
                        className="grid grid-cols-[1fr_auto_auto] gap-2 items-center px-4 py-3 border-t border-red-500/30 bg-red-50 dark:bg-red-950/20"
                        data-testid="desktop-event-links-cancel-confirm"
                      >
                        <span className="text-sm text-secondary">
                          {isConfirmed ? "Cancel this meeting?" : "Stop coordinating this event?"}
                        </span>
                        <button
                          onClick={() => setConfirmCancelId(null)}
                          className="text-xs text-muted hover:text-secondary transition px-3 py-1.5"
                        >
                          Keep
                        </button>
                        <button
                          onClick={() => handleCancel(s.id)}
                          disabled={cancelling === s.id}
                          className="text-xs font-medium text-red-600 hover:text-red-500 dark:text-red-400 dark:hover:text-red-300 border border-red-500/30 rounded px-3 py-1.5 transition disabled:opacity-50"
                        >
                          {cancelling === s.id ? "…" : "Yes"}
                        </button>
                      </li>
                    );
                  }

                  return (
                    <li
                      key={s.id}
                      className={`grid grid-cols-[2fr_1fr_0.85fr_0.85fr_1.1fr_0.9fr_1fr] gap-3 items-center px-4 py-3 ${
                        idx > 0 ? "border-t border-secondary" : ""
                      } ${isCancelled ? "opacity-60" : "hover:bg-surface-secondary/30"} transition-colors`}
                      data-testid={`desktop-event-links-row-${bucket}`}
                    >
                      {/* Event title + sub — the whole first cell is the
                          click target when a deal-room URL exists. The link
                          wraps both title and subtitle and gets –mx/+px
                          padding so the hit area extends beyond just the
                          text glyphs without touching neighbouring columns. */}
                      <div className="min-w-0 -mx-1">
                        {dealUrl ? (
                          <Link
                            href={dealUrl}
                            className={`flex flex-col px-1 py-1 rounded-md hover:bg-accent/5 transition-colors group ${
                              isCancelled ? "opacity-100" : ""
                            }`}
                            data-testid={`desktop-event-links-title-${s.id}`}
                          >
                            <span className={`text-[13px] font-medium truncate group-hover:text-accent transition-colors ${
                              isCancelled ? "text-secondary line-through decoration-1" : "text-primary"
                            }`}>
                              {title}
                            </span>
                            {sub && <span className="text-[11px] text-muted truncate mt-0.5">{sub}</span>}
                          </Link>
                        ) : (
                          <div className="px-1 py-1">
                            <div className="text-[13px] font-medium text-primary truncate">{title}</div>
                            {sub && <div className="text-[11px] text-muted truncate mt-0.5">{sub}</div>}
                          </div>
                        )}
                      </div>

                      {/* Guest */}
                      <div className="text-[12px] text-secondary truncate">{guestLabel}</div>

                      {/* Created */}
                      <div className="text-[12px] text-secondary tabular-nums">
                        {formatCompactDate(s.createdAt)}
                      </div>

                      {/* Confirmed — date agreedTime was set; "-" while still coordinating */}
                      <div className="text-[12px] text-secondary tabular-nums">
                        {formatCompactDate(s.agreedTime ?? null)}
                      </div>

                      {/* Meeting — date + time of the agreed slot */}
                      <div className="min-w-0">
                        {s.agreedTime ? (
                          <div className="flex flex-col">
                            <span className="text-[12px] font-medium text-primary tabular-nums">
                              {formatCompactDate(s.agreedTime)}
                            </span>
                            <span className="text-[11px] text-muted tabular-nums">
                              {formatCompactTime(s.agreedTime)}
                            </span>
                          </div>
                        ) : (
                          <span className="text-[12px] text-muted">—</span>
                        )}
                      </div>

                      {/* Status pill */}
                      <div>
                        <span
                          className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium ${pill.bg} ${pill.text}`}
                        >
                          <span className={`w-1.5 h-1.5 rounded-full ${pill.dot}`} aria-hidden />
                          {EVENT_PILL_LABELS[bucket]}
                        </span>
                      </div>

                      {/* Action column — Google Cal link on Confirmed,
                          Cancel on live, Open on cancelled. */}
                      <div className="flex items-center justify-end gap-3 text-[12px]">
                        {isConfirmed && s.agreedTime && (
                          <a
                            href={buildGcalDayUrl(s.agreedTime)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-accent hover:text-accent/80 transition-colors flex items-center gap-1"
                            data-testid={`desktop-event-links-gcal-${s.id}`}
                          >
                            Google Calendar <span aria-hidden>↗</span>
                          </a>
                        )}
                        {(isConfirmed || isCoordinating) && (
                          <button
                            type="button"
                            onClick={() => setConfirmCancelId(s.id)}
                            className="text-red-600 hover:text-red-500 dark:text-red-400 dark:hover:text-red-300 transition"
                            data-testid={`desktop-event-links-cancel-${s.id}`}
                          >
                            Cancel
                          </button>
                        )}
                        {isCancelled && dealUrl && (
                          <Link
                            href={dealUrl}
                            className="text-secondary hover:text-accent transition"
                            data-testid={`desktop-event-links-open-${s.id}`}
                          >
                            Open
                          </Link>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </section>
      </div>

      {/* Edit dialogs — Primary uses the new posture editor (writes to
          User.preferences + Apply-to-all flow); Office Hours uses the
          existing rule-edit dialog. */}
      <EventLinksEditDialog
        row={editing}
        onSaved={() => {
          setReusableLoaded(false);
          refetchReusable();
        }}
        onDismiss={() => setEditing(null)}
      />
      <PrimaryEditDialog
        open={editingPrimary}
        onSaved={() => {
          setReusableLoaded(false);
          refetchReusable();
        }}
        onDismiss={() => setEditingPrimary(false)}
      />
      {/* hostFirstName reserved for header chrome refactor; suppress unused
          state warning until that lands. */}
      <span className="hidden">{hostFirstName}</span>
    </div>
  );
}
