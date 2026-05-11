"use client";

import { useState, useMemo, useEffect } from "react";
import { DragSlotPicker } from "./drag-slot-picker";
import { selectPickerVariant } from "./picker/registry";
import { formatDuration, formatDurationCompact } from "@/lib/format-duration";
import {
  binSlotsIntoWindows,
  assertBinningTz,
  type WindowCard,
} from "@/lib/window-binning";

interface Slot {
  start: string;
  end: string;
  score?: number;
  isShortSlot?: boolean; // fits minDuration but not full duration
  isStretch?: boolean;   // VIP stretch slot (score 2-3) — shown orange
}

interface BilateralChip {
  start: string;
  end: string;
  color: "both" | "one";
}

// exported for picker/registry.ts only — do not import elsewhere
export interface AvailabilityCalendarProps {
  slotsByDay: Record<string, Slot[]>;
  timezone: string;
  onSelectSlot?: (formattedTime: string, slot: { start: string; end: string }) => void;
  /** Date-mode: called with YYYY-MM-DD when guest taps a day. */
  onSelectDate?: (dateStr: string) => void;
  currentLocation?: { label: string; until?: string } | null;
  onClearLocation?: () => void;
  view?: "month" | "week";
  /** When "date", renders a date-picker grid instead of time-slot pills. */
  schedulingMode?: "time" | "date";
  onTimezoneClick?: () => void;
  duration?: number;
  minDuration?: number;
  headerSlot?: React.ReactNode;
  footerSlot?: React.ReactNode;
  /** Bilateral chips per day — drives "Both" badge + loose-mutual reveal count. */
  bilateralByDay?: Record<string, BilateralChip[]> | null;
  /** Canonical bilateral payload from PR-A1 — feeds the Detailed tab's
   *  stacked timeline render in PR-B2. Optional; absent for sessions with
   *  no guest snapshot or for older clients. */
  bilateralPayload?: import("@/lib/bilateral-availability").BilateralPayload | null;
  /** First name of the host — reveal link reads "+ N more windows {name} prefers but you're busy". */
  hostFirstName?: string;
  /** Host profile image URL for the "Both" badge (Google photo → <img>; null → initials circle). */
  hostImage?: string | null;
  /** Guest profile image URL for the "Both" badge. */
  guestImage?: string | null;
  /** First name of the host — drives initials fallback when hostImage is missing. */
  hostInitialSource?: string;
  /** First name of the guest — drives initials fallback when guestImage is missing. */
  guestInitialSource?: string;
  /** Event title shown in the match banner: "We matched these options for your {eventTitle}" */
  eventTitle?: string;
  /**
   * Pass-through to DragSlotPicker: when true, the drag picker switches
   * its badge text to "Rescheduled" and auto-resets after each pick. Used
   * by the confirmed-card reschedule overlay where each pick patches GCal
   * in place (no downstream confirm form to stage against).
   */
  inPlaceApplyMode?: boolean;
}

function getSlotColor(slots: Slot[], isPast: boolean) {
  if (isPast) return "bg-zinc-200 dark:bg-zinc-900 text-zinc-400 dark:text-zinc-700";
  // Available slots (score ≤ 1) take priority over stretch (orange).
  const available = slots.filter((s) => !s.isStretch && (s.score ?? 0) <= 1);
  if (available.length > 0) return "bg-indigo-50 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-300";
  const stretch = slots.filter((s) => s.isStretch);
  if (stretch.length > 0) return "bg-orange-100 dark:bg-orange-900/40 text-orange-600 dark:text-orange-300";
  return "bg-zinc-100 dark:bg-zinc-800/50 text-zinc-400 dark:text-zinc-600";
}

function getSlotPillColor(slot: Slot) {
  if (slot.isStretch) {
    return "border-orange-400 dark:border-orange-700 text-orange-600 dark:text-orange-300 hover:border-orange-500";
  }
  return "border-indigo-300 dark:border-indigo-800 text-indigo-700 dark:text-indigo-300 hover:border-indigo-500 hover:bg-indigo-50/60";
}

function isSlotVisible(slot: Slot): boolean {
  // Stretch slots (score 2-3) are tagged explicitly by the API when isVip.
  // Regular slots: show score ≤ 1. Score 2+ without isStretch tag = hidden.
  return slot.isStretch === true || (slot.score ?? 0) <= 1;
}

function isSlotClickable(slot: Slot): boolean {
  // Score 0 and 1 are both fully schedulable (green). Stretch is also
  // clickable so the guest can propose a stretch time — the LLM handles it.
  return slot.isStretch === true || (slot.score ?? 0) <= 1;
}

const DAY_HEADERS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const DAY_LABELS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Get the Sunday-start week containing a given date */
function getWeekStart(d: Date): Date {
  const result = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  result.setDate(result.getDate() - result.getDay());
  return result;
}

function toDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Format a slot as a human-readable time proposal, including end time */
function formatSlotMessage(slot: Slot, dateStr: string, timezone: string) {
  const date = new Date(dateStr + "T12:00:00");
  const dayStr = date.toLocaleDateString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
  });
  const fmtTime = (iso: string) =>
    new Date(iso).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: timezone,
    });
  const startStr = fmtTime(slot.start);
  const endStr = fmtTime(slot.end);
  const tzAbbr = new Intl.DateTimeFormat("en-US", {
    timeZoneName: "short",
    timeZone: timezone,
  })
    .formatToParts(new Date(slot.start))
    .find((p) => p.type === "timeZoneName")?.value ?? "";
  return `How about ${dayStr}, ${startStr}–${endStr} ${tzAbbr}?`;
}

// ─── Shared sub-components ────────────────────────────────────────────

function SlotPills({
  slots,
  dateStr,
  timezone,
  onSelectSlot,
  duration,
  minDuration,
}: {
  slots: Slot[];
  dateStr: string;
  timezone: string;
  onSelectSlot?: (msg: string, slot: { start: string; end: string }) => void;
  duration?: number;
  minDuration?: number;
}) {
  const visible = slots.filter((s) => isSlotVisible(s));
  if (visible.length === 0) return <p className="text-xs text-muted">No available slots</p>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {visible.map((slot, i) => {
        const clickable = isSlotClickable(slot);
        const isShort = slot.isShortSlot === true;
        const shortTooltip = isShort && duration && minDuration
          ? `${formatDuration(minDuration)} available — ${formatDuration(duration)} if adjacent time opens up`
          : isShort
          ? "Short window — may not fit full meeting"
          : undefined;
        const tooltipText = !clickable ? "Potentially doable" : shortTooltip;
        return (
          <button
            key={i}
            onClick={() => clickable && onSelectSlot?.(formatSlotMessage(slot, dateStr, timezone), { start: slot.start, end: slot.end })}
            disabled={!clickable}
            title={tooltipText}
            className={`px-2 py-1 bg-surface-secondary border rounded-md text-xs transition
              ${isShort
                ? "border-dashed border-indigo-300 dark:border-indigo-800 text-indigo-700 dark:text-indigo-300 opacity-80"
                : getSlotPillColor(slot)}
              ${clickable && onSelectSlot ? "hover:bg-surface-tertiary cursor-pointer" : "cursor-default opacity-70"}`}
          >
            {new Date(slot.start).toLocaleTimeString("en-US", {
              hour: "numeric",
              minute: "2-digit",
              timeZone: timezone,
            })}
          </button>
        );
      })}
    </div>
  );
}

// ─── Match header banner ──────────────────────────────────────────────────────

