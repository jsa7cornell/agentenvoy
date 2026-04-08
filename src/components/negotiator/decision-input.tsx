"use client";

import { useState } from "react";
import type { Synthesis } from "@/lib/negotiator/types";

interface DecisionInputProps {
  synthesis: Synthesis;
  onPickAgent: (agentId: string) => void;
  onBlend: (baseAgentId: string, blendInstruction: string) => void;
  disabled?: boolean;
}

export function DecisionInput({
  synthesis,
  onPickAgent,
  onBlend,
  disabled,
}: DecisionInputProps) {
  const [mode, setMode] = useState<"pick" | "blend">("pick");
  const [selectedAgent, setSelectedAgent] = useState(
    synthesis.recommendation.agentId
  );
  const [blendInstruction, setBlendInstruction] = useState("");

  return (
    <div className="space-y-4">
      <h2 className="text-sm font-medium text-[var(--neg-text-muted)] uppercase tracking-wider">
        Your Decision
      </h2>

      {/* Agent selection */}
      <div className="space-y-2">
        {synthesis.proposals.map((p) => {
          const isSelected = selectedAgent === p.agentId;
          const isRecommended = synthesis.recommendation.agentId === p.agentId;
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
                  <span className="text-sm font-medium">{p.headline}</span>
                  {isRecommended && (
                    <span className="text-xs px-1.5 py-0.5 rounded bg-[var(--neg-accent)]/15 text-[var(--neg-accent)] font-medium">
                      Recommended
                    </span>
                  )}
                </div>
              </div>
            </label>
          );
        })}
      </div>

      {/* Mode toggle */}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setMode("pick")}
          disabled={disabled}
          className={`flex-1 px-4 py-2 rounded-lg border text-sm font-medium transition ${
            mode === "pick"
              ? "border-[var(--neg-accent)] bg-[var(--neg-accent)]/10 text-[var(--neg-accent)]"
              : "border-[var(--neg-border)] text-[var(--neg-text-muted)] hover:border-[var(--neg-text-muted)]"
          } disabled:opacity-50`}
        >
          Follow this agent
        </button>
        <button
          type="button"
          onClick={() => setMode("blend")}
          disabled={disabled}
          className={`flex-1 px-4 py-2 rounded-lg border text-sm font-medium transition ${
            mode === "blend"
              ? "border-[var(--neg-accent)] bg-[var(--neg-accent)]/10 text-[var(--neg-accent)]"
              : "border-[var(--neg-border)] text-[var(--neg-text-muted)] hover:border-[var(--neg-text-muted)]"
          } disabled:opacity-50`}
        >
          Blend proposals
        </button>
      </div>

      {/* Blend instruction */}
      {mode === "blend" && (
        <div className="rounded-lg border border-[var(--neg-border)] bg-[var(--neg-surface)] p-4 space-y-3">
          <p className="text-sm text-[var(--neg-text-muted)]">
            Describe how to modify the selected proposal. What elements from the
            other agent(s) should be incorporated?
          </p>
          {synthesis.blendOpportunity && (
            <div className="rounded border border-purple-500/20 bg-purple-500/5 px-3 py-2">
              <span className="text-xs font-medium text-[var(--neg-purple)]">
                Administrator suggestion:
              </span>
              <p className="text-sm mt-1">{synthesis.blendOpportunity}</p>
            </div>
          )}
          <textarea
            value={blendInstruction}
            onChange={(e) => setBlendInstruction(e.target.value)}
            placeholder="e.g. Use Agent A's approach but with Agent B's phased timeline..."
            disabled={disabled}
            rows={3}
            className="w-full bg-[var(--neg-surface-2)] border border-[var(--neg-border)] rounded-lg px-4 py-3 text-sm focus:outline-none focus:border-[var(--neg-accent)] disabled:opacity-50 resize-y placeholder:text-[var(--neg-text-muted)]/50"
          />
        </div>
      )}

      {/* Submit */}
      <button
        onClick={() => {
          if (mode === "blend" && blendInstruction.trim()) {
            onBlend(selectedAgent, blendInstruction.trim());
          } else {
            onPickAgent(selectedAgent);
          }
        }}
        disabled={disabled || (mode === "blend" && !blendInstruction.trim())}
        className="px-6 py-2 rounded-lg bg-[var(--neg-accent)] text-black font-semibold text-sm hover:bg-[var(--neg-accent)]/90 transition disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {mode === "blend" ? "Blend & Finalize" : "Finalize"}
      </button>
    </div>
  );
}
