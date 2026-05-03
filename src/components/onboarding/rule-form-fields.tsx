"use client";

/**
 * Shared form fields for the Bookable Link create flow's confirmation UI.
 *
 * Used by both the desktop in-thread card (`rule-confirm-card.tsx`) and
 * the mobile bottom sheet (`rule-confirm-sheet.tsx`). Identical field
 * shape and editing behavior — only the surrounding chrome differs.
 *
 * Vocabulary: this component renders a **Bookable Link** confirmation
 * (capitalized — feature name). The lowercase phrase "drop-in hours" only
 * appears as user-facing flavor when describing what the host told Envoy.
 *
 * "Business hours" is a separate, unrelated concept (`businessHoursStart`
 * / `businessHoursEnd` — the host's daily window) and is NOT touched here.
 */

import { useEffect, useMemo, useState } from "react";

/** @deprecated use BookableLinkProposal. Alias kept for import compatibility. */
export type OfficeHoursProposal = BookableLinkProposal;

export interface BookableLinkProposal {
  /** The original utterance that produced this proposal — shown as quoted
   *  context in the card/sheet header so the host sees what Envoy parsed. */
  originalText: string;
  /** Display title — host-facing name of the link (e.g. "Guitar students"). */
  title: string;
  /** Meeting format. */
  format: "video" | "phone" | "in-person";
  /** Slot length in minutes (15 / 30 / 45 / 60 / 90). */
  durationMinutes: number;
  /** Days the window is offerable. 0=Sun..6=Sat. */
  daysOfWeek: number[];
  /** Window start, "HH:MM" 24h. */
  timeStart: string;
  /** Window end, "HH:MM" 24h. */
  timeEnd: string;
  /** ISO date — when the rule starts being honored. Defaults to today. */
  effectiveDate?: string;
  /** ISO date — optional end. Empty string / undefined = no end. */
  expiryDate?: string;
  /** Per-rule guest-flexibility toggles. Both default false: guests can't
   *  change the meeting unless the host opts in. Reusable-link guest-picks
   *  proposal, decided 2026-04-28. */
  guestPicks?: {
    format?: boolean;
    duration?: boolean;
  };
}

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const FORMAT_OPTIONS: Array<{ value: BookableLinkProposal["format"]; label: string }> = [
  { value: "video", label: "Video" },
  { value: "phone", label: "Phone" },
  { value: "in-person", label: "In-person" },
];
const DURATION_OPTIONS = [15, 30, 45, 60, 90];

/** Format a 24h "HH:MM" string as "h:MM AM/PM" for display in the time inputs. */
function formatTime12(hhmm: string): string {
  const [h, m] = hhmm.split(":").map((s) => Number(s));
  if (!Number.isFinite(h) || !Number.isFinite(m)) return hhmm;
  const suffix = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const mm = String(m).padStart(2, "0");
  return `${h12}:${mm} ${suffix}`;
}

/** Parse "h:MM AM/PM" or "HH:MM" back to canonical "HH:MM" 24h.
 *  Returns null when the input doesn't parse — caller surfaces an error. */
function parseTime12(input: string): string | null {
  const trimmed = input.trim().toUpperCase();
  // 24h "HH:MM"
  const m24 = trimmed.match(/^(\d{1,2}):(\d{2})$/);
  if (m24) {
    const h = Number(m24[1]);
    const m = Number(m24[2]);
    if (h >= 0 && h <= 23 && m >= 0 && m <= 59) {
      return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    }
  }
  // 12h "h:MM AM/PM"
  const m12 = trimmed.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/);
  if (m12) {
    let h = Number(m12[1]);
    const m = Number(m12[2]);
    const suffix = m12[3];
    if (h >= 1 && h <= 12 && m >= 0 && m <= 59) {
      if (suffix === "PM" && h !== 12) h += 12;
      if (suffix === "AM" && h === 12) h = 0;
      return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    }
  }
  return null;
}

/** Format an ISO date "YYYY-MM-DD" as "MM/DD/YYYY". */
function formatDateUS(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return iso;
  return `${m[2]}/${m[3]}/${m[1]}`;
}

interface RuleFormFieldsProps {
  /** Mutable proposal — caller owns the state, this component renders + edits it. */
  value: BookableLinkProposal;
  /** Fired on any field change. */
  onChange: (next: BookableLinkProposal) => void;
  /** When true, fields render disabled (during submit). */
  disabled?: boolean;
}

