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
  prevSynthesis?: Synthesis;
}

export function PhaseSynthesis({ synthesis, round, prevSynthesis }: PhaseSynthesisProps) {
  // Compute what changed vs previous round
  const newAgreements = prevSynthesis
    ? synthesis.agreements.filter((a) => !prevSynthesis.agreements.includes(a))
    : synthesis.agreements;

  const resolvedTopics = prevSynthesis
    ? prevSynthesis.disagreements
        .filter((d) => !synthesis.disagreements.find((d2) => d2.topic === d.topic))
        .map((d) => d.topic)
    : [];

  const isConverging =
    prevSynthesis &&
    (newAgreements.length > 0 || resolvedTopics.length > 0 || synthesis.disagreements.length < prevSynthesis.disagreements.length);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <h2 className="text-sm font-medium text-[var(--neg-text-muted)] uppercase tracking-wider">
          {round === 1 ? "Administrator Synthesis" : `Round ${round} Synthesis`}
        </h2>
        {round > 1 && (
          <span className={`text-xs px-2 py-0.5 rounded-full ${
            synthesis.isResolved
              ? "bg-green-500/15 text-[var(--neg-green)]"
              : isConverging
                ? "bg-orange-500/15 text-[var(--neg-accent)]"
                : "bg-[var(--neg-surface-2)] text-[var(--neg-text-muted)]"
          }`}>
            {synthesis.isResolved ? "Resolved" : isConverging ? "Converging" : "Still divided"}
          </span>
        )}
      </div>

      {/* Round delta — what changed */}
      {round > 1 && (newAgreements.length > 0 || resolvedTopics.length > 0) && (
        <div className="rounded-lg border border-[var(--neg-border)] bg-[var(--neg-surface-2)] px-4 py-3 space-y-1.5">
          <p className="text-xs font-medium text-[var(--neg-text-muted)] uppercase tracking-wider mb-2">
            What changed this round
          </p>
          {newAgreements.map((a, i) => (
            <div key={i} className="flex items-start gap-2">
              <span className="text-[var(--neg-green)] shrink-0 text-xs mt-0.5">+</span>
              <span className="text-sm text-[var(--neg-text)]">New agreement: {a}</span>
            </div>
          ))}
          {resolvedTopics.map((t, i) => (
            <div key={i} className="flex items-start gap-2">
              <span className="text-[var(--neg-green)] shrink-0 text-xs mt-0.5">✓</span>
              <span className="text-sm text-[var(--neg-text)]">Tension resolved: {t}</span>
            </div>
          ))}
        </div>
      )}

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
              <span className="text-[var(--neg-green)] mt-0.5 shrink-0">&#10003;</span>
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
                  <div className="text-sm text-[var(--neg-text-muted)]">{opt.tradeoff}</div>
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
