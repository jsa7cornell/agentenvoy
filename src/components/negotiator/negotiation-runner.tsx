"use client";

import { useState, useCallback, useRef } from "react";
import { PhaseResearch } from "./phase-research";
import { PhaseSynthesis } from "./phase-synthesis";
import { DecisionInput } from "./decision-input";
import { TranscriptExport } from "./transcript-export";
import { SimpleMarkdown } from "./simple-markdown";
import { isOverBudget, budgetPercent } from "@/lib/negotiator/token-budget";
import { PROVIDER_COLORS, PROVIDER_DOT } from "@/lib/negotiator/provider-colors";
import type {
  NegotiationConfig,
  ResearchResult,
  Synthesis,
  FinalResponse,
} from "@/lib/negotiator/types";

type RunPhase =
  | "idle"
  | "researching"
  | "synthesizing"
  | "awaiting-decision"
  | "resolving"
  | "finalizing"
  | "complete"
  | "error"
  | "budget-exceeded";

interface NegotiationRunnerProps {
  config: NegotiationConfig;
  onReset: () => void;
}

export function NegotiationRunner({ config, onReset }: NegotiationRunnerProps) {
  const [phase, setPhase] = useState<RunPhase>("idle");
  const [round, setRound] = useState(0);
  const [research, setResearch] = useState<ResearchResult[]>([]);
  const [syntheses, setSyntheses] = useState<Synthesis[]>([]);
  const [humanDecisions, setHumanDecisions] = useState<string[]>([]);
  const [hostClarifications, setHostClarifications] = useState<string[]>([]);
  const [totalTokens, setTotalTokens] = useState(0);
  const [transcript, setTranscript] = useState("");
  const [error, setError] = useState("");
  const [finalResponses, setFinalResponses] = useState<FinalResponse[]>([]);
  const [adminSummary, setAdminSummary] = useState("");
  const [shareCode, setShareCode] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);

  // Streaming state
  const [streamingIds, setStreamingIds] = useState<Set<string>>(new Set());
  const [streamingTexts, setStreamingTexts] = useState<Record<string, string>>(
    {}
  );

  const abortRef = useRef<AbortController | null>(null);

  // ─── Research phase: call all agents in parallel ────────
  const runResearch = useCallback(async () => {
    setPhase("researching");
    setRound((r) => r + 1);
    const currentRound = round + 1;

    const results: ResearchResult[] = [];
    const newStreamingTexts: Record<string, string> = {};

    const ids = new Set(config.agents.map((a) => a.id));
    config.agents.forEach((a) => {
      newStreamingTexts[a.id] = "";
      newStreamingTexts[`${a.id}_name`] = a.name;
      newStreamingTexts[`${a.id}_provider`] = a.provider;
      newStreamingTexts[`${a.id}_model`] = a.model;
    });
    setStreamingIds(ids);
    setStreamingTexts(newStreamingTexts);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      await Promise.all(
        config.agents.map(async (agent) => {
          const res = await fetch("/api/negotiator/research", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              provider: agent.provider,
              model: agent.model,
              apiKey: agent.apiKey || undefined,
              agentName: agent.name,
              agentContext: agent.context,
              sharedContext: config.sharedContext,
              question: config.question,
            }),
            signal: controller.signal,
          });

          if (!res.ok) {
            const errText = await res.text();
            throw new Error(`${agent.name} failed: ${errText}`);
          }

          const reader = res.body?.getReader();
          const decoder = new TextDecoder();
          let fullText = "";
          const agentTokens = 0;

          if (reader) {
            const STREAM_TIMEOUT = 30_000; // 30s with no data = stalled
            while (true) {
              const timeout = new Promise<{ done: true; value: undefined }>((_, reject) =>
                setTimeout(() => reject(new Error(`${agent.name} timed out (no data for 30s)`)), STREAM_TIMEOUT)
              );
              const { done, value } = await Promise.race([reader.read(), timeout]);
              if (done) break;

              const chunk = decoder.decode(value, { stream: true });
              fullText += chunk;
              setStreamingTexts((prev) => ({
                ...prev,
                [agent.id]: fullText,
              }));
            }
          }

          const result: ResearchResult = {
            agentId: agent.id,
            agentName: agent.name,
            provider: agent.provider,
            model: agent.model,
            content: fullText,
            tokensUsed: agentTokens,
          };

          results.push(result);
          setTotalTokens((t) => t + agentTokens);

          setStreamingIds((prev) => {
            const next = new Set(prev);
            next.delete(agent.id);
            return next;
          });
        })
      );

      setResearch(results);

      let txn = `# Negotiation Transcript\n\n**Question:** ${config.question}\n**Date:** ${new Date().toISOString().slice(0, 10)}\n\n`;
      txn += `---\n\n## Round ${currentRound}: Agent Positions\n\n`;
      for (const r of results) {
        txn += `### ${r.agentName} (${r.provider}/${r.model})\n\n${r.content}\n\n`;
      }
      setTranscript(txn);

      if (isOverBudget(totalTokens, config.tokenBudget)) {
        setPhase("budget-exceeded");
        return;
      }

      await runSynthesis(results, currentRound, [], [], []);
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(err instanceof Error ? err.message : "Research phase failed");
      setPhase("error");
    }
  }, [config, round, totalTokens]);

  // ─── Synthesis phase ────────────────────────────────────
  const runSynthesis = useCallback(
    async (
      researchResults: ResearchResult[],
      currentRound: number,
      priorAgreements: string[],
      decisions: string[],
      clarifications: string[]
    ) => {
      setPhase("synthesizing");

      try {
        const adminKey =
          config.agents.find((a) => a.provider === "anthropic")?.apiKey || "";

        const res = await fetch("/api/negotiator/synthesize", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            apiKey: adminKey || undefined,
            question: config.question,
            sharedContext: config.sharedContext,
            hostPrivateContext: config.hostPrivateContext,
            agents: config.agents,
            research: researchResults,
            priorAgreements,
            humanDecisions: decisions,
            hostClarifications: clarifications,
            round: currentRound,
          }),
        });

        if (!res.ok) {
          const errText = await res.text();
          throw new Error(`Synthesis failed: ${errText}`);
        }

        const data = await res.json();
        const synthesis: Synthesis = data.synthesis;
        const synthTokens: number = data.tokensUsed || 0;

        setTotalTokens((t) => t + synthTokens);
        setSyntheses((prev) => [...prev, synthesis]);

        setTranscript((prev) => {
          let txn = prev;
          txn += `---\n\n## Round ${currentRound}: Administrator Synthesis\n\n`;
          if (synthesis.agreements.length > 0) {
            txn += `**Agreements:**\n${synthesis.agreements.map((a) => `- ${a}`).join("\n")}\n\n`;
          }
          if (synthesis.disagreements.length > 0) {
            txn += `**Tensions:**\n${synthesis.disagreements.map((d) => `- **${d.topic}** (${d.type}): ${d.summary}`).join("\n")}\n\n`;
          }
          if (synthesis.decisionPoints.length > 0) {
            txn += `**Decision Points:**\n${synthesis.decisionPoints.map((dp) => `- **${dp.topic}**: ${dp.options.map((o) => `${o.label} (${o.tradeoff})`).join(" vs. ")}`).join("\n")}\n\n`;
          }
          txn += `**Summary:** ${synthesis.summary}\n\n`;
          return txn;
        });

        if (isOverBudget(totalTokens + synthTokens, config.tokenBudget)) {
          setPhase("budget-exceeded");
          return;
        }

        if (synthesis.isResolved) {
          setPhase("complete");
        } else {
          // Always pause for user input — let them respond to tensions or finalize
          setPhase("awaiting-decision");
        }
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Synthesis phase failed"
        );
        setPhase("error");
      }
    },
    [config, totalTokens]
  );

  // ─── Option A: Add context & run another round ─────────
  const handleContinue = useCallback(
    async (clarification: string) => {
      const allClarifications = clarification
        ? [...hostClarifications, clarification]
        : hostClarifications;

      setHostClarifications(allClarifications);

      setTranscript((prev) => {
        return prev + `---\n\n## Host Clarification\n\n${clarification}\n\n`;
      });

      const priorAgreements = syntheses.flatMap((s) => s.agreements);
      const nextRound = round + 1;
      setRound(nextRound);

      await runSynthesis(
        research,
        nextRound,
        priorAgreements,
        humanDecisions,
        allClarifications
      );
    },
    [hostClarifications, syntheses, round, research, humanDecisions, runSynthesis]
  );

  // ─── Option B: Make a decision & finalize ──────────────
  const handleDecide = useCallback(
    async (decisions: string[]) => {
      setPhase("finalizing");
      const allDecisions = [...humanDecisions, ...decisions];
      setHumanDecisions(allDecisions);

      setTranscript((prev) => {
        let txn = prev + `---\n\n## Final Decisions\n\n`;
        decisions.forEach((d, i) => {
          txn += `${i + 1}. ${d}\n`;
        });
        txn += "\n";
        return txn;
      });

      try {
        const latestSynth = syntheses[syntheses.length - 1];
        const res = await fetch("/api/negotiator/finalize", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agents: config.agents,
            question: config.question,
            decisions,
            decisionPoints: latestSynth.decisionPoints,
          }),
        });

        if (!res.ok) throw new Error(await res.text());
        const data = await res.json();

        setFinalResponses(data.responses);
        setAdminSummary(data.adminSummary);
        setTotalTokens((t) => t + (data.tokensUsed || 0));

        setTranscript((prev) => {
          let txn = prev + `---\n\n## Final Agent Responses\n\n`;
          for (const r of data.responses) {
            txn += `### ${r.agentName}\n${r.content}\n\n`;
          }
          txn += `---\n\n## Final Outcome\n\n${data.adminSummary}\n\n`;
          return txn;
        });

        setPhase("complete");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Finalization failed");
        setPhase("error");
      }
    },
    [config, humanDecisions, syntheses]
  );

  // ─── Share results ─────────────────────────────────────
  const handleShare = useCallback(async () => {
    if (shareCode || sharing) return;
    setSharing(true);
    try {
      const res = await fetch("/api/negotiator/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: config.question,
          agents: config.agents,
          research,
          syntheses,
          humanDecisions,
          hostClarifications,
          finalResponses,
          adminSummary,
          totalTokens,
          transcript,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setShareCode(data.shareCode);
      const url = `${window.location.origin}/negotiate/r/${data.shareCode}`;
      await navigator.clipboard.writeText(url);
    } catch {
      // Non-blocking — share is optional
    } finally {
      setSharing(false);
    }
  }, [shareCode, sharing, config, research, syntheses, humanDecisions, hostClarifications, finalResponses, adminSummary, totalTokens, transcript]);

  // ─── Start the negotiation ─────────────────────────────
  const start = useCallback(() => {
    setPhase("idle");
    setRound(0);
    setResearch([]);
    setSyntheses([]);
    setHumanDecisions([]);
    setHostClarifications([]);
    setTotalTokens(0);
    setTranscript("");
    setError("");
    setStreamingIds(new Set());
    setStreamingTexts({});
    setFinalResponses([]);
    setAdminSummary("");
    setShareCode(null);
    setSharing(false);
    runResearch();
  }, [runResearch]);

  // Auto-start on mount
  const startedRef = useRef(false);
  if (!startedRef.current) {
    startedRef.current = true;
    setTimeout(start, 0);
  }

  // ─── Render ─────────────────────────────────────────────
  const latestSynthesis = syntheses[syntheses.length - 1];
  const pct = budgetPercent(totalTokens, config.tokenBudget);

  return (
    <div className="space-y-6">
      {/* Token budget bar + top actions */}
      <div className="flex items-center gap-3">
        <div className="flex-1 h-2 rounded-full bg-[var(--neg-surface-2)] overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-500 ${
              pct > 90
                ? "bg-[var(--neg-red)]"
                : pct > 60
                  ? "bg-[var(--neg-yellow)]"
                  : "bg-[var(--neg-accent)]"
            }`}
            style={{ width: `${pct}%` }}
          />
        </div>
        <span className="text-xs text-[var(--neg-text-muted)] whitespace-nowrap">
          {totalTokens.toLocaleString()} / {(config.tokenBudget / 1000).toFixed(0)}k tokens
        </span>
        <button
          onClick={onReset}
          className="text-xs text-[var(--neg-text-muted)] hover:text-[var(--neg-text)] transition whitespace-nowrap"
        >
          New ↺
        </button>
      </div>

      {/* Share + transcript actions — shown as soon as there's content */}
      {transcript && (
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={handleShare}
            disabled={sharing || !!shareCode}
            className="px-3 py-1.5 rounded border border-[var(--neg-accent)]/40 text-xs text-[var(--neg-accent)] hover:bg-[var(--neg-accent)]/10 transition disabled:opacity-50"
          >
            {sharing ? "Saving..." : shareCode ? "✓ Shared" : "Share Results"}
          </button>
          {shareCode && (
            <a
              href={`/negotiate/r/${shareCode}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-[var(--neg-text-muted)] hover:text-[var(--neg-accent)] underline underline-offset-2 transition"
            >
              {typeof window !== "undefined" ? `${window.location.origin}/negotiate/r/${shareCode}` : `/negotiate/r/${shareCode}`}
            </a>
          )}
          <div className="flex items-center gap-2 ml-auto">
            <TranscriptExport
              transcript={transcript}
              tokensUsed={totalTokens}
              tokenBudget={config.tokenBudget}
              models={config.agents.map((a) => a.model)}
              inline
            />
          </div>
        </div>
      )}

      {/* Final outcome */}
      {adminSummary && (
        <div className="rounded-lg border border-purple-500/30 bg-purple-500/5 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-[var(--neg-purple)] uppercase tracking-wider">
              Final Outcome
            </h2>
            {shareCode && (
              <a
                href={`/negotiate/r/${shareCode}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-[var(--neg-accent)] hover:underline"
              >
                Shareable link →
              </a>
            )}
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
            <div key={r.agentId} className={`rounded-lg border ${PROVIDER_COLORS[r.provider]} p-4`}>
              <div className="flex items-center gap-2 mb-2">
                <div className={`w-2 h-2 rounded-full ${PROVIDER_DOT[r.provider]}`} />
                <span className="text-sm font-medium">{r.agentName}</span>
                <span className="text-xs text-[var(--neg-text-muted)]">{r.model}</span>
              </div>
              <SimpleMarkdown content={r.content} />
            </div>
          ))}
        </div>
      )}

      {/* Awaiting decision */}
      {phase === "awaiting-decision" && latestSynthesis && (
        <DecisionInput
          synthesis={latestSynthesis}
          onContinue={handleContinue}
          onDecide={handleDecide}
        />
      )}

      {/* Synthesis phases — most recent first */}
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
              prevSynthesis={originalIndex > 0 ? syntheses[originalIndex - 1] : undefined}
            />
          </div>
        );
      })}

      {/* Research phase */}
      {(phase === "researching" || research.length > 0) && (
        <PhaseResearch
          results={research}
          streamingAgentIds={streamingIds}
          streamingTexts={streamingTexts}
        />
      )}

      {/* Synthesizing spinner */}
      {phase === "synthesizing" && (
        <div className="flex items-center gap-2 text-sm text-[var(--neg-text-muted)]">
          <div className="w-2 h-2 rounded-full bg-[var(--neg-purple)] animate-pulse" />
          Administrator synthesizing positions...
        </div>
      )}

      {/* Finalizing spinner */}
      {phase === "finalizing" && (
        <div className="flex items-center gap-2 text-sm text-[var(--neg-text-muted)]">
          <div className="w-2 h-2 rounded-full bg-[var(--neg-accent)] animate-pulse" />
          Collecting final agent responses...
        </div>
      )}

      {/* Resolving */}
      {phase === "resolving" && (
        <div className="flex items-center gap-2 text-sm text-[var(--neg-text-muted)]">
          <div className="w-2 h-2 rounded-full bg-[var(--neg-accent)] animate-pulse" />
          Incorporating your decisions...
        </div>
      )}

      {/* Budget exceeded */}
      {phase === "budget-exceeded" && (
        <div className="rounded-lg border border-yellow-500/20 bg-yellow-500/5 p-4 text-sm">
          <span className="font-medium text-[var(--neg-yellow)]">
            Token budget reached.
          </span>{" "}
          Showing results so far. You can copy the transcript or start a new
          negotiation with a higher budget.
        </div>
      )}

      {/* Error */}
      {phase === "error" && (
        <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-4 text-sm">
          <span className="font-medium text-[var(--neg-red)]">Error:</span> {error}
        </div>
      )}

    </div>
  );
}
