"use client";

import { useState } from "react";
import { NegotiationConfigPanel } from "@/components/negotiator/negotiation-config";
import { NegotiationRunner } from "@/components/negotiator/negotiation-runner";
import type { NegotiationConfig } from "@/lib/negotiator/types";

export default function NegotiatePage() {
  const [config, setConfig] = useState<NegotiationConfig | null>(null);

  return (
    <main className="max-w-4xl mx-auto px-4 py-8">
      {/* Header */}
      <div className="mb-8 rounded-lg border border-[var(--neg-accent)]/30 bg-[var(--neg-accent)]/5 px-5 py-5 max-w-2xl">
        <h1 className="text-2xl md:text-3xl font-bold tracking-tight bg-gradient-to-r from-[var(--neg-accent)] to-[var(--neg-accent)]/70 bg-clip-text text-transparent mb-2">
          AgentNegotiator
        </h1>
        <p className="text-[var(--neg-text)] text-sm mb-4 font-medium">
          Let AI agents negotiate from different positions to help you reason through the best approach.
        </p>
        <ol className="text-[var(--neg-text-muted)] text-xs space-y-1.5 list-decimal list-inside">
          <li>Describe your decision and what matters to you</li>
          <li>Give each agent context and a position to reason and negotiate with</li>
          <li>Agent Envoy identifies points of agreement, points of tension, and where you should clarify your requirements</li>
          <li>You can re-run the negotiation, or choose a route and give the agents the opportunity to respond</li>
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
