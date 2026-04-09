"use client";

import { PhaseSynthesis } from "@/components/negotiator/phase-synthesis";
import { PhaseResearch } from "@/components/negotiator/phase-research";
import { TranscriptExport } from "@/components/negotiator/transcript-export";
import { SimpleMarkdown } from "@/components/negotiator/simple-markdown";
import { PROVIDER_COLORS, PROVIDER_DOT } from "@/lib/negotiator/provider-colors";
import { generateTitle } from "@/lib/negotiator/generate-title";
import type {
  ResearchResult,
  Synthesis,
  FinalResponse,
  UsageRow,
} from "@/lib/negotiator/types";

interface NegotiatorResultViewProps {
  question: string;
  agents: Record<string, unknown>[];
  research: Record<string, unknown>[];
  syntheses: Record<string, unknown>[];
  humanDecisions: string[];
  finalResponses: Record<string, unknown>[];
  adminSummary: string | null;
  totalTokens: number;
  transcript: string;
  usageRows?: Record<string, unknown>[];
  createdAt: string;
}

export function NegotiatorResultView({
  question,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  agents,
  research: rawResearch,
  syntheses: rawSyntheses,
  finalResponses: rawFinalResponses,
  adminSummary,
  totalTokens,
  transcript,
  usageRows: rawUsageRows,
  createdAt,
}: NegotiatorResultViewProps) {
  const research = rawResearch as unknown as ResearchResult[];
  const syntheses = rawSyntheses as unknown as Synthesis[];
  const finalResponses = rawFinalResponses as unknown as FinalResponse[];

  const latestSynthesis = syntheses[syntheses.length - 1];
  const agentLabels = latestSynthesis?.agentLabels ?? {};
  const title = generateTitle(question);
  const usageRows = (rawUsageRows || []) as unknown as UsageRow[];

  return (
    <div className="space-y-6">
      {/* Top CTA */}
      <div className="flex items-center justify-between">
        <a href="/negotiate" className="text-xs text-[var(--neg-accent)] hover:opacity-80 transition font-medium">
          AgentNegotiator
        </a>
        <a
          href="/negotiate"
          className="text-sm px-4 py-1.5 rounded-lg border border-[var(--neg-accent)]/40 text-[var(--neg-accent)] hover:bg-[var(--neg-accent)]/10 transition"
        >
          Create your own &rarr;
        </a>
      </div>

      {/* Header — title + question + date */}
      <div>
        <h2 className="text-sm font-semibold text-[var(--neg-text)] mb-1">
          {title}
        </h2>
        <h1 className="text-xl font-semibold text-[var(--neg-text)] mb-1">
          {question}
        </h1>
        <p className="text-xs text-[var(--neg-text-muted)]">
          {new Date(createdAt).toLocaleDateString("en-US", {
            weekday: "long",
            year: "numeric",
            month: "long",
            day: "numeric",
          })}
        </p>
      </div>

      {/* Final outcome */}
      {adminSummary && (
        <div className="rounded-lg border border-purple-500/30 bg-purple-500/5 p-4 space-y-3">
          <div className="flex items-start justify-between gap-4">
            <h2 className="text-sm font-medium text-[var(--neg-purple)] uppercase tracking-wider shrink-0 pt-0.5">
              Final Outcome
            </h2>
            {usageRows.length > 0 ? (
              <table className="text-[10px] text-[var(--neg-text-muted)] border-collapse shrink-0">
                <thead>
                  <tr>
                    <th className="text-left pr-3 pb-0.5 font-medium"></th>
                    <th className="text-right pr-3 pb-0.5 font-medium">Tokens</th>
                    <th className="text-right pr-3 pb-0.5 font-medium">Cost</th>
                    <th className="text-right pb-0.5 font-medium">Time</th>
                  </tr>
                </thead>
                <tbody>
                  {usageRows.map((row, i) => (
                    <tr key={i}>
                      <td className="text-left pr-3 py-px">{row.label}</td>
                      <td className="text-right pr-3 py-px tabular-nums">{row.tokens.toLocaleString()}</td>
                      <td className="text-right pr-3 py-px tabular-nums">
                        {row.cost < 0.001 ? `$${row.cost.toFixed(4)}` : `$${row.cost.toFixed(3)}`}
                      </td>
                      <td className="text-right py-px tabular-nums">{(row.durationMs / 1000).toFixed(1)}s</td>
                    </tr>
                  ))}
                  <tr className="border-t border-purple-500/20 font-medium text-[var(--neg-text)]">
                    <td className="text-left pr-3 pt-0.5">Total</td>
                    <td className="text-right pr-3 pt-0.5 tabular-nums">
                      {usageRows.reduce((s, r) => s + r.tokens, 0).toLocaleString()}
                    </td>
                    <td className="text-right pr-3 pt-0.5 tabular-nums">
                      {(() => {
                        const t = usageRows.reduce((s, r) => s + r.cost, 0);
                        return t < 0.01 ? `$${t.toFixed(4)}` : `$${t.toFixed(3)}`;
                      })()}
                    </td>
                    <td className="text-right pt-0.5 tabular-nums">
                      {(Math.max(...usageRows.map((r) => r.durationMs)) / 1000).toFixed(1)}s
                    </td>
                  </tr>
                </tbody>
              </table>
            ) : (
              <span className="text-[10px] text-[var(--neg-text-muted)]">
                {totalTokens.toLocaleString()} tokens
              </span>
            )}
          </div>
          <SimpleMarkdown content={adminSummary} />
          <div className="pt-2 border-t border-purple-500/20">
            <TranscriptExport
              transcript={transcript}
              tokensUsed={totalTokens}
              tokenBudget={0}
              inline
            />
          </div>
        </div>
      )}

      {/* Final agent responses */}
      {finalResponses.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-medium text-[var(--neg-text-muted)] uppercase tracking-wider">
            Agent Responses
          </h2>
          {finalResponses.map((r) => (
            <div
              key={r.agentId}
              className={`rounded-lg border ${PROVIDER_COLORS[r.provider]} p-4`}
            >
              <div className="flex items-center gap-2 mb-2">
                <div
                  className={`w-2 h-2 rounded-full ${PROVIDER_DOT[r.provider]}`}
                />
                <span className="text-sm font-medium">
                  {agentLabels[r.agentId] || r.agentName}
                </span>
                <span className="text-xs text-[var(--neg-text-muted)]">
                  {r.model}
                </span>
              </div>
              <SimpleMarkdown content={r.content} />
            </div>
          ))}
        </div>
      )}

      {/* Synthesis */}
      {latestSynthesis && (
        <PhaseSynthesis synthesis={latestSynthesis} />
      )}

      {/* Research results */}
      {research.length > 0 && (
        <PhaseResearch
          results={research}
          streamingAgentIds={new Set()}
          streamingTexts={{}}
          agentLabels={agentLabels}
        />
      )}

      {/* Back link */}
      <div className="text-center pt-4">
        <a
          href="/negotiate"
          className="text-sm text-[var(--neg-accent)] hover:text-[var(--neg-accent)]/80 transition"
        >
          Run your own negotiation &rarr;
        </a>
      </div>
    </div>
  );
}
