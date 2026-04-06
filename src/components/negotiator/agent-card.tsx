"use client";

import {
  type AgentConfig,
  type ModelProvider,
  PROVIDER_LABELS,
  DEFAULT_MODELS,
  MODEL_OPTIONS,
} from "@/lib/negotiator/types";

interface AgentCardProps {
  agent: AgentConfig;
  index: number;
  onChange: (agent: AgentConfig) => void;
  onRemove: () => void;
  canRemove: boolean;
  disabled?: boolean;
}

export function AgentCard({
  agent,
  index,
  onChange,
  onRemove,
  canRemove,
  disabled,
}: AgentCardProps) {
  const providerColor =
    agent.provider === "anthropic"
      ? "border-orange-500/40"
      : agent.provider === "google"
        ? "border-blue-500/40"
        : "border-green-500/40";

  return (
    <div
      className={`rounded-lg border ${providerColor} bg-[var(--neg-surface)] p-4 space-y-3`}
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

      {/* Name */}
      <input
        type="text"
        value={agent.name}
        onChange={(e) => onChange({ ...agent, name: e.target.value })}
        placeholder="Agent name (e.g. Claude, Gemini)"
        disabled={disabled}
        className="w-full bg-[var(--neg-surface-2)] border border-[var(--neg-border)] rounded px-3 py-1.5 text-sm focus:outline-none focus:border-[var(--neg-accent)] disabled:opacity-50"
      />

      {/* Provider + Model row */}
      <div className="flex gap-2">
        <select
          value={agent.provider}
          onChange={(e) => {
            const provider = e.target.value as ModelProvider;
            onChange({
              ...agent,
              provider,
              model: DEFAULT_MODELS[provider],
            });
          }}
          disabled={disabled}
          className="flex-1 bg-[var(--neg-surface-2)] border border-[var(--neg-border)] rounded px-2 py-1.5 text-sm focus:outline-none focus:border-[var(--neg-accent)] disabled:opacity-50"
        >
          {(Object.keys(PROVIDER_LABELS) as ModelProvider[]).map((p) => (
            <option key={p} value={p}>
              {PROVIDER_LABELS[p]}
            </option>
          ))}
        </select>

        <select
          value={agent.model}
          onChange={(e) => onChange({ ...agent, model: e.target.value })}
          disabled={disabled}
          className="flex-1 bg-[var(--neg-surface-2)] border border-[var(--neg-border)] rounded px-2 py-1.5 text-sm focus:outline-none focus:border-[var(--neg-accent)] disabled:opacity-50"
        >
          {MODEL_OPTIONS[agent.provider].map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </div>

      {/* API Key */}
      <div>
        <div className="flex items-center gap-2 mb-1">
          <label className="text-xs text-[var(--neg-text-muted)]">API Key</label>
          <span className="text-xs text-[var(--neg-accent)]">
            {agent.apiKey ? "Using your key" : "Using server key"}
          </span>
        </div>
        <input
          type="password"
          value={agent.apiKey}
          onChange={(e) => onChange({ ...agent, apiKey: e.target.value })}
          placeholder="Leave empty to use server key"
          disabled={disabled}
          className="w-full bg-[var(--neg-surface-2)] border border-[var(--neg-border)] rounded px-3 py-1.5 text-sm focus:outline-none focus:border-[var(--neg-accent)] disabled:opacity-50 placeholder:text-[var(--neg-text-muted)]/50"
        />
      </div>

      {/* Agent Context */}
      <div>
        <label className="text-xs text-[var(--neg-text-muted)] block mb-1">
          Agent context (private to this agent + administrator)
        </label>
        <textarea
          value={agent.context}
          onChange={(e) => onChange({ ...agent, context: e.target.value })}
          placeholder="e.g. Focus on cost optimization. Assume a 3-month timeline."
          disabled={disabled}
          rows={2}
          className="w-full bg-[var(--neg-surface-2)] border border-[var(--neg-border)] rounded px-3 py-2 text-sm focus:outline-none focus:border-[var(--neg-accent)] disabled:opacity-50 resize-y placeholder:text-[var(--neg-text-muted)]/50"
        />
      </div>
    </div>
  );
}
