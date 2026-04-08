"use client";

import { useState } from "react";
import { v4 as uuid } from "uuid";
import { AgentCard } from "./agent-card";
import { UploadModal, type DocumentInfo } from "./upload-modal";
import { BUDGET_STEPS, DEFAULT_TOKEN_BUDGET } from "@/lib/negotiator/token-budget";
import type { AgentConfig, NegotiationConfig } from "@/lib/negotiator/types";
import { DEFAULT_MODEL } from "@/lib/negotiator/types";

const STARTER_CONTEXTS = [
  "Prioritize speed and pragmatism. Advocate for the simplest solution that ships fastest, even if it means cutting corners you can fix later.",
  "Prioritize long-term quality and scalability. Push back on shortcuts that create technical debt or operational risk down the road.",
  "Prioritize cost and resource efficiency. Challenge any approach that isn't justified by ROI, and flag hidden costs or complexity.",
];

function createAgent(index: number = 0): AgentConfig {
  return {
    id: uuid(),
    name: `Agent ${index + 1}`,
    provider: "openai",
    model: DEFAULT_MODEL,
    apiKey: "",
    context: "", // blank — starter contexts shown as placeholder hints
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
  const [sharedContext, setSharedContext] = useState("");
  const [documentInfo, setDocumentInfo] = useState<DocumentInfo | null>(null);
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [agents, setAgents] = useState<AgentConfig[]>([
    createAgent(0),
    createAgent(1),
    createAgent(2),
  ]);

  const canAddAgent = agents.length < 4;
  const canStart = question.trim().length > 0 && agents.length >= 2;

  function addAgent() {
    if (!canAddAgent) return;
    setAgents([...agents, createAgent(agents.length)]);
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
      sharedContext,
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
        <label className="block text-sm font-medium mb-1 text-[var(--neg-text)]">Describe your decision for the agents</label>
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder={"What should the agents debate and decide on? Include any relevant background, constraints, or requirements.\n\ne.g. 'What payment processor should we use for a new SaaS product? We expect $50k MRR within 6 months, need international card support, and have a 3-person engineering team.'"}
          disabled={disabled}
          rows={4}
          className="w-full bg-white border-2 border-[var(--neg-border)] rounded-lg px-4 py-3 text-sm focus:outline-none focus:border-[var(--neg-accent)] disabled:opacity-50 resize-y placeholder:text-[var(--neg-text-muted)]/60 text-[var(--neg-text)] shadow-sm"
        />
      </div>

      {/* Attach file */}
      <div>
        {documentInfo ? (
          <div className="flex items-center gap-2 text-sm">
            <span className="inline-flex items-center gap-1.5 bg-[var(--neg-accent)]/10 border border-[var(--neg-accent)]/30 rounded-md px-2.5 py-1 text-[var(--neg-text)]">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="shrink-0 opacity-60">
                <path d="M9 1H4a1 1 0 00-1 1v12a1 1 0 001 1h8a1 1 0 001-1V5L9 1z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
                <path d="M9 1v4h4" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
              </svg>
              {documentInfo.filename}
              <span className="text-[var(--neg-text-muted)]">
                {documentInfo.charCount.toLocaleString()} chars
              </span>
              {documentInfo.truncated && (
                <span className="text-amber-600 text-xs">(truncated)</span>
              )}
              <button
                onClick={() => { setSharedContext(""); setDocumentInfo(null); }}
                disabled={disabled}
                className="ml-1 text-[var(--neg-text-muted)] hover:text-[var(--neg-text)] disabled:opacity-50"
                title="Remove attachment"
              >
                &times;
              </button>
            </span>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setShowUploadModal(true)}
            disabled={disabled}
            className="flex items-center gap-1.5 text-sm text-[var(--neg-text-muted)] hover:text-[var(--neg-accent)] transition disabled:opacity-50"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="shrink-0">
              <path d="M14 10.5V13a1 1 0 01-1 1H3a1 1 0 01-1-1v-2.5M8 2v8.5M5 5l3-3 3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            Attach a reference document
          </button>
        )}
      </div>

      <UploadModal
        open={showUploadModal}
        onClose={() => setShowUploadModal(false)}
        onExtracted={(text, info) => {
          setSharedContext(text);
          setDocumentInfo(info);
          setShowUploadModal(false);
        }}
        disabled={disabled}
      />

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
                className="w-full bg-white border-2 border-[var(--neg-border)] rounded-lg px-4 py-3 text-sm focus:outline-none focus:border-[var(--neg-accent)] disabled:opacity-50 resize-y placeholder:text-[var(--neg-text-muted)]/60 text-[var(--neg-text)] shadow-sm"
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
                  className="bg-white border-2 border-[var(--neg-border)] rounded px-3 py-1.5 text-sm focus:outline-none focus:border-[var(--neg-accent)] disabled:opacity-50 text-[var(--neg-text)] shadow-sm"
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
                  className="bg-white border-2 border-[var(--neg-border)] rounded px-3 py-1.5 text-sm focus:outline-none focus:border-[var(--neg-accent)] disabled:opacity-50 text-[var(--neg-text)] shadow-sm"
                >
                  <option value={1}>1 round</option>
                  <option value={2}>2 rounds (recommended)</option>
                  <option value={3}>3 rounds</option>
                </select>
              </div>
            </div>

            {/* API Keys */}
            <div>
              <label className="block text-sm font-medium mb-3">API Keys (Optional)</label>
              <p className="text-xs text-[var(--neg-text-muted)] mb-3">
                Leave empty to use server keys. Only override if you want to use your own credentials.
              </p>
              <div className="space-y-3">
                {agents.map((agent, i) => (
                  <div key={agent.id}>
                    <label className="text-xs text-[var(--neg-text-muted)] block mb-1">
                      Agent {i + 1} ({agent.model})
                    </label>
                    <input
                      type="password"
                      value={agent.apiKey}
                      onChange={(e) => updateAgent(i, { ...agent, apiKey: e.target.value })}
                      placeholder="Leave empty to use server key"
                      disabled={disabled}
                      className="w-full bg-white border-2 border-[var(--neg-border)] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[var(--neg-accent)] disabled:opacity-50 placeholder:text-[var(--neg-text-muted)]/60 text-[var(--neg-text)] shadow-sm"
                    />
                  </div>
                ))}
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
              placeholder={STARTER_CONTEXTS[i % STARTER_CONTEXTS.length]}
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
