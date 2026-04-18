"use client";

import { useState } from "react";

export function CopyLinkButton({ url, compact }: { url: string; compact?: boolean }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard can fail in insecure contexts — surface via label flip.
      setCopied(false);
    }
  };

  if (compact) {
    return (
      <button
        type="button"
        onClick={copy}
        className="px-2.5 py-1 rounded-md text-[11px] font-medium bg-purple-500/80 hover:bg-purple-500 text-white transition flex-shrink-0"
      >
        {copied ? "Copied!" : "Copy"}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={copy}
      className="px-3 py-1.5 rounded-md text-xs font-semibold bg-purple-500/90 hover:bg-purple-500 text-white transition"
    >
      {copied ? "Copied to clipboard!" : "Copy link"}
    </button>
  );
}
