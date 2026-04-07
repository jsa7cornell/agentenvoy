"use client";

import type { ResearchResult, ModelProvider } from "@/lib/negotiator/types";
import { PROVIDER_COLORS, PROVIDER_DOT } from "@/lib/negotiator/provider-colors";

interface PhaseResearchProps {
  results: ResearchResult[];
  streamingAgentIds: Set<string>;
  streamingTexts: Record<string, string>;
}

export function PhaseResearch({
  results,
  streamingAgentIds,
  streamingTexts,
}: PhaseResearchProps) {
  const allAgents = [
    ...results.map((r) => ({
      id: r.agentId,
      name: r.agentName,
      provider: r.provider,
      model: r.model,
      content: r.content,
      tokens: r.tokensUsed,
      streaming: false,
    })),
    ...Array.from(streamingAgentIds)
      .filter((id) => !results.find((r) => r.agentId === id))
      .map((id) => ({
        id,
        name: streamingTexts[`${id}_name`] || id,
        provider: (streamingTexts[`${id}_provider`] || "anthropic") as ModelProvider,
        model: streamingTexts[`${id}_model`] || "",
        content: streamingTexts[id] || "",
        tokens: 0,
        streaming: true,
      })),
  ];

  if (allAgents.length === 0) return null;

  return (
    <div className="space-y-4">
      <h2 className="text-sm font-medium text-[var(--neg-text-muted)] uppercase tracking-wider">
        Phase 1: Independent Research
      </h2>
      <div className="grid grid-cols-1 gap-4">
        {allAgents.map((agent) => (
          <div
            key={agent.id}
            className={`rounded-lg border ${PROVIDER_COLORS[agent.provider]} p-4`}
          >
            <div className="flex items-center gap-2 mb-2">
              <div
                className={`w-2 h-2 rounded-full ${PROVIDER_DOT[agent.provider]} ${agent.streaming ? "animate-pulse" : ""}`}
              />
              <span className="text-sm font-medium">{agent.name}</span>
              <span className="text-xs text-[var(--neg-text-muted)]">
                {agent.model}
              </span>
              {agent.tokens > 0 && (
                <span className="text-xs text-[var(--neg-text-muted)] ml-auto">
                  {agent.tokens.toLocaleString()} tokens
                </span>
              )}
            </div>
            <div className="text-sm text-[var(--neg-text)] whitespace-pre-wrap leading-relaxed max-h-[400px] overflow-y-auto">
              {agent.content || (
                <span className="text-[var(--neg-text-muted)] italic">
                  Researching...
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
