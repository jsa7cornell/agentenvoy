"use client";

import { PhaseSynthesis } from "@/components/negotiator/phase-synthesis";
import { PhaseResearch } from "@/components/negotiator/phase-research";
import { TranscriptExport } from "@/components/negotiator/transcript-export";
import { SimpleMarkdown } from "@/components/negotiator/simple-markdown";
import { PROVIDER_COLORS, PROVIDER_DOT } from "@/lib/negotiator/provider-colors";
import type {
  ResearchResult,
  Synthesis,
  FinalResponse,
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
  createdAt: string;
  shareCode: string;
}

export function NegotiatorResultView({
  question,
  research: rawResearch,
  syntheses: rawSyntheses,
  finalResponses: rawFinalResponses,
  adminSummary,
  totalTokens,
  transcript,
  createdAt,
  shareCode,
}: NegotiatorResultViewProps) {
  // Cast JSON fields to proper types
  const research = rawResearch as unknown as ResearchResult[];
  const syntheses = rawSyntheses as unknown as Synthesis[];
  const finalResponses = rawFinalResponses as unknown as FinalResponse[];

  return (
    <div className="space-y-6">
      {/* Top CTA */}
      <div className="flex items-center justify-between">
        <p className="text-xs text-[var(--neg-text-muted)]">
          AgentNegotiator Result
        </p>
        <a
          href="/negotiate"
          className="text-sm px-4 py-1.5 rounded-lg border border-[var(--neg-accent)]/40 text-[var(--neg-accent)] hover:bg-[var(--neg-accent)]/10 transition"
        >
          Create your own &rarr;
        </a>
      </div>

      {/* Header */}
      <div>
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
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-[var(--neg-purple)] uppercase tracking-wider">
              Final Outcome
            </h2>
            <a
              href={`/negotiate/r/${shareCode}`}
              className="text-xs text-[var(--neg-accent)] hover:underline"
            >
              Shareable link →
            </a>
          </div>
          <SimpleMarkdown content={adminSummary} />
        </div>
      )}

      {/* Final agent responses */}
      {finalResponses.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-medium text-[var(--neg-text-muted)] uppercase tracking-wider">
            Final Agent Responses
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
                <span className="text-sm font-medium">{r.agentName}</span>
                <span className="text-xs text-[var(--neg-text-muted)]">
                  {r.model}
                </span>
              </div>
              <SimpleMarkdown content={r.content} />
            </div>
          ))}
        </div>
      )}

      {/* Synthesis rounds — most recent first */}
      {[...syntheses].reverse().map((s, reversedIndex) => {
        const originalIndex = syntheses.length - 1 - reversedIndex;
        return (
          <div key={originalIndex}>
            {reversedIndex > 0 && (
              <div className="border-t border-[var(--neg-border)] my-2" />
            )}
            <PhaseSynthesis
              synthesis={s}
              round={originalIndex + 1}
              prevSynthesis={
                originalIndex > 0 ? syntheses[originalIndex - 1] : undefined
              }
            />
          </div>
        );
      })}

      {/* Research results */}
      {research.length > 0 && (
        <PhaseResearch
          results={research}
          streamingAgentIds={new Set()}
          streamingTexts={{}}
        />
      )}

      {/* Transcript export */}
      <TranscriptExport
        transcript={transcript}
        tokensUsed={totalTokens}
        tokenBudget={0}
      />

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
