"use client";

import type { Synthesis, DisagreementType } from "@/lib/negotiator/types";

const TYPE_LABELS: Record<DisagreementType, string> = {
  miscommunication: "Miscommunication",
  "differing-assumptions": "Differing Assumptions",
  "different-objectives": "Different Objectives",
};

const TYPE_COLORS: Record<DisagreementType, string> = {
  miscommunication: "text-[var(--neg-blue)]",
  "differing-assumptions": "text-[var(--neg-yellow)]",
  "different-objectives": "text-[var(--neg-red)]",
};

interface PhaseSynthesisProps {
  synthesis: Synthesis;
  round: number;
}

export function PhaseSynthesis({ synthesis, round }: PhaseSynthesisProps) {
  return (
    <div className="space-y-4">
      <h2 className="text-sm font-medium text-[var(--neg-text-muted)] uppercase tracking-wider">
        {round === 1 ? "Administrator Synthesis" : `Round ${round} Synthesis`}
      </h2>

      {/* Summary */}
      <div className="rounded-lg border border-[var(--neg-border)] bg-[var(--neg-surface)] p-4">
        <p className="text-sm leading-relaxed">{synthesis.summary}</p>
      </div>

      {/* Agreements */}
      {synthesis.agreements.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-xs font-medium text-[var(--neg-green)] uppercase tracking-wider">
            Agreements
          </h3>
          {synthesis.agreements.map((a, i) => (
            <div
              key={i}
              className="flex items-start gap-2 rounded border border-green-500/20 bg-green-500/5 px-3 py-2"
            >
              <span className="text-[var(--neg-green)] mt-0.5 shrink-0">
                &#10003;
              </span>
              <span className="text-sm">{a}</span>
            </div>
          ))}
        </div>
      )}

      {/* Disagreements */}
      {synthesis.disagreements.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-xs font-medium text-[var(--neg-yellow)] uppercase tracking-wider">
            Tensions
          </h3>
          {synthesis.disagreements.map((d, i) => (
            <div
              key={i}
              className="rounded border border-yellow-500/20 bg-yellow-500/5 px-3 py-2 space-y-1"
            >
              <div className="flex items-center gap-2">
                <span className={`text-xs font-medium ${TYPE_COLORS[d.type]}`}>
                  {TYPE_LABELS[d.type]}
                </span>
                <span className="text-sm font-medium">{d.topic}</span>
              </div>
              <p className="text-sm text-[var(--neg-text-muted)]">{d.summary}</p>
              {d.suggestedResolution && (
                <p className="text-sm text-[var(--neg-text)]">
                  <span className="text-[var(--neg-accent)]">Suggested:</span>{" "}
                  {d.suggestedResolution}
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Decision Points */}
      {synthesis.decisionPoints.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-xs font-medium text-[var(--neg-red)] uppercase tracking-wider">
            Your Call
          </h3>
          {synthesis.decisionPoints.map((dp, i) => (
            <div
              key={i}
              className="rounded border border-red-500/20 bg-red-500/5 px-3 py-3 space-y-2"
            >
              <div className="text-sm font-medium">{dp.topic}</div>
              {dp.options.map((opt, j) => (
                <div key={j} className="pl-3 border-l-2 border-[var(--neg-border)] space-y-0.5">
                  <div className="text-sm font-medium">
                    {opt.label}{" "}
                    <span className="text-[var(--neg-text-muted)] font-normal text-xs">
                      (advocated by {opt.advocatedBy.join(", ")})
                    </span>
                  </div>
                  <div className="text-sm text-[var(--neg-text-muted)]">
                    {opt.tradeoff}
                  </div>
                </div>
              ))}
              {dp.recommendation && (
                <div className="text-sm mt-1">
                  <span className="text-[var(--neg-purple)]">Administrator:</span>{" "}
                  {dp.recommendation}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Host clarification needed */}
      {synthesis.hostClarificationNeeded && (
        <div className="rounded border border-purple-500/20 bg-purple-500/5 px-3 py-2">
          <span className="text-xs font-medium text-[var(--neg-purple)] uppercase tracking-wider">
            Administrator needs your input
          </span>
          <p className="text-sm mt-1">{synthesis.hostClarificationNeeded}</p>
        </div>
      )}
    </div>
  );
}
