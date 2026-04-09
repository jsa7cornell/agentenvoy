"use client";

import { useState } from "react";
import type { Synthesis } from "@/lib/negotiator/types";

interface DecisionInputProps {
  synthesis: Synthesis;
  onFinalize: (agentId: string, requests: string, clarification: string) => void;
  onAnotherRound: (requests: string, clarification: string) => void;
  disabled?: boolean;
  round: number;
}

export function DecisionInput({
  synthesis,
  onFinalize,
  onAnotherRound,
  disabled,
  round,
}: DecisionInputProps) {
  const [mode, setMode] = useState<"finalize" | "another-round">("finalize");
  const [selectedAgent, setSelectedAgent] = useState(
    synthesis.recommendation.agentId
  );
  const [requests, setRequests] = useState("");
  const [clarification, setClarification] = useState("");

  const label = (agentId: string) =>
    synthesis.agentLabels?.[agentId] || agentId;

  return (
    <div className="space-y-4">
      <h2 className="text-sm font-medium text-[var(--neg-text-muted)] uppercase tracking-wider">
        Your Decision — Round {round}
      </h2>

      {/* Mode toggle */}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setMode("finalize")}
          disabled={disabled}
          className={`flex-1 px-4 py-2.5 rounded-lg border text-sm font-medium transition ${
            mode === "finalize"
              ? "border-[var(--neg-accent)] bg-[var(--neg-accent)]/10 text-[var(--neg-accent)]"
              : "border-[var(--neg-border)] text-[var(--neg-text-muted)] hover:border-[var(--neg-text-muted)]"
          } disabled:opacity-50`}
        >
          A) Pick an agent & finalize
        </button>
        <button
          type="button"
          onClick={() => setMode("another-round")}
          disabled={disabled}
          className={`flex-1 px-4 py-2.5 rounded-lg border text-sm font-medium transition ${
            mode === "another-round"
              ? "border-[var(--neg-accent)] bg-[var(--neg-accent)]/10 text-[var(--neg-accent)]"
              : "border-[var(--neg-border)] text-[var(--neg-text-muted)] hover:border-[var(--neg-text-muted)]"
          } disabled:opacity-50`}
        >
          B) Another round with all agents
        </button>
      </div>

      {/* Option A: Pick agent + clarify */}
      {mode === "finalize" && (
        <div className="rounded-lg border border-[var(--neg-border)] bg-[var(--neg-surface)] p-4 space-y-4">
          <p className="text-sm text-[var(--neg-text-muted)]">
            Go with an agent&apos;s proposal. They&apos;ll get your requests and a chance to
            refine. Other agents will see the decision and can reply with final thoughts.
          </p>

          {/* Agent selection */}
          <div className="space-y-2">
            {synthesis.proposals.map((p) => {
              const isSelected = selectedAgent === p.agentId;
              const isRecommended =
                synthesis.recommendation.agentId === p.agentId;
              return (
                <label
                  key={p.agentId}
                  className={`flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition ${
                    isSelected
                      ? "border-[var(--neg-accent)] bg-[var(--neg-accent)]/5"
                      : "border-[var(--neg-border)] hover:border-[var(--neg-text-muted)]"
                  }`}
                >
                  <input
                    type="radio"
                    name="agent"
                    value={p.agentId}
                    checked={isSelected}
                    onChange={() => setSelectedAgent(p.agentId)}
                    disabled={disabled}
                    className="mt-1 accent-[var(--neg-accent)]"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-[var(--neg-accent)]">
                        {label(p.agentId)}
                      </span>
                      {isRecommended && (
                        <span className="text-xs px-1.5 py-0.5 rounded bg-[var(--neg-accent)]/15 text-[var(--neg-accent)] font-medium">
                          Recommended
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-[var(--neg-text-muted)] mt-0.5">
                      {p.headline}
                    </p>
                  </div>
                </label>
              );
            })}
          </div>

          {/* Requests for chosen agent */}
          <div>
            <label className="block text-xs text-[var(--neg-text-muted)] mb-1">
              Requests for {label(selectedAgent)} (optional)
            </label>
            <textarea
              value={requests}
              onChange={(e) => setRequests(e.target.value)}
              placeholder={`e.g. "Address the scalability concern" or "Include a phased timeline"...`}
              disabled={disabled}
              rows={2}
              className="w-full bg-[var(--neg-surface-2)] border border-[var(--neg-border)] rounded-lg px-4 py-3 text-sm focus:outline-none focus:border-[var(--neg-accent)] disabled:opacity-50 resize-y placeholder:text-[var(--neg-text-muted)]/50"
            />
          </div>

          {/* Clarification */}
          <div>
            <label className="block text-xs text-[var(--neg-text-muted)] mb-1">
              Additional context or clarification (optional)
            </label>
            <textarea
              value={clarification}
              onChange={(e) => setClarification(e.target.value)}
              placeholder="Any constraints, preferences, or context the agents should know..."
              disabled={disabled}
              rows={2}
              className="w-full bg-[var(--neg-surface-2)] border border-[var(--neg-border)] rounded-lg px-4 py-3 text-sm focus:outline-none focus:border-[var(--neg-accent)] disabled:opacity-50 resize-y placeholder:text-[var(--neg-text-muted)]/50"
            />
          </div>

          <button
            onClick={() => onFinalize(selectedAgent, requests.trim(), clarification.trim())}
            disabled={disabled}
            className="px-6 py-2 rounded-lg bg-[var(--neg-accent)] text-black font-semibold text-sm hover:bg-[var(--neg-accent)]/90 transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Finalize with {label(selectedAgent)}
          </button>
        </div>
      )}

      {/* Option B: Another round */}
      {mode === "another-round" && (
        <div className="rounded-lg border border-[var(--neg-border)] bg-[var(--neg-surface)] p-4 space-y-4">
          <p className="text-sm text-[var(--neg-text-muted)]">
            Send all agents back for another round. Share requests or new context —
            each agent will see it and refine their proposal.
          </p>

          {/* Requests for all agents */}
          <div>
            <label className="block text-xs text-[var(--neg-text-muted)] mb-1">
              Requests for all agents (optional)
            </label>
            <textarea
              value={requests}
              onChange={(e) => setRequests(e.target.value)}
              placeholder={`e.g. "Focus more on cost comparison" or "Consider a 6-month timeline instead"...`}
              disabled={disabled}
              rows={2}
              className="w-full bg-[var(--neg-surface-2)] border border-[var(--neg-border)] rounded-lg px-4 py-3 text-sm focus:outline-none focus:border-[var(--neg-accent)] disabled:opacity-50 resize-y placeholder:text-[var(--neg-text-muted)]/50"
            />
          </div>

          {/* Clarification */}
          <div>
            <label className="block text-xs text-[var(--neg-text-muted)] mb-1">
              Additional context or clarification (optional)
            </label>
            <textarea
              value={clarification}
              onChange={(e) => setClarification(e.target.value)}
              placeholder="Any constraints, preferences, or context the agents should know..."
              disabled={disabled}
              rows={2}
              className="w-full bg-[var(--neg-surface-2)] border border-[var(--neg-border)] rounded-lg px-4 py-3 text-sm focus:outline-none focus:border-[var(--neg-accent)] disabled:opacity-50 resize-y placeholder:text-[var(--neg-text-muted)]/50"
            />
          </div>

          <button
            onClick={() => onAnotherRound(requests.trim(), clarification.trim())}
            disabled={disabled}
            className="px-6 py-2 rounded-lg bg-[var(--neg-accent)] text-black font-semibold text-sm hover:bg-[var(--neg-accent)]/90 transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Run Another Round
          </button>
        </div>
      )}
    </div>
  );
}
