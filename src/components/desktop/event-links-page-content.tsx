"use client";

/**
 * Event Links — desktop full-page body.
 *
 * **Two-group layout (PR 3 of Phase 2):**
 *
 *  1. **Reusable links** — Primary pinned at top, then Office Hours
 *     variants. Each card carries an inline URL + Copy chip and an Edit
 *     affordance. A "Create a reusable link" tile prefills the chat
 *     composer at the bottom (and routes home so the composer is
 *     visible).
 *  2. **Upcoming events** — filterable chips (All / Coordinating /
 *     Confirmed / Needs you / Past). Each row: title + via-link sub-line
 *     + status pill + Cancel + Archive affordances. No row icon.
 *
 * Reuses the mobile sheet's `EventLinksCard` and `EventLinksEditDialog`
 * components verbatim — they're presentational + edit-flow logic that
 * doesn't depend on the slide-up chrome. Test IDs keep their `mobile-`
 * prefix because they originated mobile-side; the desktop wrapper adds
 * its own `desktop-event-links-*` IDs for top-level chrome (filter
 * chips, event rows).
 *
 * Vocabulary discipline: "Primary link" (capitalized — SPEC-2.0 §2.2,
 * not "Standard link" despite the mockup string). "Office Hours"
 * (capitalized — feature name). "Event Links" (plural — page title).
 *
 * Mockup ref: `refactor-package-2026-04-25/mockups/desktop-v2.html` §5
 * lines 700-770 (light + dark parity).
 */

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { AvailabilityPreference } from "@/lib/availability-rules";
import { getOfficeHoursDisplayName } from "@/lib/availability-rules";
import {
  classifySession,
  matchesFilter,
  EVENT_FILTERS,
  EVENT_FILTER_LABELS,
  EVENT_PILL_LABELS,
  type EventFilter,
  type SessionLike,
} from "@/lib/event-links-buckets";
import {
  EventLinksCard,
  type ReusableLinkRow,
} from "@/components/mobile/event-links-card";
import { EventLinksEditDialog } from "@/components/mobile/event-links-edit-dialog";

interface UpcomingEventRow extends SessionLike {
  id: string;
  title?: string | null;
  guestName?: string | null;
  guestEmail?: string | null;
  createdAt: string;
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
  if (days.length === 5 && [1, 2, 3, 4, 5].every((d) => days.includes(d))) {
    return "Mon–Fri";
  }
  if (days.length === 2 && days.includes(0) && days.includes(6)) {
    return "Sat–Sun";
  }
  return days
    .slice()
    .sort((a, b) => a - b)
    .map((d) => DAY_SHORT[d])
    .join(", ");
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
  const parts = [days, window, dur].filter(Boolean);
  return parts.join(" · ");
}

function buildEventSub(s: UpcomingEventRow): string {
  if (s.link?.type === "primary") return "via Primary link";
  if (s.link?.type === "office_hours") return "via Office Hours";
  if (s.link?.topic) return s.link.topic;
  if (s.link?.inviteeName) return `with ${s.link.inviteeName}`;
  return "";
}

function statusPillColor(bucket: string): { bg: string; text: string } {
  // Each pill carries a soft tinted background plus a saturated text color.
  // Light + dark variants pair a darker text-700 against the same -500/10 wash
  // (legible on a white surface) with the lighter dark-mode -400 (legible on
  // a near-black surface). See `mockups/desktop-v2.html` light + dark token
  // blocks; these reuse Tailwind palette steps that match the mockup hexes.
  switch (bucket) {
    case "confirmed":
      return { bg: "bg-green-500/10", text: "text-green-700 dark:text-green-400" };
    case "needs_you":
      return { bg: "bg-amber-500/10", text: "text-amber-700 dark:text-amber-400" };
    case "past":
      return { bg: "bg-zinc-500/10", text: "text-zinc-600 dark:text-zinc-400" };
    case "coordinating":
    default:
      return { bg: "bg-indigo-500/10", text: "text-indigo-700 dark:text-indigo-400" };
  }
}

