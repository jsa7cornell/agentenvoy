"use client";

import type { Synthesis } from "@/lib/negotiator/types";

interface PhaseSynthesisProps {
  synthesis: Synthesis;
}

export function PhaseSynthesis({ synthesis }: PhaseSynthesisProps) {
  const label = (agentId: string) =>
    synthesis.agentLabels?.[agentId] || agentId;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-[var(--neg-text-muted)] uppercase tracking-wider">
          Administrator Synthesis
        </h2>
        <a
          href="#recommendation"
          className="text-xs text-[var(--neg-accent)] hover:underline"
        >
          Skip to recommendation &darr;
        </a>
      </div>

      {/* Summary */}
      <div className="rounded-lg border border-[var(--neg-border)] bg-[var(--neg-surface)] p-4">
        <p className="text-sm leading-relaxed">{synthesis.summary}</p>
      </div>

      {/* Proposals side-by-side */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {synthesis.proposals.map((p) => {
          const isRecommended = synthesis.recommendation.agentId === p.agentId;
          const agentName = label(p.agentId);
          return (
            <div
              key={p.agentId}
              className={`rounded-lg border p-4 space-y-3 ${
                isRecommended
                  ? "border-[var(--neg-accent)]/50 bg-[var(--neg-accent)]/5"
                  : "border-[var(--neg-border)] bg-[var(--neg-surface)]"
              }`}
            >
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold text-[var(--neg-accent)] uppercase tracking-wider">
                    {agentName}
                  </span>
                  {isRecommended && (
                    <span className="text-xs px-1.5 py-0.5 rounded bg-[var(--neg-accent)]/15 text-[var(--neg-accent)] font-medium shrink-0">
                      Recommended
                    </span>
                  )}
                </div>
                <p className="text-sm font-medium">{p.headline}</p>
              </div>

              {/* Key Points */}
              <div>
                <span className="text-xs text-[var(--neg-text-muted)] uppercase tracking-wider">
                  Key Points
                </span>
                <ul className="mt-1 space-y-1">
                  {p.keyPoints.map((kp, i) => (
                    <li key={i} className="text-sm flex items-start gap-2">
                      <span className="text-[var(--neg-text-muted)] shrink-0">&bull;</span>
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
                      <span className="text-[var(--neg-red)] shrink-0">&minus;</span>
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
                      className="text-left px-4 py-2 text-xs font-medium text-[var(--neg-accent)] uppercase tracking-wider"
                    >
                      {label(p.agentId)}
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
      <div id="recommendation" className="rounded-lg border border-purple-500/20 bg-purple-500/5 p-4 space-y-2">
        <div className="flex items-center gap-2">
          <h3 className="text-xs font-medium text-[var(--neg-purple)] uppercase tracking-wider">
            Administrator Recommendation
            {synthesis.recommendation.route === "another-round"
              ? " — Another Round"
              : ` — ${label(synthesis.recommendation.agentId)}`}
          </h3>
          {synthesis.recommendation.confidence != null && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/15 text-[var(--neg-purple)] font-medium">
              {synthesis.recommendation.confidence}% confident
            </span>
          )}
        </div>
        <p className="text-sm leading-relaxed">{synthesis.recommendation.reasoning}</p>
        {synthesis.recommendation.clarificationRequests && synthesis.recommendation.clarificationRequests.length > 0 && (
          <div className="mt-2 pt-2 border-t border-purple-500/20">
            <span className="text-xs font-medium text-[var(--neg-text-muted)] uppercase tracking-wider">
              Suggested clarifications for {label(synthesis.recommendation.agentId)}
            </span>
            <ul className="mt-1 space-y-1">
              {synthesis.recommendation.clarificationRequests.map((q, i) => (
                <li key={i} className="text-sm flex items-start gap-2">
                  <span className="text-[var(--neg-purple)] shrink-0">?</span>
                  <span>{q}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
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
