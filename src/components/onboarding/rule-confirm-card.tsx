"use client";

/**
 * @deprecated 2026-05-03 — retired from the office-hours chat-create flow
 * by proposal `2026-05-03_recurring-and-office-hours-widgets` §3.8. The
 * propose-then-confirm pattern was replaced by a chat-driven model: the
 * `office_hours` action emits → handler commits the rule → composer
 * narrates per the calendar-rule-composer narration discipline. Host
 * iterates via natural language ("actually 45 min") with the composer
 * emitting `update_availability_rule` patches per turn.
 *
 * This file remains in the tree as a back-compat shim for any in-flight
 * `rule_proposal` system messages persisted before the deploy. The
 * `/api/availability-rules/confirm` endpoint stays alive for the same
 * reason. Removal scheduled for a sibling cleanup PR once main is stable
 * AND no `rule_proposal` rows remain unconfirmed in production.
 *
 * ---
 *
 * Desktop in-thread confirmation card for the Office Hours create flow.
 *
 * Renders inline as the next chat message after Envoy parses a host's
 * rule-creation utterance. No backdrop, no modal — the chat thread stays
 * visible and scrollable above. The host reviews / edits the prefilled
 * fields and either confirms (POST → /api/availability-rules/confirm)
 * or cancels (no write).
 *
 * Per item 20 (CODEBASE-CLEANUP, amended 2026-04-26): desktop = card,
 * mobile = bottom sheet. UX direction was swapped from the original
 * "modal overlay on desktop / inline card on mobile" mockup direction.
 *
 * Companion: `rule-confirm-sheet.tsx` (mobile variant); both share the
 * `RuleFormFields` component for the actual form body.
 */

import { useState } from "react";
import { RuleFormFields, type OfficeHoursProposal } from "./rule-form-fields";

export interface RuleConfirmCardProps {
  /** ChannelMessage.id of the system row carrying this proposal — sent to
   *  the confirm endpoint so the server validates the metadata it persisted
   *  matches the body the client is asking to commit. */
  proposalMessageId: string;
  /** Initial proposal (what Envoy parsed). The card initializes its editable
   *  state from this value. */
  initialProposal: OfficeHoursProposal;
  /** Fired after a successful confirm so the parent can refresh the feed
   *  and show the confirmation row + new Event Links card. */
  onConfirmed?: (result: { ruleId: string; linkUrl?: string }) => void;
  /** Fired when the host taps Cancel. Parent should not refetch — there's
   *  nothing new to show. */
  onCancelled?: () => void;
}

export function RuleConfirmCard({
  proposalMessageId,
  initialProposal,
  onConfirmed,
  onCancelled,
}: RuleConfirmCardProps) {
  const [proposal, setProposal] = useState<OfficeHoursProposal>(initialProposal);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<"confirmed" | "cancelled" | null>(null);

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
      setDone("confirmed");
      onConfirmed?.({ ruleId: body.ruleId ?? "", linkUrl: body.linkUrl });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setSubmitting(false);
    }
  }

  function handleCancel() {
    setDone("cancelled");
    onCancelled?.();
  }

  if (done === "confirmed") {
    return (
      <div className="self-start w-[92%] max-w-[480px] rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-3.5 py-2.5 text-[12px] text-emerald-700 dark:text-emerald-300">
        ✓ Created Office Hours link · {proposal.title}
      </div>
    );
  }
  if (done === "cancelled") {
    return null;
  }

  return (
    <div className="self-start w-[92%] max-w-[480px] rounded-xl border border-indigo-500/40 bg-background dark:bg-white/[0.03] p-3.5 flex flex-col gap-2.5 shadow-sm">
      <div className="flex items-center justify-between">
        <span className="text-[9px] font-bold uppercase tracking-[0.08em] text-indigo-500">
          🕐 New Office Hours rule
        </span>
        <button
          type="button"
          onClick={handleCancel}
          disabled={submitting}
          aria-label="Dismiss"
          className="text-foreground/40 hover:text-foreground/70 text-base leading-none px-1"
        >
          ×
        </button>
      </div>

      <RuleFormFields value={proposal} onChange={setProposal} disabled={submitting} />

      {error && <p className="text-[11px] text-red-500">{error}</p>}

      <div className="flex gap-1.5 pt-0.5">
        <button
          type="button"
          onClick={handleConfirm}
          disabled={submitting || !proposal.title.trim() || proposal.daysOfWeek.length === 0}
          className="flex-1 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-semibold px-3 py-2.5 transition-colors"
        >
          {submitting ? "Creating…" : "✓ Looks good"}
        </button>
        <button
          type="button"
          onClick={handleCancel}
          disabled={submitting}
          className="flex-1 rounded-lg bg-transparent border border-black/10 dark:border-white/10 text-foreground/70 hover:bg-black/5 dark:hover:bg-white/5 text-xs font-semibold px-3 py-2.5 transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
