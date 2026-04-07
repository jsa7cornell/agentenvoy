"use client";

import { useState } from "react";
import { v4 as uuid } from "uuid";
import { AgentCard } from "./agent-card";
import { BUDGET_STEPS, DEFAULT_TOKEN_BUDGET } from "@/lib/negotiator/token-budget";
import type { AgentConfig, NegotiationConfig, ModelProvider } from "@/lib/negotiator/types";
import { DEFAULT_MODELS } from "@/lib/negotiator/types";

function createAgent(provider: ModelProvider = "anthropic"): AgentConfig {
  const names: Record<ModelProvider, string> = {
    anthropic: "Claude",
    google: "Gemini",
    openai: "GPT",
  };
  return {
    id: uuid(),
    name: names[provider],
    provider,
    model: DEFAULT_MODELS[provider],
    apiKey: "",
    context: "",
  };
}

interface NegotiationConfigPanelProps {
  onStart: (config: NegotiationConfig) => void;
  disabled?: boolean;
}

export function NegotiationConfigPanel({
  onStart,
  disabled,
}: NegotiationConfigPanelProps) {
  const [question, setQuestion] = useState("");
  const [hostPrivateContext, setHostPrivateContext] = useState("");
  const [tokenBudget, setTokenBudget] = useState(DEFAULT_TOKEN_BUDGET);
  const [maxRounds, setMaxRounds] = useState(2);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [agents, setAgents] = useState<AgentConfig[]>([
    createAgent("anthropic"),
    createAgent("google"),
    createAgent("openai"),
  ]);

  const canAddAgent = agents.length < 4;
  const canStart = question.trim().length > 0 && agents.length >= 2;

  function addAgent() {
    if (!canAddAgent) return;
    const used = new Set(agents.map((a) => a.provider));
    const next: ModelProvider =
      !used.has("openai") ? "openai" :
      !used.has("google") ? "google" :
      "anthropic";
    setAgents([...agents, createAgent(next)]);
  }

  function updateAgent(index: number, updated: AgentConfig) {
    const copy = [...agents];
    copy[index] = updated;
    setAgents(copy);
  }

  function removeAgent(index: number) {
    setAgents(agents.filter((_, i) => i !== index));
  }

  function handleStart() {
    onStart({
      question: question.trim(),
      sharedContext: "",
      hostPrivateContext: hostPrivateContext.trim(),
      agents,
      tokenBudget,
      maxRounds,
    });
  }

  return (
    <div className="space-y-6">
      {/* Question & Context */}
      <div>
        <label className="block text-sm font-medium mb-1">Question & Context</label>
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder={"What should the agents research? Include any relevant background, constraints, or requirements.\n\ne.g. 'What payment processor should we use for a new SaaS product? We expect $50k MRR within 6 months, need international card support, and have a 3-person engineering team.'"}
          disabled={disabled}
          rows={4}
          className="w-full bg-[var(--neg-surface)] border border-[var(--neg-border)] rounded-lg px-4 py-3 text-sm focus:outline-none focus:border-[var(--neg-accent)] disabled:opacity-50 resize-y placeholder:text-[var(--neg-text-muted)]/50"
        />
      </div>

      {/* Advanced section — collapsed by default */}
      <div>
        <button
          type="button"
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="flex items-center gap-1.5 text-sm text-[var(--neg-text-muted)] hover:text-[var(--neg-text)] transition"
        >
          <span
            className="inline-block transition-transform duration-200"
            style={{ transform: showAdvanced ? "rotate(90deg)" : "rotate(0deg)" }}
          >
            &#9654;
          </span>
          Advanced
          <span className="text-xs text-[var(--neg-text-muted)]/60 font-normal ml-1">
            — private context, budget, rounds
          </span>
        </button>

        {showAdvanced && (
          <div className="mt-3 space-y-4 pl-4 border-l-2 border-[var(--neg-border)]">
            {/* Host Private Context */}
            <div>
              <label className="block text-sm font-medium mb-1">
                Your Private Context{" "}
                <span className="text-[var(--neg-text-muted)] font-normal">
                  (only the Administrator sees this)
                </span>
              </label>
              <p className="text-xs text-[var(--neg-text-muted)] mb-2">
                Give the Administrator context about your preferences or constraints
                that you don&apos;t want individual agents to see. The Administrator
                uses this to weight its synthesis in your favor.
              </p>
              <textarea
                value={hostPrivateContext}
                onChange={(e) => setHostPrivateContext(e.target.value)}
                placeholder="Your preferences, biases, private constraints..."
                disabled={disabled}
                rows={3}
                className="w-full bg-[var(--neg-surface)] border border-[var(--neg-border)] rounded-lg px-4 py-3 text-sm focus:outline-none focus:border-[var(--neg-accent)] disabled:opacity-50 resize-y placeholder:text-[var(--neg-text-muted)]/50"
              />
            </div>

            {/* Budget + Rounds row */}
            <div className="flex flex-wrap gap-6 items-end">
              <div>
                <label className="block text-xs text-[var(--neg-text-muted)] mb-1">
                  Token Budget
                </label>
                <select
                  value={tokenBudget}
                  onChange={(e) => setTokenBudget(Number(e.target.value))}
                  disabled={disabled}
                  className="bg-[var(--neg-surface)] border border-[var(--neg-border)] rounded px-3 py-1.5 text-sm focus:outline-none focus:border-[var(--neg-accent)] disabled:opacity-50"
                >
                  {BUDGET_STEPS.map((b) => (
                    <option key={b} value={b}>
                      {(b / 1000).toFixed(0)}k tokens
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-[var(--neg-text-muted)] mb-1">
                  Max Rounds
                </label>
                <select
                  value={maxRounds}
                  onChange={(e) => setMaxRounds(Number(e.target.value))}
                  disabled={disabled}
                  className="bg-[var(--neg-surface)] border border-[var(--neg-border)] rounded px-3 py-1.5 text-sm focus:outline-none focus:border-[var(--neg-accent)] disabled:opacity-50"
                >
                  <option value={1}>1 round</option>
                  <option value={2}>2 rounds (recommended)</option>
                  <option value={3}>3 rounds</option>
                </select>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Agents */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <label className="text-sm font-medium">
            Agents{" "}
            <span className="text-[var(--neg-text-muted)] font-normal">
              ({agents.length}/4)
            </span>
          </label>
          {canAddAgent && (
            <button
              onClick={addAgent}
              disabled={disabled}
              className="text-sm text-[var(--neg-accent)] hover:text-[var(--neg-accent)]/80 transition disabled:opacity-50"
            >
              + Add Agent
            </button>
          )}
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {agents.map((agent, i) => (
            <AgentCard
              key={agent.id}
              agent={agent}
              index={i}
              onChange={(a) => updateAgent(i, a)}
              onRemove={() => removeAgent(i)}
              canRemove={agents.length > 2}
              disabled={disabled}
            />
          ))}
        </div>
      </div>

      {/* Start button */}
      <button
        onClick={handleStart}
        disabled={!canStart || disabled}
        className="w-full py-3 rounded-lg bg-[var(--neg-accent)] text-black font-semibold text-sm hover:bg-[var(--neg-accent)]/90 transition disabled:opacity-50 disabled:cursor-not-allowed"
      >
        Run Negotiation
      </button>
    </div>
  );
}
