"use client";

import type { Synthesis } from "@/lib/negotiator/types";

interface PhaseSynthesisProps {
  synthesis: Synthesis;
}

export function PhaseSynthesis({ synthesis }: PhaseSynthesisProps) {
  return (
    <div className="space-y-4">
      <h2 className="text-sm font-medium text-[var(--neg-text-muted)] uppercase tracking-wider">
        Administrator Synthesis
      </h2>

      {/* Summary */}
      <div className="rounded-lg border border-[var(--neg-border)] bg-[var(--neg-surface)] p-4">
        <p className="text-sm leading-relaxed">{synthesis.summary}</p>
      </div>

      {/* Proposals side-by-side */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {synthesis.proposals.map((p) => {
          const isRecommended = synthesis.recommendation.agentId === p.agentId;
          return (
            <div
              key={p.agentId}
              className={`rounded-lg border p-4 space-y-3 ${
                isRecommended
                  ? "border-[var(--neg-accent)]/50 bg-[var(--neg-accent)]/5"
                  : "border-[var(--neg-border)] bg-[var(--neg-surface)]"
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold">{p.headline}</span>
                {isRecommended && (
                  <span className="text-xs px-1.5 py-0.5 rounded bg-[var(--neg-accent)]/15 text-[var(--neg-accent)] font-medium shrink-0">
                    Recommended
                  </span>
                )}
              </div>

              {/* Key Points */}
              <div>
                <span className="text-xs text-[var(--neg-text-muted)] uppercase tracking-wider">
                  Key Points
                </span>
                <ul className="mt-1 space-y-1">
                  {p.keyPoints.map((kp, i) => (
                    <li key={i} className="text-sm flex items-start gap-2">
                      <span className="text-[var(--neg-text-muted)] shrink-0">•</span>
                      <span>{kp}</span>
                    </li>
                  ))}
                </ul>
              </div>

              {/* Strengths */}
              <div>
                <span className="text-xs text-[var(--neg-green)] uppercase tracking-wider">
                  Strengths
                </span>
                <ul className="mt-1 space-y-1">
                  {p.strengths.map((s, i) => (
                    <li key={i} className="text-sm flex items-start gap-2">
                      <span className="text-[var(--neg-green)] shrink-0">+</span>
                      <span>{s}</span>
                    </li>
                  ))}
                </ul>
              </div>

              {/* Risks */}
              <div>
                <span className="text-xs text-[var(--neg-red)] uppercase tracking-wider">
                  Risks
                </span>
                <ul className="mt-1 space-y-1">
                  {p.risks.map((r, i) => (
                    <li key={i} className="text-sm flex items-start gap-2">
                      <span className="text-[var(--neg-red)] shrink-0">−</span>
                      <span>{r}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          );
        })}
      </div>

      {/* Common Ground */}
      {synthesis.commonGround.length > 0 && (
        <div className="space-y-1">
          <h3 className="text-xs font-medium text-[var(--neg-green)] uppercase tracking-wider">
            Common Ground
          </h3>
          <div className="rounded-lg border border-[var(--neg-border)] bg-green-500/5 divide-y divide-[var(--neg-border)]">
            {synthesis.commonGround.map((a, i) => (
              <div key={i} className="flex items-start gap-3 px-4 py-2.5">
                <span className="text-[var(--neg-green)] mt-0.5 shrink-0">&#10003;</span>
                <span className="text-sm">{a}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Key Differences */}
      {synthesis.keyDifferences.length > 0 && (
        <div className="space-y-1">
          <h3 className="text-xs font-medium text-[var(--neg-text-muted)] uppercase tracking-wider">
            Key Differences
          </h3>
          <div className="rounded-lg border border-[var(--neg-border)] overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-[var(--neg-surface-2)]">
                  <th className="text-left px-4 py-2 text-xs font-medium text-[var(--neg-text-muted)] uppercase tracking-wider">
                    Dimension
                  </th>
                  {synthesis.proposals.map((p) => (
                    <th
                      key={p.agentId}
                      className="text-left px-4 py-2 text-xs font-medium text-[var(--neg-text-muted)] uppercase tracking-wider"
                    >
                      {p.headline.split(" ").slice(0, 3).join(" ")}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--neg-border)]">
                {synthesis.keyDifferences.map((kd, i) => (
                  <tr key={i}>
                    <td className="px-4 py-2.5 font-medium">{kd.dimension}</td>
                    {synthesis.proposals.map((p) => (
                      <td key={p.agentId} className="px-4 py-2.5 text-[var(--neg-text-muted)]">
                        {kd.proposals[p.agentId] || "—"}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Recommendation */}
      <div className="rounded-lg border border-purple-500/20 bg-purple-500/5 p-4 space-y-2">
        <h3 className="text-xs font-medium text-[var(--neg-purple)] uppercase tracking-wider">
          Administrator Recommendation
        </h3>
        <p className="text-sm leading-relaxed">{synthesis.recommendation.reasoning}</p>
        {synthesis.blendOpportunity && (
          <div className="mt-2 pt-2 border-t border-purple-500/20">
            <span className="text-xs font-medium text-[var(--neg-accent)]">
              Blend opportunity:
            </span>
            <p className="text-sm mt-1">{synthesis.blendOpportunity}</p>
          </div>
        )}
      </div>
    </div>
  );
}
