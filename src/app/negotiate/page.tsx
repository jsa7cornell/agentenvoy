"use client";

import { useState } from "react";
import { NegotiationConfigPanel } from "@/components/negotiator/negotiation-config";
import { NegotiationRunner } from "@/components/negotiator/negotiation-runner";
import type { NegotiationConfig } from "@/lib/negotiator/types";

export default function NegotiatePage() {
  const [config, setConfig] = useState<NegotiationConfig | null>(null);

  return (
    <main className="max-w-4xl mx-auto px-4 py-8 bg-[var(--neg-bg)] min-h-screen text-[var(--neg-text)]">
      {/* Header */}
      <div className="mb-6 flex flex-col sm:flex-row sm:items-start sm:gap-6 border-b border-[var(--neg-border)] pb-5">
        <div className="shrink-0">
          <a href="/negotiate" className="text-xl font-bold tracking-tight text-[var(--neg-accent)] hover:opacity-80 transition">
            AgentNegotiator
          </a>
          <p className="text-xs mt-0.5">
            <span className="text-[var(--neg-text-muted)]">by </span>
            <a href="https://agentenvoy.ai" target="_blank" rel="noopener noreferrer" className="text-[var(--neg-text-muted)] hover:text-[var(--neg-accent)] transition">
              AgentEnvoy
            </a>
          </p>
        </div>
        <ol className="text-[var(--neg-text-muted)] text-xs space-y-1 mt-3 sm:mt-1 list-decimal list-inside">
          <li>Describe your decision — give agents shared context and individual positions to argue</li>
          <li>Agents debate and negotiate — AgentEnvoy surfaces agreements, tensions, and what to clarify</li>
        </ol>
      </div>

      {config ? (
        <NegotiationRunner
          config={config}
          onReset={() => setConfig(null)}
        />
      ) : (
        <NegotiationConfigPanel onStart={setConfig} />
      )}

      {/* Footer */}
      <footer className="mt-12 pt-4 border-t border-[var(--neg-border)] text-xs text-[var(--neg-text-muted)] flex items-center justify-between">
        <span>Powered by AgentEnvoy</span>
        <a
          href="https://agentenvoy.ai"
          className="hover:text-[var(--neg-text)] transition"
        >
          agentenvoy.ai
        </a>
      </footer>
    </main>
  );
}