function MatchHeader({ eventTitle }: { eventTitle: string }) {
  return (
    <div className="flex items-center gap-3 px-4 py-3 bg-gradient-to-br from-emerald-950/80 to-cyan-950/60 border-b border-emerald-900/40">
      {/* Dual-calendar icon */}
      <div className="relative w-[42px] h-[38px] shrink-0">
        {/* back calendar */}
        <div className="absolute bottom-0 left-0 w-[28px] h-[26px] rounded-[5px] border border-cyan-500/60 bg-cyan-950/50 flex flex-col overflow-hidden">
          <div className="h-[7px] bg-white/10 shrink-0" />
          <div className="flex-1 grid grid-cols-3 gap-px p-0.5">
            {[0,1,2,3,4,5].map(i => <div key={i} className="w-[3px] h-[3px] rounded-full bg-white/25 m-auto" />)}
          </div>
        </div>
        {/* front calendar */}
        <div className="absolute top-0 right-0 w-[28px] h-[26px] rounded-[5px] border border-emerald-400/70 bg-emerald-950/60 flex flex-col overflow-hidden">
          <div className="h-[7px] bg-white/10 shrink-0" />
          <div className="flex-1 grid grid-cols-3 gap-px p-0.5">
            {[true,false,true,false,true,false].map((lit, i) => (
              <div key={i} className={`w-[3px] h-[3px] rounded-full m-auto ${lit ? "bg-emerald-400" : "bg-white/25"}`} />
            ))}
          </div>
        </div>
        {/* overlap ring */}
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[14px] h-[14px] rounded-full border-2 border-emerald-400/90 bg-emerald-400/15 flex items-center justify-center text-[7px] text-emerald-400 font-black">
          ✦
        </div>
      </div>
      {/* Copy */}
      <p className="text-[13px] font-extrabold text-white leading-snug">
        We matched these options for your{" "}
        <span className="text-emerald-400">{eventTitle}</span>
      </p>
    </div>
  );
}

// ─── "Both" badge — two tiny avatars w/ initials fallback (§12.5, §12.8.1) ───

function initialsCircleColor(source: string): string {
  // Deterministic hash → tailwind color class.
  const palette = [
    "bg-emerald-600", "bg-sky-600", "bg-violet-600", "bg-rose-600",
    "bg-amber-600", "bg-cyan-600", "bg-fuchsia-600", "bg-indigo-600",
  ];
  let h = 0;
  for (let i = 0; i < source.length; i++) h = (h * 31 + source.charCodeAt(i)) >>> 0;
  return palette[h % palette.length];
}

function AvatarCircle({ image, source }: { image?: string | null; source: string }) {
  const initial = (source || "?").trim().charAt(0).toUpperCase() || "?";
  if (image) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={image}
        alt=""
        className="w-3.5 h-3.5 rounded-full border border-surface-primary object-cover"
      />
    );
  }
  return (
    <span
      className={`inline-flex w-3.5 h-3.5 rounded-full items-center justify-center text-[7px] font-semibold text-white border border-surface-primary ${initialsCircleColor(source)}`}
      aria-hidden="true"
    >
      {initial}
    </span>
  );
}

function BothBadge({
  hostImage, guestImage, hostSource, guestSource,
}: {
  hostImage?: string | null;
  guestImage?: string | null;
  hostSource: string;
  guestSource: string;
}) {
  return (
    <span
      className="inline-flex items-center gap-0.5 px-1 py-0.5 rounded-full bg-emerald-950/50 border border-emerald-800/60 text-[9px] font-medium text-emerald-300"
      title="Both calendars confirm this window"
    >
      <span className="inline-flex -space-x-1">
        <AvatarCircle image={hostImage} source={hostSource} />
        <AvatarCircle image={guestImage} source={guestSource} />
      </span>
      <span className="ml-0.5">Both</span>
    </span>
  );
}

// ─── WindowCards — new default render replacing SlotPills (§12, §13) ────

const MAX_CARDS_PER_DAY = 3;

function windowIsMatched(window: WindowCard, chips: BilateralChip[] | undefined): boolean {
  if (!chips || chips.length === 0) return false;
  const ws = new Date(window.start).getTime();
  const we = new Date(window.end).getTime();
  return chips.some((c) => {
    if (c.color !== "both") return false;
    const cs = new Date(c.start).getTime();
    return cs >= ws && cs < we;
  });
}

function formatWindowMessage(card: WindowCard, dateStr: string, tz: string) {
  const date = new Date(dateStr + "T12:00:00");
  const dayStr = date.toLocaleDateString("en-US", {
    weekday: "long", month: "short", day: "numeric",
  });
  const fmt = (iso: string) =>
    new Date(iso).toLocaleTimeString("en-US", {
      hour: "numeric", minute: "2-digit", timeZone: tz,
    });
  const tzAbbr = new Intl.DateTimeFormat("en-US", {
    timeZoneName: "short", timeZone: tz,
  }).formatToParts(new Date(card.defaultStart))
    .find((p) => p.type === "timeZoneName")?.value ?? "";
  return `How about ${dayStr}, ${fmt(card.defaultStart)}–${fmt(card.defaultEnd)} ${tzAbbr}?`;
}

function SlotChipRows({
  windows,
  slotsForDay,
  chipsForDay,
  dateStr,
  timezone,
  onSelectSlot,
  looseMutualCount,
  hostFirstName,
}: {
  windows: WindowCard[];
  slotsForDay: Slot[];
  chipsForDay: BilateralChip[] | undefined;
  dateStr: string;
  timezone: string;
  onSelectSlot?: (msg: string, slot: { start: string; end: string }) => void;
  looseMutualCount: number;
  hostFirstName?: string;
}) {
  const fmt = (iso: string) =>
    new Date(iso).toLocaleTimeString("en-US", {
      hour: "numeric", minute: "2-digit", timeZone: timezone,
    });

  // Two-lane bucketing: AM (hour < 12) and PM (hour ≥ 12), tz-aware. Replaces
  // the prior per-window grouping which (a) created vertical clutter with one
  // label-row + one pill-row per WindowCard, and (b) could render the same
  // daypart label twice when window-binning split a band into two non-
  // contiguous pieces both falling mostly in the morning (bug 2026-04-23).
  // Bucketing by hour-of-day eliminates the dedup problem entirely.
  const hourInTz = (iso: string) => {
    const h = new Intl.DateTimeFormat("en-US", {
      hour: "numeric", hour12: false, timeZone: timezone,
    }).format(new Date(iso));
    return parseInt(h, 10);
  };

  const allSlots = slotsForDay.filter((s) => (s.score ?? 0) <= 1);
  // `windows` is still consumed for ordering / future window-level features,
  // but slot pills now render flat by lane. Keep a stable sort so AM/PM rows
  // read left → right by start time.
  void windows;
  const amSlots = allSlots.filter((s) => hourInTz(s.start) < 12)
    .sort((a, b) => a.start.localeCompare(b.start));
  const pmSlots = allSlots.filter((s) => hourInTz(s.start) >= 12)
    .sort((a, b) => a.start.localeCompare(b.start));

  if (amSlots.length === 0 && pmSlots.length === 0) {
    return <p className="text-xs text-muted">No available times</p>;
  }

  // Bilateral split (PR-B1 of bilateral+picker bundle). When bilateral data
  // is present, mutual chips render inline as the primary picks; host-only
  // chips collapse into a tappable "+ N more times {host} has open (you're
  // busy)" reveal. Without bilateral data (anonymous-guest path, no
  // calendar connect yet), every host-bookable chip renders inline as
  // before — there's no second class to split out.
  const matchedSet = new Set(
    chipsForDay?.filter((c) => c.color === "both").map((c) => c.start) ?? [],
  );
  const hasBilateral = chipsForDay !== undefined && chipsForDay.length > 0;

  const splitChips = (chips: Slot[]) => {
    if (!hasBilateral) return { primary: chips, hostOnly: [] as Slot[] };
    return {
      primary: chips.filter((s) => matchedSet.has(s.start)),
      hostOnly: chips.filter((s) => !matchedSet.has(s.start)),
    };
  };

  const am = splitChips(amSlots);
  const pm = splitChips(pmSlots);
  const hostOnlyTotal = am.hostOnly.length + pm.hostOnly.length;

  const renderChip = (slot: Slot, key: string, variant: "matched" | "open" | "hostOnly") => {
    return (
      <button
        key={key}
        onClick={() =>
          onSelectSlot?.(
            formatSlotMessage(slot, dateStr, timezone),
            { start: slot.start, end: slot.end },
          )
        }
        disabled={!onSelectSlot}
        className={`
          inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-medium leading-none border transition-all
          ${variant === "matched"
            ? "border-emerald-300 dark:border-emerald-700 bg-emerald-100 dark:bg-emerald-950/40 text-emerald-900 dark:text-emerald-100 hover:bg-emerald-200 dark:hover:bg-emerald-900/60 hover:border-emerald-400"
            : variant === "hostOnly"
              ? "border-dashed border-zinc-300 dark:border-zinc-700 bg-transparent text-zinc-500 dark:text-zinc-500 hover:border-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
              : "border-indigo-300 dark:border-indigo-700 bg-indigo-50 dark:bg-indigo-950/30 text-indigo-900 dark:text-indigo-100 hover:bg-indigo-100 dark:hover:bg-indigo-900/50 hover:border-indigo-400"}
          ${onSelectSlot ? "cursor-pointer" : "cursor-default opacity-70"}
        `}
      >
        <span className="py-1">{fmt(slot.start)}</span>
      </button>
    );
  };

  const PrimaryLane = ({ label, slots }: { label: string; slots: Slot[] }) => (
    <div className="grid grid-cols-[56px_1fr] gap-2.5 items-start">
      <div className="text-[10px] uppercase tracking-wider text-muted font-medium pt-1.5">{label}</div>
      <div className="flex flex-wrap gap-1">
        {slots.map((slot, si) =>
          renderChip(slot, `pri-${label}-${si}`, hasBilateral ? "matched" : "open"),
        )}
      </div>
    </div>
  );

  const showHostOnlyReveal = hostOnlyTotal > 0;

  return (
    <div className="space-y-1.5">
      {am.primary.length > 0 && <PrimaryLane label="Morning" slots={am.primary} />}
      {pm.primary.length > 0 && <PrimaryLane label="Afternoon" slots={pm.primary} />}
      {hasBilateral && am.primary.length === 0 && pm.primary.length === 0 && (
        <p className="text-xs text-muted pl-[66px]">
          No matched times this day — see {hostFirstName || "the host"}&apos;s other open times below.
        </p>
      )}
      {showHostOnlyReveal && <HostOnlyReveal
        hostFirstName={hostFirstName}
        amSlots={am.hostOnly}
        pmSlots={pm.hostOnly}
        renderChip={renderChip}
        looseMutualCount={looseMutualCount}
      />}
    </div>
  );
}

