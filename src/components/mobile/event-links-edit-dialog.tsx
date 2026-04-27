"use client";

/**
 * Mobile bottom-sheet for editing a reusable link from the Event Links sheet.
 *
 * Opens when the host taps **Edit** on any reusable-link card. The dialog is
 * variant-aware: Office Hours embeds `RuleFormFields` (PR 5's reusable form
 * body) and POSTs to `/api/availability-rules/edit`; the Primary variant
 * surfaces a stub for now (Phase 2 will wire its config) since Primary's
 * config (default duration / format / business hours) lives in the
 * Preferences drawer, not on the link object itself.
 *
 * Visual contract: bottom-sheet chrome mirrors `rule-confirm-sheet.tsx`
 * (max-h 88vh, drag handle, pinned footer with primary/cancel actions).
 *
 * Vocabulary: "Primary link" (capitalized — SPEC-2.0 §2.2), "Office Hours"
 * (capitalized — feature name).
 */

import { useEffect, useState } from "react";
import {
  RuleFormFields,
  type OfficeHoursProposal,
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
  const [proposal, setProposal] = useState<OfficeHoursProposal | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Hydrate the editable form-state from the row whenever a new row is
  // selected — Office Hours only. Primary doesn't carry editable
  // OfficeHoursProposal fields, so we leave `proposal` null and render the
  // Primary stub body instead.
  useEffect(() => {
    if (!row || row.kind !== "office_hours" || !row.officeHoursConfig) {
      setProposal(null);
      return;
    }
    const cfg = row.officeHoursConfig;
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

  const isOfficeHours = row.kind === "office_hours";
  const canSave =
    isOfficeHours &&
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
            {isOfficeHours ? "🕐 Edit Office Hours" : "🔗 Edit Primary link"}
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
          {isOfficeHours && proposal ? (
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
          {isOfficeHours ? (
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
            className={`${isOfficeHours ? "flex-1" : "w-full"} rounded-lg bg-transparent border border-black/10 dark:border-white/10 text-foreground/70 hover:bg-black/5 dark:hover:bg-white/5 text-sm font-semibold px-3 py-3 transition-colors`}
          >
            {isOfficeHours ? "Cancel" : "Close"}
          </button>
        </div>
      </div>
    </div>
  );
}
