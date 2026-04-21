/**
 * ExternalAgentPrimer — Stage 3 V2 of proposal
 * `2026-04-21_deal-room-widget-state-machine-and-agent-dialog-clarity`.
 *
 * A dismissible, banner-style primer shown ABOVE the first external_agent
 * bubble in a given `(NegotiationSession.id, external_agent_identity)`
 * pair. Per §7 V2:
 *
 *   "Danny has an AI agent helping schedule — you'll see a 'via' tag on
 *    its messages."
 *
 * This is NOT an inline chat bubble. It renders as a subdued banner (muted
 * colors, info-icon, dismiss control) so the guest can read it as meta
 * rather than dialog. After `markPrimerSeen` fires (see primer-state.ts),
 * the primer hides forever for that pair.
 *
 * Copy uses the counterpart's name when available; falls back to "your
 * counterpart's" per the proposal.
 */

import React from "react";

interface ExternalAgentPrimerProps {
  /**
   * Name of the counterpart (guest or host) the external agent represents.
   * When null/empty, copy falls back to "your counterpart's".
   */
  counterpartName?: string | null;
  /** Called when the user clicks the dismiss control. */
  onDismiss: () => void;
}

export function ExternalAgentPrimer({
  counterpartName,
  onDismiss,
}: ExternalAgentPrimerProps) {
  const trimmed = counterpartName?.trim();
  const first = trimmed ? trimmed.split(" ")[0] : "";
  const ownerPhrase = first ? `${first} has` : "Your counterpart has";

  return (
    <div
      className="flex items-start gap-2 rounded-lg border border-DEFAULT bg-surface-secondary/60 px-3 py-2 text-xs text-secondary"
      data-testid="external-agent-primer"
      role="note"
    >
      <span
        role="img"
        aria-label="heads up"
        className="mt-0.5 shrink-0 text-muted"
      >
        💡
      </span>
      <div className="min-w-0 flex-1 leading-relaxed">
        {ownerPhrase} an AI agent helping schedule — you&rsquo;ll see a{" "}
        <span className="font-medium">&ldquo;via&rdquo;</span> tag on its
        messages.
      </div>
      <button
        type="button"
        onClick={onDismiss}
        className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted hover:text-primary hover:bg-black/5 dark:hover:bg-white/5 transition"
        aria-label="Dismiss"
      >
        Got it
      </button>
    </div>
  );
}