/**
 * "+ N times {host} has open (you're busy)" reveal — collapsed by default.
 * Pulls host-only chips out of the primary chip strip per Decision 1+2 of
 * the bilateral+picker bundle (kill the visual collision between matched
 * and host-only). Tapping a chip in the reveal commits the slot the same
 * way the primary chips do — guests can override their conflict if they
 * want; the data layer does not stop them.
 *
 * `looseMutualCount` is the bilateral compute path's tally of "host wants
 * this, guest's calendar shows friction" — kept around for legacy callers
 * that pass it but the count we actually display is the chip count we
 * render below (host-bookable but not matched).
 */
function HostOnlyReveal({
  hostFirstName,
  amSlots,
  pmSlots,
  renderChip,
  looseMutualCount,
}: {
  hostFirstName?: string;
  amSlots: Slot[];
  pmSlots: Slot[];
  renderChip: (slot: Slot, key: string, variant: "matched" | "open" | "hostOnly") => React.ReactNode;
  looseMutualCount: number;
}) {
  const [expanded, setExpanded] = useState(false);
  void looseMutualCount; // legacy prop; chip-count below is the user-visible truth
  const total = amSlots.length + pmSlots.length;
  if (total === 0) return null;

  const label = `+ ${total} time${total === 1 ? "" : "s"} ${hostFirstName || "the host"} has open (you're busy)`;

  if (!expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="text-[11px] text-muted hover:text-primary italic pt-0.5 pl-[66px] transition cursor-pointer text-left"
      >
        {label} ▾
      </button>
    );
  }

  return (
    <div className="space-y-1.5 pt-0.5">
      <div className="flex items-center gap-2 pl-[66px]">
        <span className="text-[10px] uppercase tracking-wider text-muted font-medium">
          {hostFirstName || "Host"} open · you&rsquo;re busy
        </span>
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="text-[10px] text-muted hover:text-primary"
        >
          hide
        </button>
      </div>
      {amSlots.length > 0 && (
        <div className="grid grid-cols-[56px_1fr] gap-2.5 items-start">
          <div className="text-[10px] uppercase tracking-wider text-muted font-medium pt-1.5">Morning</div>
          <div className="flex flex-wrap gap-1">
            {amSlots.map((slot, si) => renderChip(slot, `ho-am-${si}`, "hostOnly"))}
          </div>
        </div>
      )}
      {pmSlots.length > 0 && (
        <div className="grid grid-cols-[56px_1fr] gap-2.5 items-start">
          <div className="text-[10px] uppercase tracking-wider text-muted font-medium pt-1.5">Afternoon</div>
          <div className="flex flex-wrap gap-1">
            {pmSlots.map((slot, si) => renderChip(slot, `ho-pm-${si}`, "hostOnly"))}
          </div>
        </div>
      )}
    </div>
  );
}

function WindowCards({
  windows,
  chipsForDay,
  dateStr,
  timezone,
  onSelectSlot,
  looseMutualCount,
  hostFirstName,
  hostImage, guestImage, hostSource, guestSource,
  durationMinutes,
  slotsForDay,
  inPlaceApplyMode,
}: {
  windows: WindowCard[];
  chipsForDay: BilateralChip[] | undefined;
  dateStr: string;
  timezone: string;
  onSelectSlot?: (msg: string, slot: { start: string; end: string }) => void;
  looseMutualCount: number;
  hostFirstName?: string;
  hostImage?: string | null;
  guestImage?: string | null;
  hostSource: string;
  guestSource: string;
  durationMinutes: number;
  slotsForDay: Slot[];
  inPlaceApplyMode?: boolean;
}) {
  const [revealMore, setRevealMore] = useState(false);

  if (durationMinutes <= 30) {
    return (
      <SlotChipRows
        windows={windows}
        slotsForDay={slotsForDay}
        chipsForDay={chipsForDay}
        dateStr={dateStr}
        timezone={timezone}
        onSelectSlot={onSelectSlot}
        looseMutualCount={looseMutualCount}
        hostFirstName={hostFirstName}
      />
    );
  }
  // For meetings longer than 30 min, route to the drag-to-pick timeline
  // (slider) until the bilateral chip + Detailed picker is extended to
  // cover up to 60 min — see WISHLIST entry "bilateral picker for 31–60
  // min meetings". The legacy WindowCardPicker path is unreached today;
  // kept in place pending that proposal.
  if (durationMinutes > 30) {
    return (
      <DragSlotPicker
        slotsForDay={slotsForDay}
        durationMinutes={durationMinutes}
        timezone={timezone}
        onSelectSlot={onSelectSlot}
        dateStr={dateStr}
        inPlaceApplyMode={inPlaceApplyMode}
      />
    );
  }

  if (windows.length === 0) {
    return <p className="text-xs text-muted">No available windows</p>;
  }
  const visible = revealMore ? windows : windows.slice(0, MAX_CARDS_PER_DAY);
  const hiddenCount = windows.length - visible.length;

  return (
    <div className="space-y-1.5">
      {visible.map((w, i) => {
        const matched = windowIsMatched(w, chipsForDay);
        const fmt = (iso: string) =>
          new Date(iso).toLocaleTimeString("en-US", {
            hour: "numeric", minute: "2-digit", timeZone: timezone,
          });
        const ariaLabel = `${w.name}, ${fmt(w.start)} to ${fmt(w.end)}${matched ? ", both calendars confirm" : ""}${w.isPick ? ", best pick" : ""}`;
        return (
          <button
            key={i}
            onClick={() =>
              onSelectSlot?.(
                formatWindowMessage(w, dateStr, timezone),
                { start: w.defaultStart, end: w.defaultEnd },
              )
            }
            disabled={!onSelectSlot}
            aria-label={ariaLabel}
            className={`
              w-full text-left px-3 py-2 rounded-lg border transition-all
              ${w.isPick
                ? "border-emerald-400/60 bg-emerald-950/30 hover:border-emerald-300"
                : "border-DEFAULT bg-surface-secondary hover:border-secondary"}
              ${onSelectSlot ? "cursor-pointer" : "cursor-default opacity-70"}
            `}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 min-w-0">
                {w.isPick && (
                  <span className="text-emerald-400 text-[11px] leading-none" aria-hidden="true">★</span>
                )}
                <span className="text-xs font-medium text-primary truncate">{w.name}</span>
              </div>
              {matched && (
                <BothBadge
                  hostImage={hostImage}
                  guestImage={guestImage}
                  hostSource={hostSource}
                  guestSource={guestSource}
                />
              )}
            </div>
            <div className="mt-0.5 text-[11px] text-secondary">
              {fmt(w.start)} – {fmt(w.end)}
            </div>
          </button>
        );
      })}
      {hiddenCount > 0 && !revealMore && (
        <button
          type="button"
          onClick={() => setRevealMore(true)}
          className="text-[11px] text-secondary hover:text-primary underline transition"
        >
          + {hiddenCount} more window{hiddenCount !== 1 ? "s" : ""}
        </button>
      )}
      {looseMutualCount > 0 && (
        <div className="text-[11px] text-muted italic pt-0.5">
          + {looseMutualCount} more window{looseMutualCount !== 1 ? "s" : ""}{" "}
          {hostFirstName || "they"} prefer{hostFirstName ? "s" : ""} but you&rsquo;re busy
        </div>
      )}
    </div>
  );
}

