"use client";

import {
  type AgentConfig,
  type ModelProvider,
  PROVIDER_LABELS,
  MODEL_OPTIONS,
  formatEstCost,
} from "@/lib/negotiator/types";

interface AgentCardProps {
  agent: AgentConfig;
  index: number;
  onChange: (agent: AgentConfig) => void;
  onRemove: () => void;
  canRemove: boolean;
  disabled?: boolean;
  placeholder?: string;
}

export function AgentCard({
  agent,
  index,
  onChange,
  onRemove,
  canRemove,
  disabled,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- used in textarea below
  placeholder = "e.g. Focus on cost optimization. Assume a 3-month timeline.",
}: AgentCardProps) {
  const providerColor =
    agent.provider === "anthropic"
      ? "border-orange-500/40"
      : agent.provider === "google"
        ? "border-blue-500/40"
        : "border-green-500/40";

  return (
    <div
      className={`rounded-lg border-2 ${providerColor} bg-[var(--neg-surface)] p-4 space-y-3 shadow-sm`}
    >
      <div className="flex items-center justify-between">
        <span className="text-xs text-[var(--neg-text-muted)] uppercase tracking-wider">
          Agent {index + 1}
        </span>
        {canRemove && (
          <button
            onClick={onRemove}
            disabled={disabled}
            className="text-xs text-[var(--neg-text-muted)] hover:text-[var(--neg-red)] transition disabled:opacity-50"
          >
            Remove
          </button>
        )}
      </div>

      {/* Model selector - all models available */}
      <div>
        <label className="text-xs text-[var(--neg-text-muted)] block mb-1">Model</label>
        <select
          value={agent.model}
          onChange={(e) => {
            const model = e.target.value;
            // Determine provider from model
            let provider: ModelProvider = agent.provider;
            for (const [p, models] of Object.entries(MODEL_OPTIONS)) {
              if (models.includes(model)) {
                provider = p as ModelProvider;
                break;
              }
            }
            onChange({ ...agent, model, provider });
          }}
          disabled={disabled}
          className="w-full bg-white border-2 border-[var(--neg-border)] rounded px-2 py-1.5 text-sm focus:outline-none focus:border-[var(--neg-accent)] disabled:opacity-50"
        >
          {(Object.entries(MODEL_OPTIONS) as Array<[ModelProvider, string[]]>).map(
            ([provider, models]) => (
              <optgroup key={provider} label={PROVIDER_LABELS[provider]}>
                {models.map((m) => {
                  const cost = formatEstCost(m);
                  return (
                    <option key={m} value={m}>
                      {m}{cost ? ` (${cost}/round)` : ""}
                    </option>
                  );
                })}
              </optgroup>
            )
          )}
        </select>
      </div>

      {/* Agent Context */}
      <div>
        <label className="text-xs font-medium text-[var(--neg-text)] block mb-0.5">
          Starting position
        </label>
        <p className="text-xs text-[var(--neg-text-muted)] mb-1">The perspective this agent argues from</p>
        <textarea
          value={agent.context}
          onChange={(e) => onChange({ ...agent, context: e.target.value })}
          placeholder={placeholder}
          disabled={disabled}
          rows={2}
          className="w-full bg-white border-2 border-[var(--neg-border)] rounded px-3 py-2 text-sm focus:outline-none focus:border-[var(--neg-accent)] disabled:opacity-50 resize-y placeholder:text-[var(--neg-text-muted)]/60 text-[var(--neg-text)]"
        />
      </div>
    </div>
  );
}
