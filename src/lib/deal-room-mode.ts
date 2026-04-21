/**
 * Deal-room widget mode derivation — Stage 2 of proposal
 * `2026-04-21_deal-room-widget-state-machine-and-agent-dialog-clarity`.
 *
 * Three derived widget modes: `offer` / `negotiate` / `confirmed`. Mode is
 * NOT stored — it's a pure function of session state, available slots, a
 * local "guest asked for more options" flag, and host intent.steering.
 *
 * This module is pure (no I/O, no React, no Prisma). Callers memoize on
 * the input set described in §3.1 of the proposal:
 *   (sessionStatus, availableSlots, guestRequestedMoreOptions,
 *    link.intent?.steering, viewerTimezone).
 *
 * See also: `applyEventOverrides` in `src/lib/scoring.ts` for the server-
 * side path that produces the offered slot set this module reads. The
 * N2-fold server-side slot-still-offered check in `/api/negotiate/confirm`
 * re-derives the same set to enforce that a confirmed slot is still on
 * offer at commit time.
 */

/** Minimal slot shape — matches what the widget already holds. */
export interface ModeSlot {
  /** ISO datetime. */
  start: string;
}

/** Minimal session shape — mode derivation only reads these fields. */
export interface ModeSession {
  status: string;
  /**
   * Picker-authoritative per PR #33 (2026-04-21 tz UX). When present this
   * wins over the legacy `guestTimezone` seed — see B2 fold in the decided
   * proposal.
   */
  viewerTimezone?: string | null;
  /**
   * Legacy first-write-wins seed. Read only when viewerTimezone is unset.
   */
  guestTimezone?: string | null;
}

/** Minimal link shape — mode derivation reads intent.steering. */
export interface ModeLink {
  intent?: {
    steering?: "open" | "soft" | "narrow" | "exclusive" | string | null;
  } | null;
}

/** Widget-local state feeds. */
export interface ModeWidgetState {
  availableSlots: ModeSlot[];
  guestRequestedMoreOptions: boolean;
  link: ModeLink;
}

export type DealRoomMode = "offer" | "negotiate" | "confirmed";

/**
 * Resolve a calendar day key "YYYY-MM-DD" for an ISO datetime in `tz`.
 * Uses `Intl.DateTimeFormat` with `en-CA` locale, which is the canonical
 * day-key format across the codebase (see slots/route.ts, greeting
 * template).
 */
function localDayKey(iso: string, tz: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/**
 * Do two ISO datetimes fall on the same local calendar day in `tz`?
 *
 * Covers the tz-boundary case explicitly called out in §3.1: Tue 11pm PT
 * + Wed 1am PT read as different local days in PT even though they're
 * less than 3h apart. This is the whole point of evaluating in the
 * guest's timezone rather than UTC or the host's tz.
 */
export function sameLocalDay(iso1: string, iso2: string, tz: string): boolean {
  const a = localDayKey(iso1, tz);
  const b = localDayKey(iso2, tz);
  return a !== "" && a === b;
}

/**
 * Fallback when nothing better is known. Browser-detected IANA; UTC if
 * detection fails. Callers on the server should pass an explicit tz
 * instead of relying on this.
 */
function deriveFromBrowser(): string {
  if (typeof Intl !== "undefined") {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch {
      // fall through
    }
  }
  return "UTC";
}

/**
 * Pure mode derivation — see §3.1 of the proposal.
 *
 * Logic:
 *   - `agreed` session status → `confirmed` (terminal).
 *   - Guest explicitly asked for more options → `negotiate`.
 *   - host intent.steering === "exclusive" with a single slot → `offer`.
 *   - ≥1 and ≤3 slots, all on the same local day in the guest's tz →
 *     `offer`.
 *   - Otherwise → `negotiate`.
 *
 * B2 fold: guestTz fallback chain reads viewerTimezone first (picker-
 * authoritative per PR #33), then the legacy guestTimezone seed, then
 * browser detection. Reading a legacy column while viewerTimezone is set
 * is a silent correctness bug — the same slot pair can flip between
 * "same day" and "different days" depending on which tz source is used.
 *
 * N7 fold: pre-PR-58 links have `intent.steering` undefined. Optional
 * chaining handles that cleanly — `exclusiveFromHost` becomes false and
 * eligibility falls through to the slot-count/same-day rule.
 */
export function deriveMode(
  session: ModeSession,
  widget: ModeWidgetState,
): DealRoomMode {
  if (session.status === "agreed") return "confirmed";
  if (widget.guestRequestedMoreOptions) return "negotiate";

  const guestTz =
    session.viewerTimezone ?? session.guestTimezone ?? deriveFromBrowser();

  const slots = widget.availableSlots;
  if (slots.length === 0) return "negotiate";

  const steering = widget.link.intent?.steering;
  const exclusiveFromHost = steering === "exclusive" && slots.length === 1;
  if (exclusiveFromHost) return "offer";

  const smallList = slots.length >= 1 && slots.length <= 3;
  if (!smallList) return "negotiate";

  const sameDay = slots.every((s) =>
    sameLocalDay(s.start, slots[0].start, guestTz),
  );
  return sameDay ? "offer" : "negotiate";
}