function LocationNotice({
  currentLocation,
  onClearLocation,
}: {
  currentLocation: { label: string; until?: string };
  onClearLocation?: () => void;
}) {
  return (
    <div className="mt-3 flex items-start gap-1.5 rounded-md bg-amber-50 border border-amber-200 dark:bg-amber-950/40 dark:border-amber-900/50 px-2 py-1.5">
      <span className="text-amber-400 text-[11px] mt-px">📍</span>
      <p className="text-[10px] text-amber-700 dark:text-amber-300 leading-tight flex-1">
        Currently in {currentLocation.label}
        {currentLocation.until ? ` until ${currentLocation.until}` : ""}.
        In-person meetings not available.
      </p>
      {onClearLocation && (
        <button
          onClick={onClearLocation}
          className="text-amber-600 hover:text-amber-400 text-[11px] leading-none mt-px ml-1 transition"
          title="Clear location"
        >
          ×
        </button>
      )}
    </div>
  );
}

// ─── Tab strip + Detailed timeline (PR-B2) ────────────────────────────────
//
// Two-tab picker for chip-style 30-min meetings: "Best matches" (today's
// chip+reveal render) and "Detailed" (stacked timeline). Tab persists in
// localStorage globally per user; mobile clamps to Best matches on first
// load only. Day and tab are independent axes — switching days preserves
// the tab; switching tabs preserves the day.

const PICKER_TAB_STORAGE_KEY = "agentenvoy.picker.tab";

function readStoredTab(): "best-matches" | "detailed" | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(PICKER_TAB_STORAGE_KEY);
    if (raw === "best-matches" || raw === "detailed") return raw;
  } catch {
    // localStorage may be blocked in sandboxed iframes — fall through.
  }
  return null;
}

function writeStoredTab(tab: "best-matches" | "detailed") {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PICKER_TAB_STORAGE_KEY, tab);
  } catch {
    // ignore
  }
}

function PickerTabs({
  matchedCount,
  bestMatches,
  detailed,
}: {
  matchedCount: number;
  bestMatches: React.ReactNode;
  detailed: React.ReactNode;
}) {
  // Tab state initialization per Decision B6:
  //   - localStorage unset → default to "best-matches" (matches both the
  //     desktop default and the mobile clamp; no separate viewport branch
  //     needed since they agree on the unset case).
  //   - First explicit user toggle writes the key; thereafter persists
  //     across loads on any viewport.
  const [tab, setTab] = useState<"best-matches" | "detailed">(
    () => readStoredTab() ?? "best-matches",
  );

  const onSelectTab = (next: "best-matches" | "detailed") => {
    setTab(next);
    writeStoredTab(next);
  };

  return (
    <div className="space-y-2">
      <div
        role="tablist"
        aria-label="Picker view"
        className="flex gap-1 p-0.5 rounded-md bg-surface-secondary border border-DEFAULT"
      >
        <button
          type="button"
          role="tab"
          aria-selected={tab === "best-matches"}
          onClick={() => onSelectTab("best-matches")}
          className={`flex-1 px-2 py-1 rounded text-[11px] font-medium transition ${
            tab === "best-matches"
              ? "bg-surface text-primary shadow-sm"
              : "text-muted hover:text-primary"
          }`}
        >
          Best matches
          <span
            className={`ml-1 inline-block px-1 rounded text-[9.5px] font-bold ${
              tab === "best-matches"
                ? "bg-emerald-500/20 text-emerald-400"
                : "bg-surface-tertiary text-muted"
            }`}
          >
            {matchedCount}
          </span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "detailed"}
          onClick={() => onSelectTab("detailed")}
          className={`flex-1 px-2 py-1 rounded text-[11px] font-medium transition ${
            tab === "detailed"
              ? "bg-surface text-primary shadow-sm"
              : "text-muted hover:text-primary"
          }`}
        >
          Detailed
        </button>
      </div>
      <div role="tabpanel">{tab === "best-matches" ? bestMatches : detailed}</div>
    </div>
  );
}

/**
 * Stacked timeline render for the Detailed tab. One row per half-hour;
 * three states (Both free / John open / You're busy) per the unified plan
 * §1.1. Reads `bilateralPayload.byDay[].matched / looseMutual / conflicts`
 * directly — single source of truth shared with the Best matches tab via
 * `slotsForDay` matching.
 *
 * Slot-level commit (per F4 from the picker review): tapping a "Both free"
 * row commits THAT half-hour's start, not the window's default-9:00.
 *
 * "John open" rows are non-interactive per F8 (no host conflict to surface;
 * the visual is the entire signal).
 */
