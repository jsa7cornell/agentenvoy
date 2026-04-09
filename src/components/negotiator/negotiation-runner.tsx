"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { PhaseResearch } from "./phase-research";
import { PhaseSynthesis } from "./phase-synthesis";
import { DecisionInput } from "./decision-input";
import { TranscriptExport } from "./transcript-export";
import { SimpleMarkdown } from "./simple-markdown";
import { NegotiatorLogo } from "./negotiator-logo";
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
  const [synthesis, setSynthesis] = useState<Synthesis | null>(null);
  const [totalTokens, setTotalTokens] = useState(0);
  const [transcript, setTranscript] = useState("");
  const [error, setError] = useState("");
  const [finalResponses, setFinalResponses] = useState<FinalResponse[]>([]);
  const [adminSummary, setAdminSummary] = useState("");
  const [shareCode, setShareCode] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- used in error display section
  const [agentErrors, setAgentErrors] = useState<Record<string, string>>({});
  const [hostClarifications, setHostClarifications] = useState<string[]>([]);

  // Streaming state
  const [streamingIds, setStreamingIds] = useState<Set<string>>(new Set());
  const [streamingTexts, setStreamingTexts] = useState<Record<string, string>>(
    {}
  );

  const abortRef = useRef<AbortController | null>(null);

  // ─── Research phase: call all agents in parallel ────────
  const runResearch = useCallback(async (
    currentRound: number,
    additionalContext?: string,
  ) => {
    setPhase("researching");

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

    const newAgentErrors: Record<string, string> = {};

    // Build question with any additional context from host
    const fullQuestion = additionalContext
      ? `${config.question}\n\n## Host Feedback (Round ${currentRound})\n${additionalContext}`
      : config.question;

    await Promise.all(
      config.agents.map(async (agent) => {
        try {
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
              question: fullQuestion,
            }),
            signal: controller.signal,
          });

          if (!res.ok) {
            const errText = await res.text();
            throw new Error(`HTTP ${res.status}: ${errText}`);
          }

          const reader = res.body?.getReader();
          const decoder = new TextDecoder();
          let fullText = "";

          if (reader) {
            const STREAM_TIMEOUT = 60_000;
            while (true) {
              const timeout = new Promise<{ done: true; value: undefined }>((_, reject) =>
                setTimeout(() => reject(new Error(`No response for 60s — the model may be overloaded. Try a faster model (gpt-4o-mini) or retry.`)), STREAM_TIMEOUT)
              );
              const { done, value } = await Promise.race([reader.read(), timeout]);
              if (done) break;
              const chunk = decoder.decode(value, { stream: true });
              fullText += chunk;
              setStreamingTexts((prev) => ({ ...prev, [agent.id]: fullText }));
            }
          }

          const trimmed = fullText.trim();
          if (trimmed.startsWith("[Error:") || trimmed.length < 20) {
            const errMsg = trimmed.startsWith("[Error:")
              ? trimmed.replace(/^\[Error:\s*/, "").replace(/\]$/, "")
              : "Empty response — check your API key and model availability.";
            newAgentErrors[agent.id] = errMsg;
            setStreamingTexts((prev) => ({
              ...prev,
              [agent.id]: `⚠️ ${errMsg}`,
            }));
          } else {
            results.push({
              agentId: agent.id,
              agentName: agent.name,
              provider: agent.provider,
              model: agent.model,
              content: fullText,
              tokensUsed: 0,
            });
          }
        } catch (err) {
          if (controller.signal.aborted) return;
          const msg = err instanceof Error ? err.message : String(err);
          newAgentErrors[agent.id] = msg;
          setStreamingTexts((prev) => ({ ...prev, [agent.id]: `⚠️ ${msg}` }));
        } finally {
          setStreamingIds((prev) => {
            const next = new Set(prev);
            next.delete(agent.id);
            return next;
          });
        }
      })
    );

    if (controller.signal.aborted) return;

    if (Object.keys(newAgentErrors).length > 0) {
      setAgentErrors(newAgentErrors);
      setResearch(results);
      setPhase("error");
      const names = config.agents
        .filter((a) => newAgentErrors[a.id])
        .map((a) => `${a.name} (${a.model})`)
        .join(", ");
      setError(`${Object.keys(newAgentErrors).length} agent(s) failed: ${names}`);
      return;
    }

    setResearch(results);
    setAgentErrors({});

    setTranscript((prev) => {
      let txn = prev || `# Negotiation Transcript\n\n**Question:** ${config.question}\n**Date:** ${new Date().toISOString().slice(0, 10)}\n\n`;
      txn += `---\n\n## Round ${currentRound}: Agent Proposals\n\n`;
      for (const r of results) {
        txn += `### ${r.agentName} (${r.provider}/${r.model})\n\n${r.content}\n\n`;
      }
      return txn;
    });

    if (isOverBudget(totalTokens, config.tokenBudget)) {
      setPhase("budget-exceeded");
      return;
    }

    // Run synthesis
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
          research: results,
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Synthesis failed: ${errText}`);
      }

      const data = await res.json();
      const synth: Synthesis = data.synthesis;
      const synthTokens: number = data.tokensUsed || 0;

      setTotalTokens((t) => t + synthTokens);
      setSynthesis(synth);

      setTranscript((prev) => {
        let txn = prev + `---\n\n## Round ${currentRound}: Administrator Synthesis\n\n`;
        txn += `**Summary:** ${synth.summary}\n\n`;
        if (synth.commonGround.length > 0) {
          txn += `**Common Ground:**\n${synth.commonGround.map((a) => `- ${a}`).join("\n")}\n\n`;
        }
        const recLabel = synth.agentLabels?.[synth.recommendation.agentId] || synth.recommendation.agentId;
        txn += `**Recommendation:** Follow ${recLabel} — ${synth.recommendation.reasoning}\n\n`;
        return txn;
      });

      setPhase("awaiting-decision");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Synthesis failed");
      setPhase("error");
    }
  }, [config, totalTokens]);

  // ─── Option A: Pick agent & finalize ──────────────────
  const handleFinalize = useCallback(
    async (agentId: string, requests: string, clarification: string) => {
      setPhase("finalizing");

      const agentName = synthesis?.agentLabels?.[agentId] ||
        config.agents.find((a) => a.id === agentId)?.name || agentId;

      setTranscript((prev) => {
        let txn = prev + `---\n\n## Decision\n\nSelected: ${agentName}\n`;
        if (requests) txn += `Requests: ${requests}\n`;
        if (clarification) txn += `Clarification: ${clarification}\n`;
        txn += "\n";
        return txn;
      });

      try {
        const res = await fetch("/api/negotiator/finalize", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agents: config.agents,
            question: config.question,
            chosenAgentId: agentId,
            requests: requests || undefined,
            clarification: clarification || undefined,
          }),
        });

        if (!res.ok) throw new Error(await res.text());
        const data = await res.json();

        setFinalResponses(data.responses || []);
        setAdminSummary(data.adminSummary);
        setTotalTokens((t) => t + (data.tokensUsed || 0));

        setTranscript((prev) => {
          let txn = prev;
          if (data.responses?.length > 0) {
            txn += `---\n\n## Final Responses\n\n`;
            for (const r of data.responses) {
              txn += `### ${r.agentName}\n${r.content}\n\n`;
            }
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
    [config, synthesis]
  );

  // ─── Option B: Another round with all agents ──────────
  const handleAnotherRound = useCallback(
    async (requests: string, clarification: string) => {
      const parts: string[] = [];
      if (requests) parts.push(requests);
      if (clarification) parts.push(clarification);
      const additionalContext = parts.join("\n\n");

      if (additionalContext) {
        setHostClarifications((prev) => [...prev, additionalContext]);
      }

      setTranscript((prev) => {
        let txn = prev + `---\n\n## Host: Another Round\n\n`;
        if (requests) txn += `Requests: ${requests}\n`;
        if (clarification) txn += `Clarification: ${clarification}\n`;
        txn += "\n";
        return txn;
      });

      const nextRound = round + 1;
      setRound(nextRound);

      await runResearch(nextRound, additionalContext || undefined);
    },
    [round, runResearch]
  );

  // ─── Auto-save when complete ────────────────────────────
  useEffect(() => {
    if (phase !== "complete" || shareCode || sharing || !transcript) return;
    setSharing(true);
    fetch("/api/negotiator/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question: config.question,
        agents: config.agents,
        research,
        syntheses: synthesis ? [synthesis] : [],
        humanDecisions: [],
        hostClarifications,
        finalResponses,
        adminSummary,
        totalTokens,
        transcript,
      }),
    })
      .then((r) => r.json())
      .then((data) => setShareCode(data.shareCode))
      .catch(() => {/* non-blocking */})
      .finally(() => setSharing(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  // ─── Start the negotiation ─────────────────────────────
  const start = useCallback(() => {
    setPhase("idle");
    setRound(1);
    setResearch([]);
    setSynthesis(null);
    setTotalTokens(0);
    setTranscript("");
    setError("");
    setStreamingIds(new Set());
    setStreamingTexts({});
    setFinalResponses([]);
    setAdminSummary("");
    setShareCode(null);
    setSharing(false);
    setAgentErrors({});
    setHostClarifications([]);
    runResearch(1);
  }, [runResearch]);

  // Auto-start on mount
  const startedRef = useRef(false);
  if (!startedRef.current) {
    startedRef.current = true;
    setTimeout(start, 0);
  }

  // ─── Render ─────────────────────────────────────────────
  const pct = budgetPercent(totalTokens, config.tokenBudget);
  const agentLabels = synthesis?.agentLabels ?? {};

  return (
    <div className="space-y-6">
      {/* Status bar with animated logo */}
      <div className="flex items-center gap-3">
        <NegotiatorLogo
          mode={
            phase === "researching" || phase === "finalizing" ? "debating"
            : phase === "synthesizing" ? "synthesizing"
            : phase === "complete" ? "complete"
            : "idle"
          }
          size={32}
          className="shrink-0 text-[var(--neg-text-muted)]"
        />
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
          {round > 1 ? `R${round} · ` : ""}{totalTokens.toLocaleString()} / {(config.tokenBudget / 1000).toFixed(0)}k tokens
        </span>
        <button
          onClick={onReset}
          className="text-xs text-[var(--neg-text-muted)] hover:text-[var(--neg-text)] transition whitespace-nowrap"
        >
          New ↺
        </button>
      </div>

      {/* Share bar — auto-appears when saved */}
      {(transcript || shareCode) && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg bg-[var(--neg-surface-2)] border border-[var(--neg-border)] px-3 py-2">
          {shareCode ? (
            <>
              <span className="text-xs text-[var(--neg-text-muted)]">Shareable link:</span>
              <a
                href={`/negotiate/r/${shareCode}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-[var(--neg-accent)] hover:underline font-medium"
              >
                {typeof window !== "undefined"
                  ? `${window.location.origin}/negotiate/r/${shareCode}`
                  : `/negotiate/r/${shareCode}`}
              </a>
            </>
          ) : (
            <span className="text-xs text-[var(--neg-text-muted)] italic">
              {sharing ? "Saving..." : "Saving results..."}
            </span>
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
          <h2 className="text-sm font-medium text-[var(--neg-purple)] uppercase tracking-wider">
            Final Outcome
          </h2>
          <SimpleMarkdown content={adminSummary} />
        </div>
      )}

      {/* Final agent responses */}
      {finalResponses.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-medium text-[var(--neg-text-muted)] uppercase tracking-wider">
            Agent Responses
          </h2>
          {finalResponses.map((r) => (
            <div key={r.agentId} className={`rounded-lg border ${PROVIDER_COLORS[r.provider]} p-4`}>
              <div className="flex items-center gap-2 mb-2">
                <div className={`w-2 h-2 rounded-full ${PROVIDER_DOT[r.provider]}`} />
                <span className="text-sm font-medium">
                  {agentLabels[r.agentId] || r.agentName}
                </span>
                <span className="text-xs text-[var(--neg-text-muted)]">{r.model}</span>
              </div>
              <SimpleMarkdown content={r.content} />
            </div>
          ))}
        </div>
      )}

      {/* Awaiting decision — AFTER synthesis */}
      {phase === "awaiting-decision" && synthesis && (
        <>
          <PhaseSynthesis synthesis={synthesis} />
          <DecisionInput
            synthesis={synthesis}
            onFinalize={handleFinalize}
            onAnotherRound={handleAnotherRound}
            round={round}
          />
        </>
      )}

      {/* Synthesis only (when complete, show without decision input) */}
      {phase === "complete" && synthesis && (
        <PhaseSynthesis synthesis={synthesis} />
      )}

      {/* Research phase */}
      {(phase === "researching" || research.length > 0) && (
        <PhaseResearch
          results={research}
          streamingAgentIds={streamingIds}
          streamingTexts={streamingTexts}
          agentLabels={agentLabels}
        />
      )}

      {/* Synthesizing */}
      {phase === "synthesizing" && (
        <div className="flex items-center gap-3 text-sm text-[var(--neg-text-muted)]">
          <NegotiatorLogo mode="synthesizing" size={28} />
          Administrator comparing proposals...
        </div>
      )}

      {/* Finalizing */}
      {phase === "finalizing" && (
        <div className="flex items-center gap-3 text-sm text-[var(--neg-text-muted)]">
          <NegotiatorLogo mode="debating" size={28} />
          Finalizing — selected agent refining, others responding...
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
        <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-4 space-y-3">
          <div className="text-sm">
            <span className="font-medium text-[var(--neg-red)]">Error:</span> {error}
          </div>
          {Object.keys(agentErrors).length > 0 && (
            <div className="space-y-2">
              {config.agents
                .filter((a) => agentErrors[a.id])
                .map((a) => (
                  <div key={a.id} className="text-xs rounded bg-red-500/10 border border-red-500/20 px-3 py-2">
                    <span className="font-medium text-[var(--neg-red)]">{a.name} ({a.model})</span>
                    <span className="text-[var(--neg-text-muted)] ml-2">{agentErrors[a.id]}</span>
                  </div>
                ))}
              <p className="text-xs text-[var(--neg-text-muted)]">
                Common fixes: check your API key is valid and has credits, or switch to a different model (gpt-4o-mini is most reliable).
              </p>
            </div>
          )}
          <button
            onClick={() => {
              setPhase("idle");
              setError("");
              setAgentErrors({});
              setResearch([]);
              setStreamingIds(new Set());
              setStreamingTexts({});
              runResearch(round);
            }}
            className="px-4 py-2 rounded-lg bg-[var(--neg-accent)] text-black font-semibold text-sm hover:bg-[var(--neg-accent)]/90 transition"
          >
            Retry
          </button>
        </div>
      )}

    </div>
  );
}
