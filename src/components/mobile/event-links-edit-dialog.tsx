"use client";

/**
 * Mobile bottom-sheet for editing a reusable link from the Event Links sheet.
 *
 * Opens when the host taps **Edit** on any reusable-link card. The dialog
 * gates its editable form on `row.recurringWindowConfig != null` — i.e.,
 * the link has an attached recurring window — rather than on
 * `row.kind === "bookable"`. Today Bookable Links is the only such
 * variant; any future recurring-window-backed reusable (e.g. a sales-intro
 * link with weekday slots) inherits the editable form automatically. Links
 * without a recurring window (Primary) surface a stub pointing to
 * Preferences, since their config lives there, not on the link object.
 *
 * Visual contract: bottom-sheet chrome mirrors `rule-confirm-sheet.tsx`
 * (max-h 88vh, drag handle, pinned footer with primary/cancel actions).
 *
 * Vocabulary: "Primary link" (capitalized — SPEC §2.2), "Bookable Link"
 * (capitalized — feature name). Header copy stays variant-aware on
 * `row.kind` for now; the gate alone has been generalized in this PR.
 */

import { useEffect, useState } from "react";
import {
  RuleFormFields,
  type BookableLinkProposal,
} from "../onboarding/rule-form-fields";
import type { ReusableLinkRow } from "./event-links-card";

export interface EventLinksEditDialogProps {
  /** The link the host tapped Edit on. `null` keeps the dialog closed. */
  row: ReusableLinkRow | null;
  /** Fired after a successful save so the parent can refetch. */
  onSaved: () => void;
  /** Fired when the host dismisses (Cancel, backdrop tap, or × tap). */
  onDismiss: () => void;
}

export function EventLinksEditDialog({
  row,
  onSaved,
  onDismiss,
}: EventLinksEditDialogProps) {
  const [proposal, setProposal] = useState<BookableLinkProposal | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Hydrate the editable form-state from the row whenever a new row is
  // selected — gated on the presence of an attached recurring window
  // (variant-agnostic). Links without a recurring window (e.g. Primary)
  // leave `proposal` null and fall through to the stub body.
  useEffect(() => {
    if (!row || !row.recurringWindowConfig) {
      setProposal(null);
      return;
    }
    const cfg = row.recurringWindowConfig;
    setProposal({
      originalText: cfg.originalText,
      title: cfg.name ?? cfg.title,
      format: cfg.format,
      durationMinutes: cfg.durationMinutes,
      daysOfWeek: [...cfg.daysOfWeek],
      timeStart: cfg.timeStart,
      timeEnd: cfg.timeEnd,
      effectiveDate: cfg.effectiveDate,
      expiryDate: cfg.expiryDate,
      ...(cfg.guestPicks ? { guestPicks: cfg.guestPicks } : {}),
    });
    setError(null);
  }, [row]);

  async function handleSave() {
    if (!row || !row.ruleId || !proposal) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/availability-rules/edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ruleId: row.ruleId,
          proposal: {
            title: proposal.title,
            format: proposal.format,
            durationMinutes: proposal.durationMinutes,
            daysOfWeek: proposal.daysOfWeek,
            timeStart: proposal.timeStart,
            timeEnd: proposal.timeEnd,
            effectiveDate: proposal.effectiveDate,
            expiryDate: proposal.expiryDate,
            // Reusable-link guest-picks proposal, decided 2026-04-28.
            ...(proposal.guestPicks ? { guestPicks: proposal.guestPicks } : {}),
          },
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!res.ok) {
        throw new Error(body.error || `Request failed (${res.status})`);
      }
      onSaved();
      onDismiss();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setSubmitting(false);
    }
  }

  if (!row) return null;

  // Gate the editable form on the presence of an attached recurring
  // window (variant-agnostic). Header/footer copy still varies on
  // `row.kind` so today's Office Hours / Primary labels stay verbatim;
  // when a future variant lands, only the copy table needs a touch-up.
  const hasRecurringWindow = !!row.recurringWindowConfig;
  const isBookableLink = row.kind === "bookable";
  const canSave =
    hasRecurringWindow &&
    proposal !== null &&
    proposal.title.trim().length > 0 &&
    proposal.daysOfWeek.length > 0;

  return (
    <div
      className="fixed inset-0 z-[70] flex flex-col justify-end"
      role="dialog"
      aria-modal="true"
      aria-label={`Edit ${row.name}`}
      data-testid="mobile-event-links-edit-dialog"
    >
      {/* Backdrop */}
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => !submitting && onDismiss()}
        className="absolute inset-0 bg-black/55"
      />

      {/* Sheet */}
      <div className="relative bg-background border-t border-black/10 dark:border-white/10 rounded-t-2xl flex flex-col max-h-[88vh]">
        {/* Drag handle */}
        <div className="flex justify-center pt-2.5 pb-1">
          <div className="w-9 h-1 rounded-full bg-foreground/20" />
        </div>

        {/* Header */}
        <div className="flex items-center justify-between px-4 pt-1 pb-2">
          <span className="text-[10px] font-bold uppercase tracking-[0.08em] text-indigo-500">
            {isBookableLink ? "🕐 Edit Bookable Link" : "🔗 Edit Primary link"}
          </span>
          <button
            type="button"
            onClick={() => !submitting && onDismiss()}
            disabled={submitting}
            aria-label="Dismiss"
            className="text-foreground/40 hover:text-foreground/70 text-lg leading-none px-1"
          >
            ×
          </button>
        </div>

        {/* Scrollable form body */}
        <div className="flex-1 overflow-y-auto px-4 pb-3 flex flex-col gap-2.5">
          {hasRecurringWindow && proposal ? (
            <RuleFormFields
              value={proposal}
              onChange={setProposal}
              disabled={submitting}
            />
          ) : (
            // Primary-link stub: configure default duration / format / business
            // hours from Preferences, not from this dialog.
            <p className="text-[12px] leading-relaxed text-foreground/70 bg-black/5 dark:bg-white/5 border-l-2 border-indigo-500 pl-2.5 pr-3 py-2 rounded-md">
              Your Primary link uses your default meeting length, format, and
              business hours from{" "}
              <span className="font-semibold">Preferences</span>. Open
              Preferences to update those settings.
            </p>
          )}
          {error && <p className="text-[11px] text-red-500">{error}</p>}
        </div>

        {/* Pinned footer actions */}
        <div className="border-t border-black/10 dark:border-white/10 px-4 py-3 flex gap-2 bg-background">
          {hasRecurringWindow ? (
            <button
              type="button"
              onClick={handleSave}
              disabled={submitting || !canSave}
              data-testid="mobile-event-links-edit-save"
              className="flex-1 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold px-3 py-3 transition-colors"
            >
              {submitting ? "Saving…" : "Save changes"}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => !submitting && onDismiss()}
            disabled={submitting}
            className={`${hasRecurringWindow ? "flex-1" : "w-full"} rounded-lg bg-transparent border border-black/10 dark:border-white/10 text-foreground/70 hover:bg-black/5 dark:hover:bg-white/5 text-sm font-semibold px-3 py-3 transition-colors`}
          >
            {hasRecurringWindow ? "Cancel" : "Close"}
          </button>
        </div>
      </div>
    </div>
  );
}