function DetailedTimeline({
  payload,
  dateStr,
  timezone,
  hostFirstName,
  onSelectSlot,
  onSelectNextDay,
  slotsForDay,
}: {
  payload: import("@/lib/bilateral-availability").BilateralPayload;
  dateStr: string;
  timezone: string;
  hostFirstName?: string;
  onSelectSlot?: (msg: string, slot: { start: string; end: string }) => void;
  /** Caller-supplied "switch to next available day" jump for empty-state. */
  onSelectNextDay?: (nextDateStr: string) => void;
  slotsForDay: Slot[];
}) {
  const day = payload.byDay.find((d) => d.date === dateStr);

  // Compute the "next available day" — first day after dateStr with at
  // least one matched window. Surfaces in the empty-state CTAs below so
  // the guest doesn't have to back out and re-scan the day strip.
  const nextAvailable = (() => {
    const candidates = payload.byDay
      .filter((d) => d.date > dateStr && d.matched.length > 0)
      .sort((a, b) => a.date.localeCompare(b.date));
    return candidates[0];
  })();
  const renderNextDayLink = () => {
    if (!nextAvailable || !onSelectNextDay) return null;
    const label = new Date(nextAvailable.date + "T12:00:00").toLocaleDateString(
      "en-US",
      { weekday: "long", month: "short", day: "numeric" },
    );
    return (
      <button
        type="button"
        onClick={() => onSelectNextDay(nextAvailable.date)}
        className="text-[11px] text-emerald-400 hover:text-emerald-300 underline-offset-2 hover:underline transition pt-1 cursor-pointer"
      >
        Next available: {label} ({nextAvailable.matched.length} match
        {nextAvailable.matched.length === 1 ? "" : "es"}) →
      </button>
    );
  };

  if (!day) {
    return (
      <div className="space-y-1.5">
        <p className="text-xs text-muted">
          {hostFirstName || "Host"} has no availability this day.
        </p>
        {renderNextDayLink()}
      </div>
    );
  }
  if (!day.hasHostHours) {
    return (
      <div className="space-y-1.5">
        <p className="text-xs text-muted">
          Outside {hostFirstName || "the host"}&apos;s working hours.
        </p>
        {renderNextDayLink()}
      </div>
    );
  }

  // Build a unified set of half-hour rows: union of (host-bookable slots,
  // guest conflicts intersecting this day). Each row classified as one of:
  //   - "match"     — appears in day.matched (tappable)
  //   - "host"      — appears in day.looseMutual (read-only — host open)
  //   - "busy"      — covered by a guest conflict (read-only; title shown)
  //   - "off"       — outside host hours (rendered as muted spacer)
  // Sort by start time ascending.
  type Row = {
    start: string;
    end: string;
    state: "match" | "host" | "busy";
    label: string;
    title?: string;
    slot?: Slot;
  };

  const rows: Row[] = [];
  const fmt = (iso: string) =>
    new Date(iso).toLocaleTimeString("en-US", {
      hour: "numeric", minute: "2-digit", timeZone: timezone,
    });

  const matchedKeys = new Set(day.matched.map((m) => m.start));
  const looseKeys = new Set(day.looseMutual.map((l) => l.start));
  const slotByStart = new Map(slotsForDay.map((s) => [s.start, s]));

  for (const m of day.matched) {
    rows.push({
      start: m.start,
      end: m.end,
      state: "match",
      label: `Book ${fmt(m.start)}`,
      slot: slotByStart.get(m.start),
    });
  }
  for (const l of day.looseMutual) {
    rows.push({
      start: l.start,
      end: l.end,
      state: "host",
      label: `${hostFirstName || "Host"} open`,
    });
  }
  // Conflicts: surface as busy rows. Some may overlap with looseMutual
  // ranges — that's fine; the timeline shows both lanes through their own
  // rows. De-dupe identical starts where matched + conflict somehow
  // coincide (shouldn't happen — bilateral compute filters busy from
  // matched — but defensive for legacy snapshots).
  //
  // Continuation-row treatment (PR-B3 polish): a long conflict (e.g.
  // "Standup" 10–12) is one entry in `day.conflicts`; the picker may also
  // know about the same hours via half-hour `slotsForDay` cells. To keep
  // a long event from rendering as a single tall pill that disappears
  // visually inside one row, we expand multi-half-hour conflicts into
  // multiple rows — the first carrying the title, continuation rows
  // blank — so the timeline shape mirrors the actual blocked duration.
  for (const c of day.conflicts) {
    if (matchedKeys.has(c.start)) continue; // matched wins
    if (looseKeys.has(c.start)) continue;   // loose-mutual wins (privacy posture)
    const startMs = new Date(c.start).getTime();
    const endMs = new Date(c.end).getTime();
    const halfHourMs = 30 * 60 * 1000;
    // Walk in half-hour increments; first iteration carries the title,
    // continuation iterations get blank label (but rose fill).
    let cursor = startMs;
    let isFirst = true;
    while (cursor < endMs) {
      const cellEnd = Math.min(cursor + halfHourMs, endMs);
      rows.push({
        start: new Date(cursor).toISOString(),
        end: new Date(cellEnd).toISOString(),
        state: "busy",
        label: isFirst ? c.title ?? "Busy" : "",
        title: c.title,
      });
      cursor = cellEnd;
      isFirst = false;
    }
  }

  rows.sort((a, b) => a.start.localeCompare(b.start));

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap gap-2 text-[10px] text-muted px-0.5 pb-1">
        <span className="inline-flex items-center gap-1">
          <span className="inline-block w-2 h-2 rounded-sm bg-emerald-500/30 border border-emerald-400/60" />
          Both free
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block w-2 h-2 rounded-sm border border-dashed border-DEFAULT" />
          {hostFirstName || "Host"} open
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block w-2 h-2 rounded-sm bg-rose-500/15 border border-rose-400/40" />
          You&rsquo;re busy
        </span>
      </div>
      {rows.length === 0 && (
        <div className="space-y-1.5">
          <p className="text-xs text-muted">
            No times to show today.
          </p>
          {renderNextDayLink()}
        </div>
      )}
      {rows.map((row, idx) => (
        <DetailedRow
          // Include idx so continuation rows of the same conflict (sharing
          // start/state) get unique React keys.
          key={`${row.state}-${row.start}-${idx}`}
          row={row}
          dateStr={dateStr}
          timezone={timezone}
          onSelectSlot={onSelectSlot}
        />
      ))}
    </div>
  );
}

function DetailedRow({
  row,
  dateStr,
  timezone,
  onSelectSlot,
}: {
  row: {
    start: string;
    end: string;
    state: "match" | "host" | "busy";
    label: string;
    title?: string;
    slot?: Slot;
  };
  dateStr: string;
  timezone: string;
  onSelectSlot?: (msg: string, slot: { start: string; end: string }) => void;
}) {
  const time = new Date(row.start).toLocaleTimeString("en-US", {
    hour: "numeric", minute: "2-digit", timeZone: timezone,
  });
  const baseRowCls =
    "grid grid-cols-[42px_1fr] gap-2 items-center min-h-[28px]";
  const timeCls = "text-[10px] text-muted text-right tabular-nums";

  if (row.state === "match") {
    return (
      <div className={baseRowCls}>
        <div className={timeCls}>{time}</div>
        {/* PR-B3 polish: button is visually 28px tall but hit-area extends
            via vertical padding to ~44px so mobile taps land cleanly per
            iOS HIG / Material guidelines. The visual chip stays compact;
            the gutter absorbs the extra hit area. */}
        <button
          type="button"
          onClick={() =>
            onSelectSlot?.(
              row.slot
                ? formatSlotMessage(row.slot, dateStr, timezone)
                : `How about ${time}?`,
              { start: row.start, end: row.end },
            )
          }
          disabled={!onSelectSlot}
          aria-label={`${time}, both free, book`}
          className="relative -my-1.5 py-1.5 group"
        >
          <span className="block h-7 px-2.5 rounded-md text-left text-[11px] font-medium border border-emerald-400/60 bg-emerald-950/30 text-emerald-300 group-hover:border-emerald-300 transition cursor-pointer flex items-center justify-between">
            <span>{row.label}</span>
            <span className="text-[10px] text-emerald-400/70">›</span>
          </span>
        </button>
      </div>
    );
  }

  if (row.state === "host") {
    return (
      <div className={baseRowCls}>
        <div className={timeCls}>{time}</div>
        <div
          role="listitem"
          aria-label={`${time}, host open, you're busy`}
          className="h-7 px-2.5 rounded-md text-[11px] border border-dashed border-DEFAULT bg-transparent text-muted flex items-center"
        >
          {row.label}
        </div>
      </div>
    );
  }

  // busy — continuation rows (label === "") render with rose fill but no
  // text and no visual border-top so the band reads as a continuous block.
  const isContinuation = row.label === "";
  return (
    <div className={baseRowCls}>
      <div className={timeCls}>{isContinuation ? "" : time}</div>
      <div
        role="listitem"
        aria-label={`${time}, you're busy${row.title ? `, ${row.title}` : ""}`}
        className={`h-7 px-2.5 rounded-md text-[11px] bg-rose-500/10 text-rose-300 flex items-center ${
          isContinuation
            ? "border-x border-b border-rose-400/40 rounded-t-none -mt-1"
            : "border border-rose-400/40"
        }`}
      >
        {row.label}
      </div>
    </div>
  );
}

