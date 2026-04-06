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
      <div className="mb-8">
        <h1 className="text-2xl font-bold tracking-tight">
          AgentNegotiator
        </h1>
        <p className="text-[var(--neg-text-muted)] text-sm mt-1">
          Put AI agents in a room together. They research independently, then a
          neutral Administrator synthesizes their positions — surfacing where
          they agree, where they disagree, and what tradeoffs you need to
          decide.
        </p>
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
