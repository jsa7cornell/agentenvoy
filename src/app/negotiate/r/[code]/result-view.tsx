"use client";

import { PhaseSynthesis } from "@/components/negotiator/phase-synthesis";
import { PhaseResearch } from "@/components/negotiator/phase-research";
import { TranscriptExport } from "@/components/negotiator/transcript-export";
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
}: NegotiatorResultViewProps) {
  // Cast JSON fields to proper types
  const research = rawResearch as unknown as ResearchResult[];
  const syntheses = rawSyntheses as unknown as Synthesis[];
  const finalResponses = rawFinalResponses as unknown as FinalResponse[];

  return (
    <div className="space-y-6">
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
        <div className="rounded-lg border border-purple-500/30 bg-purple-500/5 p-4 space-y-2">
          <h2 className="text-sm font-medium text-[var(--neg-purple)] uppercase tracking-wider">
            Final Outcome
          </h2>
          <p className="text-sm leading-relaxed">{adminSummary}</p>
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
              <p className="text-sm leading-relaxed">{r.content}</p>
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
