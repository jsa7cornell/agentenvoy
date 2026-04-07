"use client";

import { useState } from "react";
import type { Synthesis, DisagreementType } from "@/lib/negotiator/types";

const TYPE_LABELS: Record<DisagreementType, string> = {
  miscommunication: "Miscommunication",
  "differing-assumptions": "Differing Assumptions",
  "different-objectives": "Different Objectives",
};

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
  const hasTensions = synthesis.disagreements.length > 0;
  const hasClarification = !!synthesis.hostClarificationNeeded;

  const [selectedAction, setSelectedAction] = useState<"continue" | "decide">("decide");
  const [tensionResponses, setTensionResponses] = useState<Record<number, string>>({});
  const [clarification, setClarification] = useState("");
  const [decisions, setDecisions] = useState<string[]>(
    synthesis.decisionPoints.map((dp) => dp.recommendation || "")
  );

  const hasAnyTensionResponse = Object.values(tensionResponses).some(
    (v) => v.trim().length > 0
  );
  const canContinue = hasAnyTensionResponse || clarification.trim().length > 0;

  function handleContinueSubmit() {
    const parts: string[] = [];
    synthesis.disagreements.forEach((d, i) => {
      const response = tensionResponses[i]?.trim();
      if (response) {
        parts.push(`Re: ${d.topic} — ${response}`);
      }
    });
    if (clarification.trim()) {
      parts.push(`Additional context: ${clarification.trim()}`);
    }
    onContinue(parts.join("\n\n"));
  }

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

      {/* Action toggle */}
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
          Resolve tension & run another round
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
          {hasDecisionPoints ? "Make a decision & finalize" : "Finalize"}
        </button>
      </div>

      {/* Option A: Respond to tensions + add context */}
      {selectedAction === "continue" && (
        <div className="rounded-lg border border-[var(--neg-border)] bg-[var(--neg-surface)] p-4 space-y-4">
          <p className="text-sm text-[var(--neg-text-muted)]">
            {hasTensions
              ? "Respond to specific tensions below, or add general context. The Administrator will use your input in the next synthesis round."
              : "Provide additional context or clarification for the next round."}
          </p>

          {/* Per-tension response cards */}
          {hasTensions && (
            <div className="space-y-3">
              {synthesis.disagreements.map((d, i) => {
                const isMajor = d.type === "different-objectives";
                const borderColor = isMajor
                  ? "border-red-500/30"
                  : "border-yellow-500/30";
                const bgColor = isMajor ? "bg-red-500/5" : "bg-yellow-500/5";
                const dotColor = isMajor
                  ? "text-[var(--neg-red)]"
                  : "text-[var(--neg-yellow)]";
                const labelColor = isMajor
                  ? "text-[var(--neg-red)]"
                  : "text-[var(--neg-yellow)]";

                return (
                  <div
                    key={i}
                    className={`rounded-lg border ${borderColor} ${bgColor} p-3 space-y-2`}
                  >
                    <div className="flex items-center gap-2">
                      <span className={`${dotColor} shrink-0`}>&#9679;</span>
                      <span className="text-sm font-medium flex-1">
                        {d.topic}
                      </span>
                      <span
                        className={`text-xs ${labelColor} shrink-0 uppercase tracking-wider`}
                      >
                        {TYPE_LABELS[d.type]}
                      </span>
                    </div>
                    <p className="text-sm text-[var(--neg-text-muted)] pl-5">
                      {d.summary}
                    </p>
                    {d.suggestedResolution && (
                      <p className="text-sm text-[var(--neg-text)] pl-5">
                        <span className="text-[var(--neg-accent)]">
                          Suggested:
                        </span>{" "}
                        {d.suggestedResolution}
                      </p>
                    )}
                    <textarea
                      value={tensionResponses[i] || ""}
                      onChange={(e) =>
                        setTensionResponses((prev) => ({
                          ...prev,
                          [i]: e.target.value,
                        }))
                      }
                      placeholder="Your response to this tension (optional)..."
                      disabled={disabled}
                      rows={2}
                      className="w-full bg-[var(--neg-surface)] border border-[var(--neg-border)] rounded px-3 py-2 text-sm focus:outline-none focus:border-[var(--neg-accent)] disabled:opacity-50 resize-y placeholder:text-[var(--neg-text-muted)]/50"
                    />
                  </div>
                );
              })}
            </div>
          )}

          {/* General context textarea */}
          <div>
            <label className="block text-xs text-[var(--neg-text-muted)] mb-1">
              Additional context
            </label>
            <textarea
              value={clarification}
              onChange={(e) => setClarification(e.target.value)}
              placeholder={
                hasClarification
                  ? "Answer the Administrator's question above..."
                  : "Add general context, constraints, or preferences..."
              }
              disabled={disabled}
              rows={2}
              className="w-full bg-[var(--neg-surface-2)] border border-[var(--neg-border)] rounded-lg px-4 py-3 text-sm focus:outline-none focus:border-[var(--neg-accent)] disabled:opacity-50 resize-y placeholder:text-[var(--neg-text-muted)]/50"
            />
          </div>

          <button
            onClick={handleContinueSubmit}
            disabled={!canContinue || disabled}
            className="px-6 py-2 rounded-lg bg-[var(--neg-accent)] text-black font-semibold text-sm hover:bg-[var(--neg-accent)]/90 transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Continue Negotiation
          </button>
        </div>
      )}

      {/* Option B: Make decisions / finalize */}
      {selectedAction === "decide" && (
        <div className="rounded-lg border border-[var(--neg-border)] bg-[var(--neg-surface)] p-4 space-y-4">
          {hasDecisionPoints ? (
            <>
              <p className="text-sm text-[var(--neg-text-muted)]">
                The Administrator has suggested a decision for each open point below — pre-filled from the synthesis. Edit or override to make it your own, then click Finalize. Each agent will acknowledge your choices and share brief final thoughts.
              </p>
              {synthesis.decisionPoints.map((dp, i) => (
                <div key={i}>
                  <div className="flex items-baseline gap-2 mb-1">
                    <label className="block text-sm font-medium">
                      {dp.topic}
                    </label>
                    {dp.recommendation && (
                      <span className="text-xs text-[var(--neg-accent)]">
                        pre-filled from Administrator
                      </span>
                    )}
                  </div>
                  <textarea
                    value={decisions[i]}
                    onChange={(e) => {
                      const copy = [...decisions];
                      copy[i] = e.target.value;
                      setDecisions(copy);
                    }}
                    placeholder="Type your decision..."
                    disabled={disabled}
                    rows={2}
                    className="w-full bg-[var(--neg-surface-2)] border border-[var(--neg-border)] rounded-lg px-4 py-3 text-sm focus:outline-none focus:border-[var(--neg-accent)] disabled:opacity-50 resize-y placeholder:text-[var(--neg-text-muted)]/50"
                  />
                </div>
              ))}
            </>
          ) : (
            <p className="text-sm text-[var(--neg-text-muted)]">
              No open decision points. Each agent will share brief final thoughts
              and the Administrator will wrap up with a summary.
            </p>
          )}
          <button
            onClick={() => {
              const finalDecisions = hasDecisionPoints
                ? decisions.map(
                    (d, i) =>
                      d.trim() ||
                      synthesis.decisionPoints[i]?.recommendation ||
                      "No decision provided"
                  )
                : ["Accept synthesis as-is"];
              onDecide(finalDecisions);
            }}
            disabled={disabled}
            className="px-6 py-2 rounded-lg bg-[var(--neg-accent)] text-black font-semibold text-sm hover:bg-[var(--neg-accent)]/90 transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Finalize
          </button>
        </div>
      )}
    </div>
  );
}
