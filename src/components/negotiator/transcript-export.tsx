"use client";

import { useState } from "react";
import { estimateMultiModelCost } from "@/lib/negotiator/types";

interface TranscriptExportProps {
  transcript: string;
  tokensUsed: number;
  tokenBudget: number;
  models?: string[]; // list of models used — for cost estimate
  inline?: boolean;  // compact mode — no border-top, smaller buttons
}

export function TranscriptExport({
  transcript,
  tokensUsed,
  tokenBudget,
  models = [],
  inline = false,
}: TranscriptExportProps) {
  const [copied, setCopied] = useState(false);

  async function copyToClipboard() {
    await navigator.clipboard.writeText(transcript);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function downloadMarkdown() {
    const blob = new Blob([transcript], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `negotiation-${new Date().toISOString().slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const estimatedCost = estimateMultiModelCost(tokensUsed, models);
  const costLabel = estimatedCost > 0
    ? `~$${estimatedCost < 0.01 ? estimatedCost.toFixed(4) : estimatedCost.toFixed(3)}`
    : null;

  if (inline) {
    return (
      <div className="flex items-center gap-2">
        <button
          onClick={copyToClipboard}
          className="px-3 py-1.5 rounded border border-[var(--neg-border)] text-xs hover:bg-[var(--neg-surface-2)] transition"
        >
          {copied ? "Copied!" : "Copy Transcript"}
        </button>
        <button
          onClick={downloadMarkdown}
          className="px-3 py-1.5 rounded border border-[var(--neg-border)] text-xs hover:bg-[var(--neg-surface-2)] transition"
        >
          Download .md
        </button>
        {costLabel && (
          <span className="text-xs text-[var(--neg-text-muted)]" title="Estimated cost based on token usage and model pricing">
            {costLabel} est.
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3 pt-4 border-t border-[var(--neg-border)]">
      <button
        onClick={copyToClipboard}
        className="px-4 py-2 rounded border border-[var(--neg-border)] text-sm hover:bg-[var(--neg-surface-2)] transition"
      >
        {copied ? "Copied!" : "Copy Transcript"}
      </button>
      <button
        onClick={downloadMarkdown}
        className="px-4 py-2 rounded border border-[var(--neg-border)] text-sm hover:bg-[var(--neg-surface-2)] transition"
      >
        Download .md
      </button>
      <div className="ml-auto text-right">
        <span className="text-xs text-[var(--neg-text-muted)] block">
          {tokensUsed.toLocaleString()} / {(tokenBudget / 1000).toFixed(0)}k tokens used
        </span>
        {costLabel && (
          <span className="text-xs text-[var(--neg-text-muted)]" title="Estimated cost based on token usage and model pricing">
            {costLabel} estimated cost
          </span>
        )}
      </div>
    </div>
  );
}
