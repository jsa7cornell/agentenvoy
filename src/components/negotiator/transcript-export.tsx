"use client";

import { useState } from "react";

interface TranscriptExportProps {
  transcript: string;
  tokensUsed: number;
  tokenBudget: number;
}

export function TranscriptExport({
  transcript,
  tokensUsed,
  tokenBudget,
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
      <span className="text-xs text-[var(--neg-text-muted)] ml-auto">
        {tokensUsed.toLocaleString()} / {(tokenBudget / 1000).toFixed(0)}k
        tokens used
      </span>
    </div>
  );
}
