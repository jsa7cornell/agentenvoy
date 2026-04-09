"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { PhaseResearch } from "./phase-research";
import { PhaseSynthesis } from "./phase-synthesis";
import { DecisionInput } from "./decision-input";
import { TranscriptExport } from "./transcript-export";
import { SimpleMarkdown } from "./simple-markdown";
import { NegotiatorLogo } from "./negotiator-logo";
import { isOverBudget } from "@/lib/negotiator/token-budget";
import { PROVIDER_COLORS, PROVIDER_DOT } from "@/lib/negotiator/provider-colors";
import { estimateCost } from "@/lib/negotiator/types";
import type {
  NegotiationConfig,
  ResearchResult,
  Synthesis,
  FinalResponse,
  UsageRow,
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

// ─── Progress bar config ─────────────────────────────────
const STEPS = [
  { key: "researching",       label: "Proposals" },
  { key: "synthesizing",      label: "Synthesis" },
  { key: "awaiting-decision", label: "Decision" },
  { key: "finalizing",        label: "Finalize" },
  { key: "complete",          label: "Done" },
] as const;

const PHASE_STATUS: Record<string, { text: string; stepIndex: number }> = {
  idle:               { text: "Starting",                          stepIndex: -1 },
  researching:        { text: "Agents writing proposals",          stepIndex: 0 },
  synthesizing:       { text: "Administrator comparing proposals", stepIndex: 1 },
  "awaiting-decision":{ text: "Waiting for your decision",         stepIndex: 2 },
  finalizing:         { text: "Agents responding to decision",     stepIndex: 3 },
  complete:           { text: "Complete",                           stepIndex: 4 },
  error:              { text: "Error",                              stepIndex: -1 },
  "budget-exceeded":  { text: "Budget exceeded",                    stepIndex: -1 },
};

/** Generate a label from agent context, e.g. "Agent 1: Speed and Pragmatism" */
function interimLabel(index: number, context: string, fallback: string): string {
  if (!context || context.trim().split(/\s+/).length < 3) return fallback;
  const cleaned = context
    .replace(/^(prioritize|focus on|advocate for|push for|you should|argue for|emphasize)\s+/i, "")
    .trim();
  // Title-case the first 3 meaningful words
  const words = cleaned.split(/\s+/).filter((w) => w.length > 1).slice(0, 3);
  const title = words.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ");
  return `Agent ${index + 1}: ${title}`;
}

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
  const [phaseStartTime, setPhaseStartTime] = useState<number>(Date.now());
  const [usageRows, setUsageRows] = useState<UsageRow[]>([]);

  // Streaming state
  const [streamingIds, setStreamingIds] = useState<Set<string>>(new Set());
  const [streamingTexts, setStreamingTexts] = useState<Record<string, string>>(
    {}
  );

  const abortRef = useRef<AbortController | null>(null);

  // Build the full shareable URL
  const shareUrl = shareCode
    ? typeof window !== "undefined"
      ? `${window.location.origin}/negotiate/r/${shareCode}`
      : `/negotiate/r/${shareCode}`
    : null;

  // Track phase start for elapsed timer
  useEffect(() => {
    setPhaseStartTime(Date.now());
  }, [phase]);

  // Elapsed time display
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (phase === "awaiting-decision" || phase === "complete" || phase === "error") return;
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - phaseStartTime) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [phase, phaseStartTime]);

  // ─── Research phase: call all agents in parallel ────────
  const runResearch = useCallback(async (
    currentRound: number,
    additionalContext?: string,
  ) => {
    setPhase("researching");

    const results: ResearchResult[] = [];
    const newStreamingTexts: Record<string, string> = {};

    const ids = new Set(config.agents.map((a) => a.id));
    config.agents.forEach((a, i) => {
      newStreamingTexts[a.id] = "";
      newStreamingTexts[`${a.id}_name`] = interimLabel(i, a.context, a.name);
      newStreamingTexts[`${a.id}_provider`] = a.provider;
      newStreamingTexts[`${a.id}_model`] = a.model;
    });
    setStreamingIds(ids);
    setStreamingTexts(newStreamingTexts);

    const controller = new AbortController();
    abortRef.current = controller;

    const newAgentErrors: Record<string, string> = {};

    const fullQuestion = additionalContext
      ? `${config.question}\n\n## Host Feedback (Round ${currentRound})\n${additionalContext}`
      : config.question;

    const agentUsageRows: UsageRow[] = [];

    await Promise.all(
      config.agents.map(async (agent) => {
        const agentStart = Date.now();
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
            // Estimate tokens from text length (~4 chars/token)
            const estTokens = Math.round(fullText.length / 4);
            results.push({
              agentId: agent.id,
              agentName: agent.name,
              provider: agent.provider,
              model: agent.model,
              content: fullText,
              tokensUsed: estTokens,
            });
            agentUsageRows.push({
              label: agent.name,
              model: agent.model,
              tokens: estTokens,
              cost: estimateCost(estTokens, agent.model),
              durationMs: Date.now() - agentStart,
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

    // Record agent usage rows
    setUsageRows((prev) => [...prev, ...agentUsageRows]);

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
    const synthStart = Date.now();
    try {
      const adminKey =
        config.agents.find((a) => a.provider === "anthropic")?.apiKey || "";

      const res = await fetch("/api/negotiator/synthesize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiKey: adminKey || undefined,
          model: config.adminModel,
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
      setUsageRows((prev) => [...prev, {
        label: "Administrator",
        model: config.adminModel,
        tokens: synthTokens,
        cost: estimateCost(synthTokens, config.adminModel),
        durationMs: Date.now() - synthStart,
      }]);

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
    async (agentId: string, feedback: string) => {
      setPhase("finalizing");

      const agentName = synthesis?.agentLabels?.[agentId] ||
        config.agents.find((a) => a.id === agentId)?.name || agentId;

      setTranscript((prev) => {
        let txn = prev + `---\n\n## Decision\n\nSelected: ${agentName}\n`;
        if (feedback) txn += `Feedback: ${feedback}\n`;
        txn += "\n";
        return txn;
      });

      const finalizeStart = Date.now();
      try {
        const res = await fetch("/api/negotiator/finalize", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agents: config.agents,
            question: config.question,
            chosenAgentId: agentId,
            feedback: feedback || undefined,
            adminModel: config.adminModel,
          }),
        });

        if (!res.ok) throw new Error(await res.text());
        const data = await res.json();

        setFinalResponses(data.responses || []);
        setAdminSummary(data.adminSummary);
        const finalizeTokens = data.tokensUsed || 0;
        setTotalTokens((t) => t + finalizeTokens);
        setUsageRows((prev) => [...prev, {
          label: "Finalize",
          model: config.adminModel,
          tokens: finalizeTokens,
          cost: estimateCost(finalizeTokens, config.adminModel),
          durationMs: Date.now() - finalizeStart,
        }]);

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
    async (feedback: string) => {
      if (feedback) {
        setHostClarifications((prev) => [...prev, feedback]);
      }

      setTranscript((prev) => {
        let txn = prev + `---\n\n## Host: Another Round\n\n`;
        if (feedback) txn += `Feedback: ${feedback}\n`;
        txn += "\n";
        return txn;
      });

      const nextRound = round + 1;
      setRound(nextRound);

      await runResearch(nextRound, feedback || undefined);
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
        usageRows,
      }),
    })
      .then((r) => r.json())
      .then((data) => {
        setShareCode(data.shareCode);
        // Update the browser URL to the result page
        if (data.shareCode && typeof window !== "undefined") {
          window.history.pushState(null, "", `/negotiate/r/${data.shareCode}`);
        }
      })
      .catch(() => {/* non-blocking */})
      .finally(() => setSharing(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  // ─── Append share URL to transcript when available ─────
  useEffect(() => {
    if (!shareUrl) return;
    setTranscript((prev) => {
      if (prev.includes(shareUrl)) return prev;
      return prev + `---\n\n**Shareable link:** ${shareUrl}\n`;
    });
  }, [shareUrl]);

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
    setUsageRows([]);
    runResearch(1);
  }, [runResearch]);

  // Auto-start on mount
  const startedRef = useRef(false);
  if (!startedRef.current) {
    startedRef.current = true;
    setTimeout(start, 0);
  }

  // ─── Render ─────────────────────────────────────────────
  // Build agent labels: interim context-based labels, overridden by admin once synthesis exists
  const agentLabels: Record<string, string> = {};
  config.agents.forEach((a, i) => {
    agentLabels[a.id] = interimLabel(i, a.context, a.name);
  });
  if (synthesis?.agentLabels) {
    Object.assign(agentLabels, synthesis.agentLabels);
  }
  const status = PHASE_STATUS[phase] || PHASE_STATUS.idle;
  const completedAgents = config.agents.length - streamingIds.size;
  const isActive = phase !== "complete" && phase !== "error" && phase !== "budget-exceeded" && phase !== "awaiting-decision";

  return (
    <div className="space-y-6">
      {/* Progress header */}
      <div className="space-y-3">
        {/* Title + status text + New button */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <NegotiatorLogo
              mode={
                phase === "researching" || phase === "finalizing" ? "debating"
                : phase === "synthesizing" ? "synthesizing"
                : phase === "complete" ? "complete"
                : "idle"
              }
              size={20}
              className="shrink-0 text-[var(--neg-text-muted)]"
            />
            <span className="text-sm text-[var(--neg-text)] truncate">
              {status.text}
              {phase === "researching" && completedAgents < config.agents.length
                ? ` (${completedAgents}/${config.agents.length})`
                : ""}
              {isActive && <span className="animate-pulse">...</span>}
              {elapsed > 0 && isActive && (
                <span className="text-[var(--neg-text-muted)] ml-1.5">{elapsed}s</span>
              )}
              {round > 1 && (
                <span className="text-[var(--neg-text-muted)] ml-1.5">· Round {round}</span>
              )}
            </span>
          </div>
          <button
            onClick={onReset}
            className="text-xs text-[var(--neg-text-muted)] hover:text-[var(--neg-text)] transition whitespace-nowrap shrink-0 ml-3"
          >
            New ↺
          </button>
        </div>

        {/* Segmented step progress */}
        <div className="flex gap-1">
          {STEPS.map((step, i) => {
            const isDone = status.stepIndex > i;
            const isCurrent = status.stepIndex === i;
            return (
              <div key={step.key} className="flex-1 space-y-1">
                <div
                  className={`h-1.5 rounded-full transition-all duration-500 ${
                    isDone
                      ? "bg-[var(--neg-green)]"
                      : isCurrent
                        ? phase === "error"
                          ? "bg-[var(--neg-red)]"
                          : "bg-[var(--neg-accent)] animate-pulse"
                        : "bg-[var(--neg-surface-2)]"
                  }`}
                />
                <span
                  className={`block text-center text-[10px] leading-tight transition-colors ${
                    isDone
                      ? "text-[var(--neg-green)]"
                      : isCurrent
                        ? "text-[var(--neg-text)] font-medium"
                        : "text-[var(--neg-text-muted)]/50"
                  }`}
                >
                  {step.label}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Final outcome — usage stats table + summary + transcript */}
      {adminSummary && (
        <div className="rounded-lg border border-purple-500/30 bg-purple-500/5 p-4 space-y-3">
          <div className="flex items-start justify-between gap-4">
            <h2 className="text-sm font-medium text-[var(--neg-purple)] uppercase tracking-wider shrink-0 pt-0.5">
              Final Outcome
            </h2>
            {/* Usage stats mini-table */}
            {usageRows.length > 0 && (
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
            )}
          </div>
          <SimpleMarkdown content={adminSummary} />
          {/* Share + transcript export at bottom */}
          <div className="pt-2 border-t border-purple-500/20 flex flex-wrap items-center gap-2">
            <TranscriptExport
              transcript={transcript}
              tokensUsed={totalTokens}
              tokenBudget={config.tokenBudget}
              inline
            />
            {shareUrl && (
              <a
                href={shareUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="px-3 py-1.5 rounded border border-[var(--neg-border)] text-xs hover:bg-[var(--neg-surface-2)] transition"
              >
                Share
              </a>
            )}
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

      {/* Synthesizing placeholder */}
      {phase === "synthesizing" && (
        <div className="rounded-lg border border-purple-500/20 bg-purple-500/5 p-6">
          <div className="flex items-center gap-3">
            <NegotiatorLogo mode="synthesizing" size={24} className="shrink-0" />
            <div>
              <h2 className="text-sm font-medium text-[var(--neg-purple)]">
                Administrator Synthesis
              </h2>
              <p className="text-xs text-[var(--neg-text-muted)] mt-0.5">
                Comparing proposals and preparing recommendation<span className="animate-pulse">...</span>
              </p>
            </div>
          </div>
          <div className="mt-4 space-y-2">
            <div className="h-3 bg-purple-500/10 rounded animate-pulse w-full" />
            <div className="h-3 bg-purple-500/10 rounded animate-pulse w-4/5" />
            <div className="h-3 bg-purple-500/10 rounded animate-pulse w-3/5" />
          </div>
        </div>
      )}

      {/* Finalizing placeholder */}
      {phase === "finalizing" && (
        <div className="rounded-lg border border-purple-500/20 bg-purple-500/5 p-6">
          <div className="flex items-center gap-3">
            <NegotiatorLogo mode="debating" size={24} className="shrink-0" />
            <div>
              <h2 className="text-sm font-medium text-[var(--neg-purple)]">
                Final Outcome
              </h2>
              <p className="text-xs text-[var(--neg-text-muted)] mt-0.5">
                Selected agent refining proposal, others responding<span className="animate-pulse">...</span>
              </p>
            </div>
          </div>
          <div className="mt-4 space-y-2">
            <div className="h-3 bg-purple-500/10 rounded animate-pulse w-full" />
            <div className="h-3 bg-purple-500/10 rounded animate-pulse w-3/4" />
            <div className="h-3 bg-purple-500/10 rounded animate-pulse w-5/6" />
          </div>
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
