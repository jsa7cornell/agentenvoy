"use client";

import { useState } from "react";
import type { Synthesis } from "@/lib/negotiator/types";

interface DecisionInputProps {
  synthesis: Synthesis;
  onSubmit: (decisions: string[], clarification: string) => void;
  disabled?: boolean;
}

export function DecisionInput({
  synthesis,
  onSubmit,
  disabled,
}: DecisionInputProps) {
  const [decisions, setDecisions] = useState<string[]>(
    synthesis.decisionPoints.map(() => "")
  );
  const [clarification, setClarification] = useState("");

  const hasDecisionPoints = synthesis.decisionPoints.length > 0;
  const hasClarificationNeeded = !!synthesis.hostClarificationNeeded;
  const hasInput = hasDecisionPoints || hasClarificationNeeded;

  if (!hasInput) return null;

  const canSubmit =
    (hasDecisionPoints ? decisions.some((d) => d.trim()) : true) ||
    (hasClarificationNeeded ? clarification.trim() : true);

  return (
    <div className="space-y-4">
      {/* Decision point inputs */}
      {synthesis.decisionPoints.map((dp, i) => (
        <div key={i}>
          <label className="block text-sm font-medium mb-1">
            Your decision: {dp.topic}
          </label>
          <textarea
            value={decisions[i]}
            onChange={(e) => {
              const copy = [...decisions];
              copy[i] = e.target.value;
              setDecisions(copy);
            }}
            placeholder={
              dp.recommendation
                ? `Press submit to accept recommendation: "${dp.recommendation}"`
                : "Type your decision..."
            }
            disabled={disabled}
            rows={2}
            className="w-full bg-[var(--neg-surface)] border border-[var(--neg-border)] rounded-lg px-4 py-3 text-sm focus:outline-none focus:border-[var(--neg-accent)] disabled:opacity-50 resize-y placeholder:text-[var(--neg-text-muted)]/50"
          />
        </div>
      ))}

      {/* Clarification input */}
      {hasClarificationNeeded && (
        <div>
          <label className="block text-sm font-medium mb-1">
            Clarification requested
          </label>
          <p className="text-sm text-[var(--neg-text-muted)] mb-2">
            {synthesis.hostClarificationNeeded}
          </p>
          <textarea
            value={clarification}
            onChange={(e) => setClarification(e.target.value)}
            placeholder="Your answer..."
            disabled={disabled}
            rows={2}
            className="w-full bg-[var(--neg-surface)] border border-[var(--neg-border)] rounded-lg px-4 py-3 text-sm focus:outline-none focus:border-[var(--neg-accent)] disabled:opacity-50 resize-y placeholder:text-[var(--neg-text-muted)]/50"
          />
        </div>
      )}

      <button
        onClick={() => {
          const finalDecisions = decisions.map((d, i) =>
            d.trim() ||
            synthesis.decisionPoints[i]?.recommendation ||
            "No decision provided"
          );
          onSubmit(finalDecisions, clarification.trim());
        }}
        disabled={!canSubmit || disabled}
        className="px-6 py-2 rounded-lg bg-[var(--neg-accent)] text-black font-semibold text-sm hover:bg-[var(--neg-accent)]/90 transition disabled:opacity-50 disabled:cursor-not-allowed"
      >
        Submit & Continue
      </button>
    </div>
  );
}
