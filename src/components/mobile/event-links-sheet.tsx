"use client";

/**
 * Mobile Event Links sheet — slide-up from the topbar header pill.
 *
 * **Two-group layout (PR 7):**
 *
 *  1. **Reusable links** — Primary pinned at top, then Office Hours / other
 *     variants. Each card carries an inline URL + Copy chip and an Edit
 *     affordance. A "Create a reusable link" tile prefills the chat
 *     composer at the bottom.
 *  2. **Upcoming events** — filterable chips (All / Coordinating /
 *     Confirmed / Needs you / Past). Each row: name + via-link sub-line
 *     + status pill + Cancel + Archive affordances. No row icon.
 *
 * Edit dialog opens on Edit tap; Office Hours variant embeds PR 5's
 * `RuleFormFields` and POSTs to `/api/availability-rules/edit`.
 *
 * Vocabulary: "Primary link" (capitalized — SPEC §2.2; matches
 * `NegotiationLink.type === "primary"`); "Office Hours" (capitalized —
 * feature name); status pill labels per `event-links-buckets.ts`.
 *
 * Animation primitive: pure CSS transform driven by an `open` prop. No
 * external dependency.
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { AvailabilityRule } from "@/lib/availability-rules";
import { getBookableLinkDisplayName } from "@/lib/availability-rules";
import {
  classifySession,
  matchesFilter,
  EVENT_FILTERS,
  EVENT_FILTER_LABELS,
  EVENT_PILL_LABELS,
  DEFAULT_EVENT_FILTER,
  type EventFilter,
  type SessionLike,
} from "@/lib/event-links-buckets";
import { EventLinksCard, type ReusableLinkRow } from "./event-links-card";
import { EventLinksEditDialog } from "./event-links-edit-dialog";
import { PrimaryEditDialog } from "@/components/links/primary-edit-dialog";
import { CreateLinkPickerMobile } from "@/components/desktop/create-link-picker";

interface EventLinksSheetProps {
  open: boolean;
  onClose: () => void;
}

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
  // Mon–Fri shortcut.
  if (days.length === 5 && [1, 2, 3, 4, 5].every((d) => days.includes(d))) {
    return "Mon–Fri";
  }
  // Sat–Sun shortcut.
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

function buildBookableLinkSub(rule: AvailabilityRule): string {
  const oh = rule.bookable ?? (rule as unknown as { officeHours?: typeof rule.bookable }).officeHours;
  if (!oh) return "Drop-in Hours";
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
  if (s.link?.type === "bookable") return "via Drop-in Hours";
  if (s.link?.topic) return s.link.topic;
  if (s.link?.inviteeName) return `with ${s.link.inviteeName}`;
  return "";
}

function statusPillColor(bucket: string): { bg: string; text: string } {
  // Updated 2026-05-02 V1 redesign: needs_you retired, past split into
  // complete/cancelled. See `event-links-buckets.ts` for the canonical
  // bucket list.
  switch (bucket) {
    case "confirmed":
      return { bg: "bg-green-500/10", text: "text-green-400" };
    case "complete":
      return { bg: "bg-zinc-500/10", text: "text-zinc-400" };
    case "cancelled":
      return { bg: "bg-red-500/10", text: "text-red-400" };
    case "coordinating":
    default:
      return { bg: "bg-indigo-500/10", text: "text-indigo-400" };
  }
}

export function EventLinksSheet({ open, onClose }: EventLinksSheetProps) {
  const [mounted, setMounted] = useState(false);
  const [reusableRows, setReusableRows] = useState<ReusableLinkRow[]>([]);
  const [reusableLoaded, setReusableLoaded] = useState(false);
  const [events, setEvents] = useState<UpcomingEventRow[]>([]);
  const [eventsLoaded, setEventsLoaded] = useState(false);
  const [filter, setFilter] = useState<EventFilter>(DEFAULT_EVENT_FILTER);
  const [editing, setEditing] = useState<ReusableLinkRow | null>(null);
  const [editingPrimary, setEditingPrimary] = useState(false);
  const [archiving, setArchiving] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [confirmCancelId, setConfirmCancelId] = useState<string | null>(null);
  const [linkFilter, setLinkFilter] = useState<"active" | "paused">("active");
  const [togglingStatus, setTogglingStatus] = useState<string | null>(null);

  // Route Edit on Primary to PrimaryEditDialog (V1 Stage 2); other
  // variance rows continue to use EventLinksEditDialog.
  function handleEditClick(row: ReusableLinkRow) {
    if (row.kind === "primary") {
      setEditingPrimary(true);
    } else {
      setEditing(row);
    }
  }

  useEffect(() => {
    if (open) setMounted(true);
  }, [open]);

  // Reusable links — same data source as MyLinksPopover; refetch on open
  // and on a saved-edit ping so newly-created or edited links appear.
  function refetchReusable() {
    fetch("/api/tuner/preferences")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data) return;
        const origin = typeof window !== "undefined" ? window.location.origin : "";
        const slug = data.meetSlug as string | null | undefined;
        const out: ReusableLinkRow[] = [];
        if (slug) {
          const primaryName = (data.primaryLinkName as string) || "Primary link";
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
          const structured =
            (data.structuredRules as AvailabilityRule[]) ?? [];
          for (const r of structured) {
            const bookableData = r.bookable;
            const rStatus = (r.status as string | undefined) ?? "active";
            if (r.action !== "bookable" || rStatus === "expired" || !bookableData) continue;
            const oh = bookableData;
            if (!oh.linkCode || !oh.linkSlug) continue;
            out.push({
              key: r.id,
              kind: "bookable",
              name: getBookableLinkDisplayName(oh),
              sub: buildBookableLinkSub(r),
              url: `${origin}/meet/${oh.linkSlug}/${oh.linkCode}`,
              icon: "🕐",
              status: (rStatus === "paused" ? "paused" : "active") as "active" | "paused",
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

  function refetchEvents(forFilter: EventFilter = filter) {
    const url =
      forFilter === "all"
        ? "/api/negotiate/sessions"
        : "/api/negotiate/sessions?archived=false";
    fetch(url)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data?.sessions) return;
        setEvents(data.sessions as UpcomingEventRow[]);
      })
      .finally(() => setEventsLoaded(true));
  }

  useEffect(() => {
    if (!open) return;
    setReusableLoaded(false);
    setEventsLoaded(false);
    refetchReusable();
    refetchEvents(filter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Toggling to/from "all" needs a re-fetch so archived rows arrive.
  useEffect(() => {
    if (!open) return;
    refetchEvents(filter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  const filteredEvents = useMemo(() => {
    const now = Date.now();
    return events.filter((s) => matchesFilter(s, filter, now));
  }, [events, filter]);

  async function handleToggleStatus(row: ReusableLinkRow) {
    if (!row.ruleId) return;
    const next = row.status === "paused" ? "active" : "paused";
    setTogglingStatus(row.ruleId);
    try {
      const res = await fetch("/api/availability-rules/status", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ruleId: row.ruleId, status: next }),
      });
      if (res.ok) {
        setReusableRows((prev) =>
          prev.map((r) => (r.key === row.key ? { ...r, status: next } : r)),
        );
      }
    } catch {
      // silent
    } finally {
      setTogglingStatus(null);
    }
  }

  async function handleSetArchived(sessionId: string, archived: boolean) {
    setArchiving(sessionId);
    try {
      const res = await fetch("/api/negotiate/archive", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, archived }),
      });
      if (res.ok) {
        if (filter === "all") {
          setEvents((prev) =>
            prev.map((s) => (s.id === sessionId ? { ...s, archived } : s)),
          );
        } else {
          setEvents((prev) => prev.filter((s) => s.id !== sessionId));
        }
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

  if (!mounted) return null;

  return (
    <div
      className={`fixed inset-0 z-[60] md:hidden transition-opacity duration-200 ${
        open ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
      }`}
      aria-hidden={!open}
      data-testid="mobile-event-links-sheet"
    >
      {/* Overlay — tap to close. `top-12` mirrors the mockup `links-overlay`
          starting below the topbar so the avatar/calendar icon remain
          visible. */}
      <button
        type="button"
        onClick={onClose}
        className="absolute inset-x-0 top-12 bottom-0 bg-black/55"
        aria-label="Close Event Links"
        tabIndex={open ? 0 : -1}
      />

      {/* Sheet panel — slides up from the bottom */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="mobile-event-links-title"
        className={`absolute inset-x-0 bottom-0 bg-surface border-t border-secondary rounded-t-[18px] h-[88%] overflow-y-auto px-4 py-3 transition-transform duration-300 ease-out ${
          open ? "translate-y-0" : "translate-y-full"
        }`}
      >
        {/* Sheet handle */}
        <div className="w-10 h-1 rounded-full bg-secondary mx-auto mb-3" />

        <div className="flex items-center justify-between mb-2">
          <h3 id="mobile-event-links-title" className="text-base font-semibold text-primary tracking-tight">
            Event Links
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="w-7 h-7 rounded-full bg-surface-secondary/80 flex items-center justify-center text-secondary hover:text-primary"
            aria-label="Close"
            data-testid="mobile-event-links-close"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* GROUP 1 — My Bookable Links */}
        <div className="flex items-center gap-2 mt-2 mb-2 px-1">
          <div className="text-[10px] font-semibold tracking-wider uppercase text-muted">
            My Bookable Links
          </div>
          {reusableLoaded && reusableRows.some((r) => r.kind === "bookable") && (
            <div className="flex gap-1" role="tablist" aria-label="Filter bookable links">
              {(["active", "paused"] as const).map((f) => {
                const active = linkFilter === f;
                const count = reusableRows.filter(
                  (r) => r.kind === "bookable" && (r.status ?? "active") === f,
                ).length;
                return (
                  <button
                    key={f}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => setLinkFilter(f)}
                    className={`px-2 py-0.5 rounded-full text-[9.5px] font-medium border transition ${
                      active
                        ? "border-accent text-accent bg-accent/10"
                        : "border-secondary text-secondary"
                    }`}
                    data-testid={`mobile-links-filter-${f}`}
                  >
                    {f === "active" ? "Active" : "Paused"} · {count}
                  </button>
                );
              })}
            </div>
          )}
        </div>
        {!reusableLoaded ? (
          <div className="px-3 py-2 text-xs text-muted">Loading…</div>
        ) : reusableRows.length === 0 ? (
          <div className="px-3 py-2 text-xs text-muted">No links yet.</div>
        ) : (
          <div className="flex flex-col gap-2">
            {reusableRows
              .filter(
                (r) => r.kind === "primary" || (r.status ?? "active") === linkFilter,
              )
              .map((r) => (
                <div key={r.key} className={r.status === "paused" ? "opacity-60" : ""}>
                  <EventLinksCard
                    row={r}
                    onEdit={handleEditClick}
                  />
                  {r.kind === "bookable" && (
                    <button
                      type="button"
                      onClick={() => handleToggleStatus(r)}
                      disabled={togglingStatus === r.ruleId}
                      className={`mt-1 ml-1 text-[10px] transition disabled:opacity-50 ${
                        r.status === "paused"
                          ? "text-emerald-500 hover:text-emerald-400"
                          : "text-muted hover:text-secondary"
                      }`}
                      data-testid={`mobile-links-${r.status === "paused" ? "reactivate" : "pause"}-${r.key}`}
                    >
                      {togglingStatus === r.ruleId
                        ? "…"
                        : r.status === "paused"
                          ? "Reactivate"
                          : "Pause"}
                    </button>
                  )}
                </div>
              ))}
          </div>
        )}

        {/* Create-a-reusable-link — H-scroll suggestion cards (3 type cards).
            V1 design (2026-05-02). The picker dispatches its own prefill +
            navigates home; sheet closes via the route change. */}
        <div className="-mx-4 mt-3" data-testid="mobile-event-links-create-section">
          <CreateLinkPickerMobile />
        </div>

        {/* GROUP 2 — My Events */}
        <div className="text-[10px] font-semibold tracking-wider uppercase text-muted mt-5 mb-2 px-1">
          My Events
        </div>

        {/* Filter chips */}
        <div
          className="flex gap-1.5 mb-2 overflow-x-auto -mx-1 px-1 pb-1"
          role="tablist"
          aria-label="Filter my events"
          data-testid="mobile-event-links-filter-chips"
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
                className={`px-2.5 py-1 rounded-full text-[10.5px] font-medium border transition flex-shrink-0 ${
                  active
                    ? "border-accent text-accent bg-accent/10"
                    : "border-secondary text-secondary hover:border-accent/40"
                }`}
                data-testid={`mobile-event-links-filter-${f}`}
              >
                {EVENT_FILTER_LABELS[f]}
              </button>
            );
          })}
        </div>

        {!eventsLoaded ? (
          <div className="px-3 py-2 text-xs text-muted">Loading…</div>
        ) : filteredEvents.length === 0 ? (
          <div className="px-3 py-3 text-xs text-muted text-center">
            {filter === "all" ? "No events yet." : "Nothing in this filter."}
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
              // Cancellable: only live sessions (coordinating / confirmed).
              // Complete + cancelled rows are terminal — no cancel action.
              const isCancellable = bucket === "coordinating" || bucket === "confirmed";

              if (confirmCancelId === s.id) {
                return (
                  <li
                    key={s.id}
                    className="flex items-center gap-2 px-3 py-2 rounded-xl border border-red-500/30 bg-red-950/20"
                    data-testid="mobile-event-links-cancel-confirm"
                  >
                    <span className="text-[11px] text-secondary flex-1">
                      {bucket === "confirmed"
                        ? "Cancel this meeting?"
                        : "Stop coordinating this event?"}
                    </span>
                    <button
                      onClick={() => setConfirmCancelId(null)}
                      className="text-[10px] text-muted hover:text-secondary transition px-2 py-1"
                    >
                      Keep
                    </button>
                    <button
                      onClick={() => {
                        if (bucket === "confirmed") handleCancel(s.id);
                        else {
                          handleSetArchived(s.id, true);
                          setConfirmCancelId(null);
                        }
                      }}
                      disabled={cancelling === s.id || archiving === s.id}
                      className="text-[10px] font-medium text-red-400 hover:text-red-300 border border-red-500/30 rounded px-2 py-1 transition disabled:opacity-50"
                    >
                      {cancelling === s.id || archiving === s.id ? "…" : "Yes"}
                    </button>
                  </li>
                );
              }

              return (
                <li
                  key={s.id}
                  className={`flex items-center gap-2 p-2.5 rounded-xl border border-secondary bg-surface-secondary/40 ${
                    s.archived ? "opacity-50" : ""
                  }`}
                  data-testid={`mobile-event-links-row-${bucket}${s.archived ? "-archived" : ""}`}
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-semibold text-primary truncate">{title}</div>
                    {sub && (
                      <div className="text-[10.5px] text-muted truncate leading-snug">{sub}</div>
                    )}
                  </div>
                  <span
                    className={`flex-shrink-0 px-1.5 py-0.5 rounded-full text-[9px] font-semibold uppercase tracking-wide ${pill.bg} ${pill.text}`}
                  >
                    {EVENT_PILL_LABELS[bucket]}
                  </span>
                  {isCancellable && (
                    <button
                      type="button"
                      onClick={() => setConfirmCancelId(s.id)}
                      className="flex-shrink-0 text-[10px] text-red-400 hover:text-red-300 transition"
                      data-testid={`mobile-event-links-cancel-${s.id}`}
                      title="Cancel"
                    >
                      Cancel
                    </button>
                  )}
                  {s.archived ? (
                    <button
                      type="button"
                      onClick={() => handleSetArchived(s.id, false)}
                      disabled={archiving === s.id}
                      className="flex-shrink-0 px-2 py-1 rounded-md text-[10px] text-secondary hover:text-accent transition disabled:opacity-50"
                      data-testid={`mobile-event-links-unarchive-${s.id}`}
                      title="Unarchive"
                      aria-label={`Unarchive ${title}`}
                    >
                      {archiving === s.id ? "…" : "Unarchive"}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => handleSetArchived(s.id, true)}
                      disabled={archiving === s.id}
                      className="flex-shrink-0 p-1 rounded-md text-zinc-500 hover:text-primary hover:bg-surface-secondary/60 transition disabled:opacity-50"
                      data-testid={`mobile-event-links-archive-${s.id}`}
                      title="Archive"
                      aria-label={`Archive ${title}`}
                    >
                      {archiving === s.id ? (
                        <span className="text-[10px] text-muted">…</span>
                      ) : (
                        <svg
                          className="w-3.5 h-3.5"
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
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {/* Hand-off to the full meetings page */}
        <Link
          href="/dashboard/meetings"
          onClick={onClose}
          className="block mt-3 p-2 rounded-xl text-center text-[11px] text-secondary hover:text-accent transition"
          data-testid="mobile-event-links-meetings-link"
        >
          See all events →
        </Link>
      </div>

      {/* Edit dialogs — anchored to the sheet so they overlay both groups.
          Primary uses the V1 Stage 2 posture editor (writes to
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
    </div>
  );
}