export function RuleFormFields({ value, onChange, disabled }: RuleFormFieldsProps) {
  // Local time string state so the user can type freely; we only push back
  // to `onChange` when the parse succeeds.
  const [timeStartStr, setTimeStartStr] = useState(formatTime12(value.timeStart));
  const [timeEndStr, setTimeEndStr] = useState(formatTime12(value.timeEnd));

  // Re-sync local strings if the caller resets the proposal (e.g. on dismiss).
  useEffect(() => {
    setTimeStartStr(formatTime12(value.timeStart));
    setTimeEndStr(formatTime12(value.timeEnd));
  }, [value.timeStart, value.timeEnd]);

  function toggleDay(d: number) {
    const has = value.daysOfWeek.includes(d);
    const next = has
      ? value.daysOfWeek.filter((x) => x !== d)
      : [...value.daysOfWeek, d].sort((a, b) => a - b);
    onChange({ ...value, daysOfWeek: next });
  }

  function commitTimeStart() {
    const parsed = parseTime12(timeStartStr);
    if (parsed) onChange({ ...value, timeStart: parsed });
    else setTimeStartStr(formatTime12(value.timeStart)); // revert on bad input
  }
  function commitTimeEnd() {
    const parsed = parseTime12(timeEndStr);
    if (parsed) onChange({ ...value, timeEnd: parsed });
    else setTimeEndStr(formatTime12(value.timeEnd));
  }

  const effectiveDateStr = useMemo(
    () => (value.effectiveDate ? formatDateUS(value.effectiveDate) : ""),
    [value.effectiveDate],
  );

  return (
    <>
      {value.originalText && (
        <div className="text-[11.5px] italic text-foreground/60 border-l-2 border-foreground/15 pl-2 py-0.5 leading-snug">
          &ldquo;{value.originalText}&rdquo;
        </div>
      )}

      {/* Type — display-only, always Bookable Link */}
      <div className="grid grid-cols-[60px_1fr] items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-foreground/50">
          Type
        </span>
        <span className="text-xs text-foreground">Bookable Link</span>
      </div>

      {/* Title */}
      <div className="grid grid-cols-[60px_1fr] items-center gap-2">
        <label className="text-[10px] font-semibold uppercase tracking-wide text-foreground/50">
          Title
        </label>
        <input
          className="w-full rounded-md bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 px-2.5 py-1.5 text-[11.5px] text-foreground outline-none focus:border-indigo-500"
          value={value.title}
          onChange={(e) => onChange({ ...value, title: e.target.value })}
          disabled={disabled}
        />
      </div>

      {/* Format */}
      <div className="grid grid-cols-[60px_1fr] items-center gap-2">
        <label className="text-[10px] font-semibold uppercase tracking-wide text-foreground/50">
          Format
        </label>
        <select
          className="w-full rounded-md bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 px-2.5 py-1.5 text-[11.5px] text-foreground outline-none focus:border-indigo-500"
          value={value.format}
          onChange={(e) =>
            onChange({ ...value, format: e.target.value as BookableLinkProposal["format"] })
          }
          disabled={disabled}
        >
          {FORMAT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      {/* Duration */}
      <div className="grid grid-cols-[60px_1fr] items-center gap-2">
        <label className="text-[10px] font-semibold uppercase tracking-wide text-foreground/50">
          Duration
        </label>
        <select
          className="w-full rounded-md bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 px-2.5 py-1.5 text-[11.5px] text-foreground outline-none focus:border-indigo-500"
          value={value.durationMinutes}
          onChange={(e) =>
            onChange({ ...value, durationMinutes: Number(e.target.value) })
          }
          disabled={disabled}
        >
          {DURATION_OPTIONS.map((d) => (
            <option key={d} value={d}>
              {d} min
            </option>
          ))}
        </select>
      </div>

      {/* Guest flexibility — two toggles, default off. Reusable-link guest-picks
          proposal, decided 2026-04-28. Hidden when `disabled` matches the rest
          of the form's disabled state. */}
      <div className="grid grid-cols-[60px_1fr] items-start gap-2 pt-1">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-foreground/50 mt-1">
          Guests
        </span>
        <div className="flex flex-col gap-1.5">
          <label className="flex items-center gap-2 cursor-pointer text-[11.5px] text-foreground/85">
            <input
              type="checkbox"
              className="rounded border-black/20 dark:border-white/20 text-indigo-600 focus:ring-indigo-500 focus:ring-offset-0 h-3.5 w-3.5"
              checked={!!value.guestPicks?.format}
              onChange={(e) =>
                onChange({
                  ...value,
                  guestPicks: { ...value.guestPicks, format: e.target.checked },
                })
              }
              disabled={disabled}
            />
            Let guests change format
            <span className="text-foreground/40 text-[10.5px]">(phone / video / in-person)</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer text-[11.5px] text-foreground/85">
            <input
              type="checkbox"
              className="rounded border-black/20 dark:border-white/20 text-indigo-600 focus:ring-indigo-500 focus:ring-offset-0 h-3.5 w-3.5"
              checked={!!value.guestPicks?.duration}
              onChange={(e) =>
                onChange({
                  ...value,
                  guestPicks: { ...value.guestPicks, duration: e.target.checked },
                })
              }
              disabled={disabled}
            />
            Let guests change duration
            <span className="text-foreground/40 text-[10.5px]">(longer or shorter slot)</span>
          </label>
        </div>
      </div>

      {/* When — day chips */}
      <div className="grid grid-cols-[60px_1fr] items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-foreground/50">
          When
        </span>
        <div className="flex flex-wrap gap-1">
          {DAY_LABELS.map((label, idx) => {
            const active = value.daysOfWeek.includes(idx);
            return (
              <button
                key={label}
                type="button"
                onClick={() => toggleDay(idx)}
                disabled={disabled}
                className={`px-2 py-1 rounded-md text-[10.5px] font-medium border transition-colors ${
                  active
                    ? "bg-indigo-600 border-indigo-600 text-white"
                    : "bg-black/5 dark:bg-white/5 border-black/10 dark:border-white/10 text-foreground/80 hover:bg-black/10 dark:hover:bg-white/10"
                } ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Starts */}
      <div className="grid grid-cols-[60px_1fr] items-center gap-2">
        <label className="text-[10px] font-semibold uppercase tracking-wide text-foreground/50">
          Starts
        </label>
        <input
          type="text"
          className="w-full rounded-md bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 px-2.5 py-1.5 text-[11.5px] text-foreground outline-none focus:border-indigo-500"
          value={effectiveDateStr}
          readOnly
          disabled={disabled}
        />
      </div>

      {/* Ends — read-only "No end date" placeholder; full edit deferred */}
      <div className="grid grid-cols-[60px_1fr] items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-foreground/50">
          Ends
        </span>
        <span className="text-xs text-foreground/70">
          {value.expiryDate ? formatDateUS(value.expiryDate) : "No end date"}
        </span>
      </div>

      {/* Time range */}
      <div className="grid grid-cols-[60px_1fr] items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-foreground/50">
          Time
        </span>
        <div className="flex items-center gap-1.5 text-[11.5px] text-foreground">
          <input
            className="w-20 rounded-md bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 px-1.5 py-1 text-[11px] text-foreground outline-none focus:border-indigo-500"
            value={timeStartStr}
            onChange={(e) => setTimeStartStr(e.target.value)}
            onBlur={commitTimeStart}
            disabled={disabled}
          />
          <span className="text-foreground/60">to</span>
          <input
            className="w-20 rounded-md bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 px-1.5 py-1 text-[11px] text-foreground outline-none focus:border-indigo-500"
            value={timeEndStr}
            onChange={(e) => setTimeEndStr(e.target.value)}
            onBlur={commitTimeEnd}
            disabled={disabled}
          />
        </div>
      </div>

      {/* Override-semantics helper text — preserved verbatim from SPEC
          §3.4.2 step 5. Bookable Links override soft blocks so guest-facing
          schedules always show the declared window as available. */}
      <p className="text-[10.5px] leading-snug text-foreground/60 bg-black/5 dark:bg-white/5 border-l-2 border-indigo-500 pl-2.5 pr-3 py-2 rounded-md">
        Bookable Links override other soft blocks. Envoy will offer these slots
        even if your schedule shows them protected — real calendar events and
        blackout days stay blocked.
      </p>
    </>
  );
}
