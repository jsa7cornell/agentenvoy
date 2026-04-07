"use client";

import { useState } from "react";
import type { Synthesis } from "@/lib/negotiator/types";

interface DecisionInputProps {
  synthesis: Synthesis;
  onContinue: (clarification: string) => void;
  onDecide: (decisions: string[]) => void;
  disabled?: boolean;
}

export function DecisionInput({
  synthesis,
  onContinue,
  onDecide,
  disabled,
}: DecisionInputProps) {
  const hasDecisionPoints = synthesis.decisionPoints.length > 0;
  const hasClarification = !!synthesis.hostClarificationNeeded;

  const [selectedAction, setSelectedAction] = useState<"continue" | "decide">(
    hasDecisionPoints ? "decide" : "continue"
  );
  const [clarification, setClarification] = useState("");
  const [decisions, setDecisions] = useState<string[]>(
    synthesis.decisionPoints.map(() => "")
  );

  const canContinue = clarification.trim().length > 0;
  const canDecide = hasDecisionPoints
    ? decisions.some((d) => d.trim())
    : false;

  return (
    <div className="space-y-4">
      {/* Show clarification prompt if admin requested it */}
      {hasClarification && (
        <div className="rounded border border-purple-500/20 bg-purple-500/5 px-4 py-3">
          <span className="text-xs font-medium text-[var(--neg-purple)] uppercase tracking-wider">
            Administrator needs your input
          </span>
          <p className="text-sm mt-1">{synthesis.hostClarificationNeeded}</p>
        </div>
      )}

      {/* Action toggle — only show both options when both are available */}
      {hasDecisionPoints && (
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setSelectedAction("continue")}
            disabled={disabled}
            className={`flex-1 px-4 py-2 rounded-lg border text-sm font-medium transition ${
              selectedAction === "continue"
                ? "border-[var(--neg-accent)] bg-[var(--neg-accent)]/10 text-[var(--neg-accent)]"
                : "border-[var(--neg-border)] text-[var(--neg-text-muted)] hover:border-[var(--neg-text-muted)]"
            } disabled:opacity-50`}
          >
            Add context & run another round
          </button>
          <button
            type="button"
            onClick={() => setSelectedAction("decide")}
            disabled={disabled}
            className={`flex-1 px-4 py-2 rounded-lg border text-sm font-medium transition ${
              selectedAction === "decide"
                ? "border-[var(--neg-accent)] bg-[var(--neg-accent)]/10 text-[var(--neg-accent)]"
                : "border-[var(--neg-border)] text-[var(--neg-text-muted)] hover:border-[var(--neg-text-muted)]"
            } disabled:opacity-50`}
          >
            Make a decision & finalize
          </button>
        </div>
      )}

      {/* Option A: Add context */}
      {selectedAction === "continue" && (
        <div className="rounded-lg border border-[var(--neg-border)] bg-[var(--neg-surface)] p-4 space-y-3">
          <p className="text-sm text-[var(--neg-text-muted)]">
            Provide additional context or clarification. The agents will incorporate this and the Administrator will run another synthesis round.
          </p>
          <textarea
            value={clarification}
            onChange={(e) => setClarification(e.target.value)}
            placeholder={hasClarification
              ? "Answer the Administrator's question above..."
              : "Add context, constraints, or preferences to guide the next round..."}
            disabled={disabled}
            rows={3}
            className="w-full bg-[var(--neg-surface-2)] border border-[var(--neg-border)] rounded-lg px-4 py-3 text-sm focus:outline-none focus:border-[var(--neg-accent)] disabled:opacity-50 resize-y placeholder:text-[var(--neg-text-muted)]/50"
          />
          <button
            onClick={() => onContinue(clarification.trim())}
            disabled={!canContinue || disabled}
            className="px-6 py-2 rounded-lg bg-[var(--neg-accent)] text-black font-semibold text-sm hover:bg-[var(--neg-accent)]/90 transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Continue Negotiation
          </button>
        </div>
      )}

      {/* Option B: Make decisions */}
      {selectedAction === "decide" && hasDecisionPoints && (
        <div className="rounded-lg border border-[var(--neg-border)] bg-[var(--neg-surface)] p-4 space-y-4">
          <p className="text-sm text-[var(--neg-text-muted)]">
            Make your decisions below. Each agent will acknowledge your choices and share brief final thoughts, then the Administrator will wrap up.
          </p>
          {synthesis.decisionPoints.map((dp, i) => (
            <div key={i}>
              <label className="block text-sm font-medium mb-1">
                {dp.topic}
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
                    ? `Administrator recommends: "${dp.recommendation}" — press Finalize to accept, or type your own decision`
                    : "Type your decision..."
                }
                disabled={disabled}
                rows={2}
                className="w-full bg-[var(--neg-surface-2)] border border-[var(--neg-border)] rounded-lg px-4 py-3 text-sm focus:outline-none focus:border-[var(--neg-accent)] disabled:opacity-50 resize-y placeholder:text-[var(--neg-text-muted)]/50"
              />
            </div>
          ))}
          <button
            onClick={() => {
              const finalDecisions = decisions.map((d, i) =>
                d.trim() ||
                synthesis.decisionPoints[i]?.recommendation ||
                "No decision provided"
              );
              onDecide(finalDecisions);
            }}
            disabled={!canDecide || disabled}
            className="px-6 py-2 rounded-lg bg-[var(--neg-accent)] text-black font-semibold text-sm hover:bg-[var(--neg-accent)]/90 transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Finalize
          </button>
        </div>
      )}
    </div>
  );
}