function TimezoneLabel({ timezone, onClick }: { timezone: string; onClick?: () => void }) {
  const city = timezone.split("/").pop()?.replace(/_/g, " ") || timezone;
  const abbr = new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "short" })
    .formatToParts(new Date())
    .find((p) => p.type === "timeZoneName")?.value || "";
  const label = `${city} (${abbr})`;

  if (onClick) {
    return (
      <button
        onClick={onClick}
        className="text-[10px] text-purple-400 hover:text-purple-300 transition text-left"
        title="Click to change timezone"
      >
        {label}
      </button>
    );
  }
  return <span className="text-[10px] text-muted">{label}</span>;
}

// ─── Week View ────────────────────────────────────────────────────────

// exported for picker/registry.ts only — do not import elsewhere
export function WeekView({
  slotsByDay,
  timezone,
  onSelectSlot,
  currentLocation,
  onClearLocation,
  onTimezoneClick,
  duration,
  headerSlot,
  footerSlot,
  bilateralByDay,
  bilateralPayload,
  hostFirstName,
  hostImage,
  guestImage,
  hostInitialSource,
  guestInitialSource,
  eventTitle,
  inPlaceApplyMode,
}: Omit<AvailabilityCalendarProps, "view">) {
  // F1: bin in the same tz we render in.
  assertBinningTz(timezone, timezone);

  // Compute windows per day up-front — drives both day-strip count and selected-day cards.
  const durationMinutes = duration ?? 30;
  const windowsByDay = useMemo(() => {
    const out: Record<string, WindowCard[]> = {};
    for (const [date, slots] of Object.entries(slotsByDay)) {
      out[date] = binSlotsIntoWindows(slots, { tz: timezone, durationMinutes });
    }
    return out;
  }, [slotsByDay, timezone, durationMinutes]);
  const now = new Date();
  const todayStr = toDateStr(now);
  const thisWeekStartTime = getWeekStart(now).getTime();

  const [weekOffset, setWeekOffset] = useState(0);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);

  // Auto-select today (or the first day with visible slots) once data is available.
  // Also jump the week view to the first available day — matters when a link has
  // a dateRange constraint (e.g. "next Monday") and all slots are weeks away.
  //
  // Auto-select today (or the first day with visible slots) once data is available.
  // Deliberately keyed on slotsByDay only: selectedDay/weekOffset are state the
  // effect itself sets (including them would undo user navigation on the next
  // render); todayStr/thisWeekStartTime derive from new Date() at render time
  // (including them would re-fire every render).
  useEffect(() => {
    if (selectedDay) return; // already selected — don't override manual choice
    const todaySlots = slotsByDay[todayStr] || [];
    if (todaySlots.some((s) => (s.score ?? 0) <= 1)) {
      setSelectedDay(todayStr);
      return;
    }
    // Fallback: first day anywhere in the slot data with visible slots
    const sorted = Object.keys(slotsByDay).sort();
    const first = sorted.find(
      (d) => d >= todayStr && (slotsByDay[d] || []).some((s) => (s.score ?? 0) <= 1),
    );
    if (!first) return;
    setSelectedDay(first);
    // Jump week view if the first available day isn't in the currently-displayed
    // week. Only auto-jump on initial load (weekOffset === 0); user navigation
    // sets weekOffset nonzero and we respect that.
    if (weekOffset === 0) {
      const firstTime = new Date(first + "T12:00:00").getTime();
      const daysDiff = Math.floor((firstTime - thisWeekStartTime) / (24 * 60 * 60 * 1000));
      const targetOffset = Math.floor(daysDiff / 7);
      if (targetOffset > 0) setWeekOffset(targetOffset);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slotsByDay]);

  // Compute the start of the displayed week
  const weekStartTime = useMemo(() => {
    const d = new Date(thisWeekStartTime);
    d.setDate(d.getDate() + weekOffset * 7);
    return d.getTime();
  }, [thisWeekStartTime, weekOffset]);

  // Build 7 day cells for the week
  const weekDays = useMemo(() => {
    const days: Array<{ dateStr: string; day: number; dayLabel: string; monthLabel: string }> = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(weekStartTime);
      d.setDate(d.getDate() + i);
      days.push({
        dateStr: toDateStr(d),
        day: d.getDate(),
        dayLabel: DAY_LABELS_SHORT[d.getDay()],
        monthLabel: d.toLocaleDateString("en-US", { month: "short" }),
      });
    }
    return days;
  }, [weekStartTime]);

  // Find the bounds of available data for prev/next limits
  const sortedDates = useMemo(() => Object.keys(slotsByDay).sort(), [slotsByDay]);
  const minDate = sortedDates[0] || todayStr;
  const maxDate = sortedDates[sortedDates.length - 1] || todayStr;

  const canGoPrev = weekDays[0].dateStr > minDate && weekOffset > 0;
  const canGoNext = weekDays[6].dateStr < maxDate;

  // 5-day mode: when no weekend slots exist across the entire session, hide
  // Sat/Sun to reclaim horizontal space for the weekday chips.
  const hasWeekendSlots = useMemo(() => {
    return Object.entries(slotsByDay).some(([dateStr, slots]) => {
      const dow = new Date(dateStr + "T12:00:00").getDay();
      return (dow === 0 || dow === 6) && slots.some((s) => (s.score ?? 0) <= 1);
    });
  }, [slotsByDay]);
  const displayDays = hasWeekendSlots
    ? weekDays
    : weekDays.filter((wd) => {
        const dow = new Date(wd.dateStr + "T12:00:00").getDay();
        return dow !== 0 && dow !== 6;
      });

  // When the user navigates weeks, keep the chips section open by selecting the
  // first day in the new week that has windows. Falls back to leaving the prior
  // selectedDay alone if no day in the new week has anything to show. Prior
  // behavior cleared selectedDay, which collapsed the chips view and forced
  // the user to click a day every week change (bug reported 2026-04-23).
  const navigateWeek = (delta: number) => {
    const newOffset = weekOffset + delta;
    setWeekOffset(newOffset);
    // Compute the new week's days inline (weekDays memo hasn't updated yet)
    const newWeekStart = new Date(thisWeekStartTime);
    newWeekStart.setDate(newWeekStart.getDate() + newOffset * 7);
    for (let i = 0; i < 7; i++) {
      const d = new Date(newWeekStart);
      d.setDate(d.getDate() + i);
      const dateStr = toDateStr(d);
      const windows = windowsByDay[dateStr];
      if (windows && windows.length > 0) {
        setSelectedDay(dateStr);
        return;
      }
    }
    // No windows in the new week — leave selectedDay alone so chips stay open
    // for the prior selection if/when the user navigates back.
  };

  // Week label: "Apr 12 – 18, 2026"
  const weekLabel = (() => {
    const first = weekDays[0];
    const last = weekDays[6];
    const firstDate = new Date(first.dateStr + "T12:00:00");
    const lastDate = new Date(last.dateStr + "T12:00:00");
    const sameMonth = firstDate.getMonth() === lastDate.getMonth();
    if (sameMonth) {
      return `${first.monthLabel} ${first.day} – ${last.day}, ${firstDate.getFullYear()}`;
    }
    return `${first.monthLabel} ${first.day} – ${last.monthLabel} ${last.day}`;
  })();

  const hasMatches = bilateralByDay
    ? Object.values(bilateralByDay).some((chips) => chips.some((c) => c.color === "both"))
    : false;

  return (
    /* px-4 py-3 — gutter so day chips, meeting label, slot pills, and the
       timezone footer aren't flush against the surrounding card edges. */
    <div className="px-4 py-3">
      {/* Match banner — shown when bilateral overlap found and eventTitle provided */}
      {hasMatches && eventTitle && <MatchHeader eventTitle={eventTitle} />}

      {/* Header slot — e.g., inline CTA chip for calendar connect */}
      {headerSlot && <div className="mb-3 pt-1">{headerSlot}</div>}

      {/* Week navigation header */}
      <div className="flex items-center justify-between mb-2">
        <button
          onClick={() => navigateWeek(-1)}
          className={`p-2 rounded-lg hover:bg-surface-secondary transition ${!canGoPrev ? "opacity-25 cursor-default" : "hover:opacity-80"}`}
          disabled={!canGoPrev}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <span className="text-xs font-medium text-primary">{weekLabel}</span>
        <button
          onClick={() => navigateWeek(1)}
          className={`p-2 rounded-lg hover:bg-surface-secondary transition ${!canGoNext ? "opacity-25 cursor-default" : "hover:opacity-80"}`}
          disabled={!canGoNext}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
      </div>

      {/* Week strip — 5 or 7 day cells depending on weekend availability */}
      <div className={`grid gap-1 ${hasWeekendSlots ? "grid-cols-7" : "grid-cols-5"}`}>
        {displayDays.map((wd) => {
          const daySlots = slotsByDay[wd.dateStr] || [];
          const dayWindows = windowsByDay[wd.dateStr] || [];
          const isPast = wd.dateStr < todayStr;
          const isToday = wd.dateStr === todayStr;
          const isSelected = wd.dateStr === selectedDay;
          const colorClass = getSlotColor(daySlots, isPast);
          const hasWindows = !isPast && dayWindows.length > 0;

          return (
            <button
              key={wd.dateStr}
              onClick={() => hasWindows && setSelectedDay(wd.dateStr)}
              disabled={!hasWindows}
              className={`
                flex flex-col items-center rounded-lg py-1.5 px-0.5 transition-all
                ${colorClass}
                ${isToday ? "ring-1 ring-indigo-400" : ""}
                ${isSelected ? "ring-2 ring-indigo-600" : ""}
                ${hasWindows ? "hover:ring-1 hover:ring-secondary cursor-pointer" : "cursor-default"}
              `}
            >
              <span className="text-[9px] font-medium uppercase leading-none">{wd.dayLabel}</span>
              <span className="text-sm font-semibold leading-tight">{wd.day}</span>
              {hasWindows && (
                <span className="text-[8px] leading-none mt-0.5 opacity-70">
                  {dayWindows.length} window{dayWindows.length !== 1 ? "s" : ""}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Selected day — tab strip + content */}
      {selectedDay && (() => {
        const selectedWindows = windowsByDay[selectedDay] || [];
        const chipsForDay = bilateralByDay?.[selectedDay];
        const looseMutualCount = chipsForDay ? chipsForDay.filter((c) => c.color === "one").length : 0;
        // Tab strip surfaces only when bilateral data is present AND the
        // meeting is short (chip-style picker). Long-duration meetings use
        // DragSlotPicker; Detailed tab there is future work per the unified
        // plan §7.
        const tabsAvailable =
          !!bilateralPayload?.available && durationMinutes <= 30;
        // Per-day match count for the tab pill (Decision 4 / Placement B).
        const dayPayload = bilateralPayload?.byDay.find(
          (d) => d.date === selectedDay,
        );
        const matchedCount = dayPayload?.matched.length ?? 0;
        return (
          <div className="mt-2.5 space-y-1.5">
            <div className="text-[10px] font-medium text-muted">
              {new Date(selectedDay + "T12:00:00").toLocaleDateString("en-US", {
                weekday: "long",
                month: "short",
                day: "numeric",
              })}
              , {formatDurationCompact(duration)} meeting
            </div>
            {tabsAvailable ? (
              <PickerTabs
                matchedCount={matchedCount}
                bestMatches={
                  <WindowCards
                    windows={selectedWindows}
                    chipsForDay={chipsForDay}
                    dateStr={selectedDay}
                    timezone={timezone}
                    onSelectSlot={onSelectSlot}
                    looseMutualCount={looseMutualCount}
                    hostFirstName={hostFirstName}
                    hostImage={hostImage}
                    guestImage={guestImage}
                    hostSource={hostInitialSource || hostFirstName || "Host"}
                    guestSource={guestInitialSource || "Guest"}
                    durationMinutes={durationMinutes}
                    slotsForDay={slotsByDay[selectedDay] || []}
                    inPlaceApplyMode={inPlaceApplyMode}
                  />
                }
                detailed={
                  <DetailedTimeline
                    payload={bilateralPayload!}
                    dateStr={selectedDay}
                    timezone={timezone}
                    hostFirstName={hostFirstName}
                    onSelectSlot={onSelectSlot}
                    onSelectNextDay={(next) => setSelectedDay(next)}
                    slotsForDay={slotsByDay[selectedDay] || []}
                  />
                }
              />
            ) : (
              <WindowCards
                windows={selectedWindows}
                chipsForDay={chipsForDay}
                dateStr={selectedDay}
                timezone={timezone}
                onSelectSlot={onSelectSlot}
                looseMutualCount={looseMutualCount}
                hostFirstName={hostFirstName}
                hostImage={hostImage}
                guestImage={guestImage}
                hostSource={hostInitialSource || hostFirstName || "Host"}
                guestSource={guestInitialSource || "Guest"}
                durationMinutes={durationMinutes}
                slotsForDay={slotsByDay[selectedDay] || []}
                inPlaceApplyMode={inPlaceApplyMode}
              />
            )}
          </div>
        );
      })()}

      {/* Location notice */}
      {currentLocation && (
        <LocationNotice currentLocation={currentLocation} onClearLocation={onClearLocation} />
      )}

      {/* Footer: timezone picker (if provided) replaces the static label */}
      <div className="mt-3 pt-3 border-t border-DEFAULT">
        {footerSlot ?? <TimezoneLabel timezone={timezone} onClick={onTimezoneClick} />}
      </div>
    </div>
  );
}

// ─── Month View (original) ────────────────────────────────────────────

// exported for picker/registry.ts only — do not import elsewhere
export function MonthView({
  slotsByDay,
  timezone,
  onSelectSlot,
  currentLocation,
  onClearLocation,
  onTimezoneClick,
  duration,
  minDuration,
  headerSlot,
  footerSlot,
}: Omit<AvailabilityCalendarProps, "view">) {
  const [viewMonth, setViewMonth] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const [selectedDay, setSelectedDay] = useState<string | null>(null);

  const year = viewMonth.getFullYear();
  const month = viewMonth.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstDayOfWeek = new Date(year, month, 1).getDay();

  const now = new Date();
  const todayStr = toDateStr(now);

  // Auto-select today (or the first day with visible slots) once data is available.
  // Also jump the month view to the month containing the first available day —
  // matters when a link has a dateRange constraint (e.g. "next Monday") and all
  // slots are in a different month than today.
  //
  // Deliberately keyed on slotsByDay only: selectedDay/viewMonth are state the
  // effect itself sets (including them would undo user navigation on the next
  // render); now/todayStr derive from new Date() at render time (including them
  // would re-fire every render).
  useEffect(() => {
    if (selectedDay) return; // already selected — don't override manual choice
    const todaySlots = slotsByDay[todayStr] || [];
    if (todaySlots.some((s) => (s.score ?? 0) <= 1)) {
      setSelectedDay(todayStr);
      return;
    }
    const sorted = Object.keys(slotsByDay).sort();
    const first = sorted.find(
      (d) => d >= todayStr && (slotsByDay[d] || []).some((s) => (s.score ?? 0) <= 1),
    );
    if (!first) return;
    setSelectedDay(first);
    // Jump month view if first available day is in a different month. Only auto-jump
    // on initial load (viewMonth still equals current month); respect user nav after.
    const firstDate = new Date(first + "T12:00:00");
    const nowMonth = now.getMonth();
    const nowYear = now.getFullYear();
    const viewingCurrentMonth = viewMonth.getMonth() === nowMonth && viewMonth.getFullYear() === nowYear;
    if (viewingCurrentMonth && (firstDate.getFullYear() !== nowYear || firstDate.getMonth() !== nowMonth)) {
      setViewMonth(new Date(firstDate.getFullYear(), firstDate.getMonth(), 1));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slotsByDay]);

  const cells: Array<{ day: number; dateStr: string } | null> = [];
  for (let i = 0; i < firstDayOfWeek; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    cells.push({ day: d, dateStr });
  }

  const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const nextMonthStart = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const canGoPrev = viewMonth > currentMonthStart;
  const canGoNext = viewMonth < nextMonthStart;

  const selectedSlots = selectedDay ? slotsByDay[selectedDay] || [] : [];

  return (
    <div>
      {/* Header slot — e.g., inline CTA chip for calendar connect */}
      {headerSlot && <div className="mb-3">{headerSlot}</div>}

      {/* Month header */}
      <div className="flex items-center justify-between mb-2">
        <button
          onClick={() => setViewMonth(new Date(year, month - 1, 1))}
          className={`p-1 rounded hover:bg-surface-secondary transition ${!canGoPrev ? "opacity-30 cursor-default" : ""}`}
          disabled={!canGoPrev}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <span className="text-xs font-medium text-primary">
          {viewMonth.toLocaleDateString("en-US", { month: "long", year: "numeric" })}
        </span>
        <button
          onClick={() => setViewMonth(new Date(year, month + 1, 1))}
          className={`p-1 rounded hover:bg-surface-secondary transition ${!canGoNext ? "opacity-30 cursor-default" : ""}`}
          disabled={!canGoNext}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
      </div>

      {/* Day headers */}
      <div className="grid grid-cols-7 gap-1.5 mb-1">
        {DAY_HEADERS.map((d) => (
          <div key={d} className="text-[11px] text-muted text-center font-medium">
            {d}
          </div>
        ))}
      </div>

      {/* Day grid */}
      <div className="grid grid-cols-7 gap-1.5">
        {cells.map((cell, i) => {
          if (!cell) return <div key={`empty-${i}`} />;
          const daySlots = slotsByDay[cell.dateStr] || [];
          const visibleSlots = daySlots.filter((s) => (s.score ?? 0) <= 1);
          const isPast = cell.dateStr < todayStr;
          const isToday = cell.dateStr === todayStr;
          const isSelected = cell.dateStr === selectedDay;
          const colorClass = getSlotColor(daySlots, isPast);

          return (
            <button
              key={cell.dateStr}
              onClick={() => !isPast && visibleSlots.length > 0 && setSelectedDay(cell.dateStr)}
              disabled={isPast || visibleSlots.length === 0}
              className={`
                aspect-square rounded-lg text-sm font-medium flex items-center justify-center transition-all
                ${colorClass}
                ${isToday ? "ring-1 ring-indigo-400" : ""}
                ${isSelected ? "ring-2 ring-indigo-600" : ""}
                ${!isPast && visibleSlots.length > 0 ? "hover:ring-1 hover:ring-secondary cursor-pointer" : "cursor-default"}
              `}
            >
              {cell.day}
            </button>
          );
        })}
      </div>

      {/* Selected day time slots */}
      {selectedDay && (
        <div className="mt-3 space-y-1.5">
          <div className="text-[10px] font-medium text-muted">
            Start times on{" "}
            {new Date(selectedDay + "T12:00:00").toLocaleDateString("en-US", {
              weekday: "long",
              month: "short",
              day: "numeric",
            })}
            , {formatDurationCompact(duration)} meeting
          </div>
          <SlotPills
            slots={selectedSlots}
            dateStr={selectedDay}
            timezone={timezone}
            onSelectSlot={onSelectSlot}
            duration={duration}
            minDuration={minDuration}
          />
        </div>
      )}

      {/* Location notice */}
      {currentLocation && (
        <LocationNotice currentLocation={currentLocation} onClearLocation={onClearLocation} />
      )}

      {/* Footer: timezone picker (if provided) replaces the static label */}
      <div className="mt-3 pt-3 border-t border-DEFAULT">
        {footerSlot ?? <TimezoneLabel timezone={timezone} onClick={onTimezoneClick} />}
      </div>
    </div>
  );
}

// ─── Date-mode picker ─────────────────────────────────────────────────
// Renders the same calendar grid as MonthView but clicking a day calls
// onSelectDate instead of revealing time-slot pills. Used for multi-day
// events (duration ≥ 24h) where the guest picks a start date, not a time.

// exported for picker/registry.ts only — do not import elsewhere
export function DatePickerView({
  slotsByDay,
  timezone: _timezone,
  onSelectDate,
  headerSlot,
  footerSlot,
  onTimezoneClick,
}: Omit<AvailabilityCalendarProps, "view" | "schedulingMode">) {
  const [viewMonth, setViewMonth] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });

  const now = new Date();
  const todayStr = toDateStr(now);

  // Jump to the first month that has viable dates.
  useEffect(() => {
    const sorted = Object.keys(slotsByDay).sort();
    const first = sorted.find((d) => d >= todayStr);
    if (!first) return;
    const firstDate = new Date(first + "T12:00:00");
    const nowMonth = now.getMonth();
    const nowYear = now.getFullYear();
    if (firstDate.getFullYear() !== nowYear || firstDate.getMonth() !== nowMonth) {
      setViewMonth(new Date(firstDate.getFullYear(), firstDate.getMonth(), 1));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slotsByDay]);

  const year = viewMonth.getFullYear();
  const month = viewMonth.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstDayOfWeek = new Date(year, month, 1).getDay();

  const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const canGoPrev = viewMonth > currentMonthStart;

  const cells: Array<{ day: number; dateStr: string } | null> = [];
  for (let i = 0; i < firstDayOfWeek; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    cells.push({ day: d, dateStr });
  }

  return (
    <div>
      {headerSlot && <div className="mb-3">{headerSlot}</div>}

      <div className="flex items-center justify-between mb-2">
        <button
          onClick={() => setViewMonth(new Date(year, month - 1, 1))}
          className={`p-1 rounded hover:bg-surface-secondary transition ${!canGoPrev ? "opacity-30 cursor-default" : ""}`}
          disabled={!canGoPrev}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <span className="text-xs font-medium text-primary">
          {viewMonth.toLocaleDateString("en-US", { month: "long", year: "numeric" })}
        </span>
        <button
          onClick={() => setViewMonth(new Date(year, month + 1, 1))}
          className="p-1 rounded hover:bg-surface-secondary transition"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
      </div>

      <div className="grid grid-cols-7 gap-1.5 mb-1">
        {DAY_HEADERS.map((d) => (
          <div key={d} className="text-[11px] text-muted text-center font-medium">{d}</div>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-1.5">
        {cells.map((cell, i) => {
          if (!cell) return <div key={`empty-${i}`} />;
          const isPast = cell.dateStr < todayStr;
          const hasSlots = !!slotsByDay[cell.dateStr]?.length;
          const isToday = cell.dateStr === todayStr;
          const available = !isPast && hasSlots;

          return (
            <button
              key={cell.dateStr}
              onClick={() => available && onSelectDate?.(cell.dateStr)}
              disabled={!available}
              className={`
                aspect-square rounded-lg text-sm font-medium flex items-center justify-center transition-all
                ${available
                  ? "bg-green-500/15 text-green-300 hover:ring-1 hover:ring-green-400 cursor-pointer"
                  : "bg-zinc-200 dark:bg-zinc-900 text-zinc-400 dark:text-zinc-700 cursor-default"}
                ${isToday ? "ring-1 ring-indigo-500" : ""}
              `}
            >
              {cell.day}
            </button>
          );
        })}
      </div>

      <div className="mt-2 text-[11px] text-muted text-center">Tap a date to confirm</div>

      <div className="mt-3 pt-3 border-t border-DEFAULT">
        {footerSlot ?? <TimezoneLabel timezone={_timezone} onClick={onTimezoneClick} />}
      </div>
    </div>
  );
}

// ─── Main export ──────────────────────────────────────────────────────

export function AvailabilityCalendar(props: AvailabilityCalendarProps) {
  const { view = "month", schedulingMode = "time", ...rest } = props;
  const variant = selectPickerVariant({ view, schedulingMode });
  const Component = variant.Component;
  return <Component {...rest} />;
}
