"use client";

/**
 * @deprecated 2026-05-03 — retired from the office-hours chat-create flow
 * by proposal `2026-05-03_recurring-and-office-hours-widgets` §3.8. See
 * the parallel @deprecated note on `rule-confirm-card.tsx` for context.
 * Removal scheduled for a sibling cleanup PR.
 *
 * ---
 *
 * Mobile bottom-sheet confirmation UI for the Office Hours create flow.
 *
 * Slides up over the chat thread; the host reviews / edits the prefilled
 * fields and either confirms (POST → /api/availability-rules/confirm) or
 * dismisses back to the thread (no write). The sheet anchors the form
 * around the editable fields, with "Looks good" / "Cancel" pinned at the
 * bottom — the standard iOS/Android pattern for editable forms triggered
 * from chat.
 *
 * Per item 20 (CODEBASE-CLEANUP, amended 2026-04-26): mobile = sheet,
 * desktop = card. UX direction was swapped from the original "inline
 * card on mobile" mockup direction.
 *
 * Companion: `rule-confirm-card.tsx` (desktop variant); both share the
 * `RuleFormFields` component for the actual form body.
 */

import { useState } from "react";
import { RuleFormFields, type OfficeHoursProposal } from "./rule-form-fields";

export interface RuleConfirmSheetProps {
  /** ChannelMessage.id of the system row carrying this proposal — sent to
   *  the confirm endpoint so the server validates the metadata it persisted
   *  matches the body the client is asking to commit. */
  proposalMessageId: string;
  /** Initial proposal (what Envoy parsed). */
  initialProposal: OfficeHoursProposal;
  /** Whether the sheet is currently visible. Parent owns this state. */
  open: boolean;
  /** Fired after a successful confirm. */
  onConfirmed?: (result: { ruleId: string; linkUrl?: string }) => void;
  /** Fired when the sheet is dismissed (Cancel, backdrop tap, or × tap). */
  onDismiss: () => void;
}

export function RuleConfirmSheet({
  proposalMessageId,
  initialProposal,
  open,
  onConfirmed,
  onDismiss,
}: RuleConfirmSheetProps) {
  const [proposal, setProposal] = useState<OfficeHoursProposal>(initialProposal);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConfirm() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/availability-rules/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          proposalMessageId,
          proposal,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        ruleId?: string;
        linkUrl?: string;
        error?: string;
      };
      if (!res.ok) {
        throw new Error(body.error || `Request failed (${res.status})`);
      }
      onConfirmed?.({ ruleId: body.ruleId ?? "", linkUrl: body.linkUrl });
      // Parent will dismiss after rendering the confirmation row.
      onDismiss();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col justify-end"
      role="dialog"
      aria-modal="true"
      aria-label="Create Office Hours link"
    >
      {/* Backdrop */}
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => !submitting && onDismiss()}
        className="absolute inset-0 bg-black/45"
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
            🕐 New Office Hours rule
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
          <RuleFormFields value={proposal} onChange={setProposal} disabled={submitting} />
          {error && <p className="text-[11px] text-red-500">{error}</p>}
        </div>

        {/* Pinned footer actions */}
        <div className="border-t border-black/10 dark:border-white/10 px-4 py-3 flex gap-2 bg-background">
          <button
            type="button"
            onClick={handleConfirm}
            disabled={submitting || !proposal.title.trim() || proposal.daysOfWeek.length === 0}
            className="flex-1 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold px-3 py-3 transition-colors"
          >
            {submitting ? "Creating…" : "✓ Looks good"}
          </button>
          <button
            type="button"
            onClick={() => !submitting && onDismiss()}
            disabled={submitting}
            className="flex-1 rounded-lg bg-transparent border border-black/10 dark:border-white/10 text-foreground/70 hover:bg-black/5 dark:hover:bg-white/5 text-sm font-semibold px-3 py-3 transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