export function EventLinksPageContent() {
  const router = useRouter();
  const [reusableRows, setReusableRows] = useState<ReusableLinkRow[]>([]);
  const [reusableLoaded, setReusableLoaded] = useState(false);
  const [events, setEvents] = useState<UpcomingEventRow[]>([]);
  const [eventsLoaded, setEventsLoaded] = useState(false);
  const [filter, setFilter] = useState<EventFilter>("all");
  const [editing, setEditing] = useState<ReusableLinkRow | null>(null);
  const [archiving, setArchiving] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [confirmCancelId, setConfirmCancelId] = useState<string | null>(null);

  function refetchReusable() {
    fetch("/api/tuner/preferences")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data) return;
        const origin = typeof window !== "undefined" ? window.location.origin : "";
        const slug = data.meetSlug as string | null | undefined;
        const out: ReusableLinkRow[] = [];
        if (slug) {
          const primaryName = (data.generalLinkName as string) || "Primary link";
          const defaultDur =
            typeof data.defaultMeetingMinutes === "number" ? data.defaultMeetingMinutes : 30;
          out.push({
            key: "primary",
            kind: "primary",
            name: primaryName,
            sub: `default ${defaultDur} min · video`,
            url: `${origin}/meet/${slug}`,
            icon: "🔗",
          });
          const structured = (data.structuredRules as AvailabilityPreference[]) ?? [];
          for (const r of structured) {
            if (r.action !== "office_hours" || r.status !== "active" || !r.officeHours) continue;
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

  const filteredEvents = useMemo(() => {
    if (filter === "all") return events;
    const now = Date.now();
    return events.filter((s) => matchesFilter(s, filter, now));
  }, [events, filter]);

  function handleCreateReusable() {
    // Composer lives on /dashboard. We can't dispatch a CustomEvent here
    // because Feed isn't mounted yet — the listener attaches *after*
    // navigation completes, racing the dispatch and losing the prefill.
    // Stash the prefill in sessionStorage; Feed consumes + clears it on
    // mount. Same one-shot semantics as the event bus, navigation-safe.
    if (typeof window !== "undefined") {
      try {
        sessionStorage.setItem(
          "envoy:pending-prefill",
          "Create a new Office Hours link for ",
        );
      } catch {
        // sessionStorage can throw in private-mode browsers.
      }
    }
    router.push("/dashboard");
  }

  async function handleArchive(sessionId: string) {
    setArchiving(sessionId);
    try {
      const res = await fetch("/api/negotiate/archive", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, archived: true }),
      });
      if (res.ok) {
        setEvents((prev) => prev.filter((s) => s.id !== sessionId));
      }
    } catch {
      // silent — surface comes from network panel during dev
    } finally {
      setArchiving(null);
    }
  }

  async function handleCancel(sessionId: string) {
    setCancelling(sessionId);
    try {
      const res = await fetch("/api/negotiate/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
      if (res.ok) {
        setEvents((prev) => prev.filter((s) => s.id !== sessionId));
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
      className="hidden md:block min-h-[720px] mx-auto max-w-[1120px] px-12 py-8"
      data-testid="desktop-event-links-page"
    >
      <div className="grid grid-cols-1 gap-8">
        {/* GROUP 1 — Reusable links */}
        <section aria-labelledby="reusable-links-heading">
          <h2
            id="reusable-links-heading"
            className="text-[11px] font-semibold tracking-wider uppercase text-muted mb-3"
          >
            Reusable links
          </h2>
          {!reusableLoaded ? (
            <div className="px-3 py-2 text-sm text-muted">Loading…</div>
          ) : reusableRows.length === 0 ? (
            <div className="px-3 py-2 text-sm text-muted">No links yet.</div>
          ) : (
            <div className="flex flex-col gap-2">
              {reusableRows.map((r) => (
                <EventLinksCard
                  key={r.key}
                  row={r}
                  onEdit={(row) => setEditing(row)}
                />
              ))}
            </div>
          )}

          <button
            type="button"
            onClick={handleCreateReusable}
            className="mt-3 w-full p-3.5 rounded-xl border border-dashed border-secondary text-secondary hover:border-accent hover:text-accent transition flex items-center justify-center gap-2 text-sm font-medium"
            data-testid="desktop-event-links-create-reusable"
          >
            <span aria-hidden>+</span>
            <span>Create a reusable link</span>
          </button>
        </section>

        {/* GROUP 2 — Upcoming events */}
        <section aria-labelledby="upcoming-events-heading">
          <h2
            id="upcoming-events-heading"
            className="text-[11px] font-semibold tracking-wider uppercase text-muted mb-3"
          >
            Upcoming events
          </h2>

          {/* Filter chips */}
          <div
            className="flex gap-1.5 mb-3"
            role="tablist"
            aria-label="Filter upcoming events"
            data-testid="desktop-event-links-filter-chips"
          >
            {EVENT_FILTERS.map((f) => {
              const active = f === filter;
              return (
                <button
                  key={f}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setFilter(f)}
                  className={`px-3 py-1 rounded-full text-[11px] font-medium border transition ${
                    active
                      ? "border-accent text-accent bg-accent/10"
                      : "border-secondary text-secondary hover:border-accent/40"
                  }`}
                  data-testid={`desktop-event-links-filter-${f}`}
                >
                  {EVENT_FILTER_LABELS[f]}
                </button>
              );
            })}
          </div>

          {!eventsLoaded ? (
            <div className="px-3 py-2 text-sm text-muted">Loading…</div>
          ) : filteredEvents.length === 0 ? (
            <div className="px-3 py-4 text-sm text-muted text-center">
              {filter === "all" ? "No upcoming events." : "Nothing in this filter."}
            </div>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {filteredEvents.map((s) => {
                const bucket = classifySession(s, Date.now());
                const pill = statusPillColor(bucket);
                const guestLabel =
                  s.guestName ||
                  s.link?.inviteeName ||
                  s.guestEmail ||
                  s.link?.inviteeEmail ||
                  "Guest";
                const title = s.title || s.link?.topic || `Meeting with ${guestLabel}`;
                const sub = buildEventSub(s);
                const isCancellable = bucket !== "past";

                if (confirmCancelId === s.id) {
                  return (
                    <li
                      key={s.id}
                      className="flex items-center gap-3 px-4 py-3 rounded-xl border border-red-500/30 bg-red-50 dark:bg-red-950/20"
                      data-testid="desktop-event-links-cancel-confirm"
                    >
                      <span className="text-sm text-secondary flex-1">
                        {bucket === "confirmed"
                          ? "Cancel this meeting?"
                          : "Stop coordinating this event?"}
                      </span>
                      <button
                        onClick={() => setConfirmCancelId(null)}
                        className="text-xs text-muted hover:text-secondary transition px-3 py-1.5"
                      >
                        Keep
                      </button>
                      <button
                        onClick={() => {
                          if (bucket === "confirmed") handleCancel(s.id);
                          else {
                            handleArchive(s.id);
                            setConfirmCancelId(null);
                          }
                        }}
                        disabled={cancelling === s.id || archiving === s.id}
                        className="text-xs font-medium text-red-600 hover:text-red-500 dark:text-red-400 dark:hover:text-red-300 border border-red-500/30 rounded px-3 py-1.5 transition disabled:opacity-50"
                      >
                        {cancelling === s.id || archiving === s.id ? "…" : "Yes"}
                      </button>
                    </li>
                  );
                }

                return (
                  <li
                    key={s.id}
                    className="flex items-center gap-3 px-4 py-3.5 rounded-xl border border-secondary bg-surface-secondary/40"
                    data-testid={`desktop-event-links-row-${bucket}`}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-primary truncate">
                        {title}
                      </div>
                      {sub && (
                        <div className="text-xs text-muted truncate leading-snug mt-0.5">
                          {sub}
                        </div>
                      )}
                    </div>
                    <span
                      className={`flex-shrink-0 px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide ${pill.bg} ${pill.text}`}
                    >
                      {EVENT_PILL_LABELS[bucket]}
                    </span>
                    {isCancellable && (
                      <button
                        type="button"
                        onClick={() => setConfirmCancelId(s.id)}
                        className="flex-shrink-0 text-xs text-red-600 hover:text-red-500 dark:text-red-400 dark:hover:text-red-300 transition px-2"
                        data-testid={`desktop-event-links-cancel-${s.id}`}
                        title="Cancel"
                      >
                        Cancel
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => handleArchive(s.id)}
                      disabled={archiving === s.id}
                      className="flex-shrink-0 p-1.5 rounded-md text-zinc-500 hover:text-primary hover:bg-surface-secondary/60 transition disabled:opacity-50"
                      data-testid={`desktop-event-links-archive-${s.id}`}
                      title="Archive"
                      aria-label={`Archive ${title}`}
                    >
                      {archiving === s.id ? (
                        <span className="text-xs text-muted">…</span>
                      ) : (
                        <svg
                          className="w-4 h-4"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                          strokeWidth={2}
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M5 8a2 2 0 012-2h10a2 2 0 012 2v2H5V8zm0 4h14v6a2 2 0 01-2 2H7a2 2 0 01-2-2v-6zm5 2h4"
                          />
                        </svg>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>

      {/* Edit dialog — reuses the mobile dialog component (chrome-neutral
          modal that overlays the page). Desktop-specific edit chrome can
          be a follow-up if/when the bottom-sheet feel reads wrong on
          wide viewports. */}
      <EventLinksEditDialog
        row={editing}
        onSaved={() => {
          setReusableLoaded(false);
          refetchReusable();
        }}
        onDismiss={() => setEditing(null)}
      />
    </div>
  );
}
