"use client";

/**
 * Per-link card for the Event Links sheet's "Reusable links" group.
 *
 * Visual contract: see `mockups/mobile-v2.html`
 * §4 lines 972-995. Two-row layout — header (icon + name + sub + Edit) on
 * top, URL+Copy chip strip on the bottom.
 *
 *   ┌───────────────────────────────────────────────────────┐
 *   │ 🔗  Primary link                               Edit   │
 *   │     default 30 min · video                            │
 *   ├───────────────────────────────────────────────────────┤
 *   │ agentenvoy.ai/meet/john                       [Copy]  │
 *   └───────────────────────────────────────────────────────┘
 *
 * The Primary variant gets a faint accent surface; Office Hours and other
 * variants render in the neutral surface tone.
 *
 * Vocabulary: copy uses **Primary link** (capitalized) for the host's default
 * reusable link — matches `NegotiationLink.type === "primary"` and SPEC
 * §2.2. **Office Hours** (capitalized — feature name) labels the recurring-
 * window-backed reusable variant.
 */

import { useState } from "react";

export type ReusableLinkKind = "primary" | "office_hours";

export interface ReusableLinkRow {
  /** Stable client-side key — for Primary the literal `"primary"`; for
   *  Office Hours the rule id. */
  key: string;
  kind: ReusableLinkKind;
  /** Display name — host-facing identifier (e.g. "Primary link",
   *  "Guitar students"). */
  name: string;
  /** Display sub-line — config summary (e.g. "default 30 min · video",
   *  "Office Hours · Mon–Fri 9–5 · 30 min"). */
  sub: string;
  /** Full URL — used for both display (host-name stripped) and copy. */
  url: string;
  /** Visual signifier — emoji per the mockup (🔗, 🕐, 📱, etc.). */
  icon: string;
  /** Recurring-window-backed reusables only — the rule id used by the
   *  Edit dialog. Office Hours is the most common variant today; other
   *  recurring-window-backed variants populate this the same way. */
  ruleId?: string;
  /** Set when the link has an attached recurring window — the editable
   *  config the Edit dialog hydrates from (title / format / duration /
   *  window / days). The Edit dialog gates its editable form on the
   *  presence of this field, not on `kind`, so any future variant with a
   *  recurring window inherits the editable form for free. */
  recurringWindowConfig?: {
    title: string;
    name?: string;
    format: "video" | "phone" | "in-person";
    durationMinutes: number;
    timeStart: string;
    timeEnd: string;
    daysOfWeek: number[];
    effectiveDate?: string;
    expiryDate?: string;
    originalText: string;
  };
}

interface EventLinksCardProps {
  row: ReusableLinkRow;
  /** Caller fires when the host taps Edit. The dialog is owned by the
   *  parent so it can sequence a single dialog at a time. */
  onEdit: (row: ReusableLinkRow) => void;
}

export function EventLinksCard({ row, onEdit }: EventLinksCardProps) {
  const [copied, setCopied] = useState(false);

  function copy() {
    if (typeof navigator === "undefined" || !navigator.clipboard) return;
    navigator.clipboard.writeText(row.url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  const isPrimary = row.kind === "primary";

  return (
    <div
      className={`rounded-xl border p-3 flex flex-col gap-2 ${
        isPrimary
          ? "border-accent/40 bg-accent-surface/30"
          : "border-secondary bg-surface-secondary/40"
      }`}
      data-testid={`mobile-event-links-card-${row.kind}`}
    >
      {/* Header row — icon + name/sub + Edit */}
      <div className="flex items-center gap-2.5">
        <div
          className="w-8 h-8 rounded-lg bg-surface-secondary/80 flex items-center justify-center text-base flex-shrink-0"
          aria-hidden
        >
          {row.icon}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-xs font-semibold text-primary truncate flex items-center gap-1.5">
            {row.name}
            {isPrimary && (
              <span className="text-[9px] uppercase tracking-wide text-muted font-normal">
                default
              </span>
            )}
          </div>
          <div className="text-[10.5px] text-muted truncate leading-snug">{row.sub}</div>
        </div>
        <button
          type="button"
          onClick={() => onEdit(row)}
          className="text-[10px] px-2 py-1 rounded text-secondary hover:text-accent transition flex-shrink-0"
          data-testid={`mobile-event-links-edit-${row.kind}`}
          aria-label={`Edit ${row.name}`}
        >
          Edit
        </button>
      </div>

      {/* URL + Copy chip — the "my-link chip" pattern, on every reusable now */}
      <div className="flex items-center gap-2 rounded-lg bg-surface/60 border border-secondary/60 px-2.5 py-1.5">
        <span className="text-[11px] font-mono text-secondary truncate flex-1 min-w-0">
          {row.url.replace(/^https?:\/\//, "")}
        </span>
        <button
          type="button"
          onClick={copy}
          className="text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded bg-surface-secondary/80 hover:bg-surface-tertiary text-secondary hover:text-accent transition flex-shrink-0"
          data-testid={`mobile-event-links-copy-${row.kind}`}
          aria-label={`Copy ${row.name} URL`}
        >
          {copied ? <span className="text-emerald-500">Copied</span> : "Copy"}
        </button>
      </div>
    </div>
  );
}
