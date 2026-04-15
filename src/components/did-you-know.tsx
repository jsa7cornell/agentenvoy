"use client";

/**
 * DidYouKnow — small product-awareness card rendered under TodayInsight.
 *
 * Shows one tip at a time from `DID_YOU_KNOW_TIPS`. Each tip has an optional
 * CTA that deep-links into the feature it's describing. A subtle "another tip"
 * link under the body cycles to a new random tip (never the same one twice
 * in a row). Content is fully static — no API, no cache.
 */

import { useMemo, useState } from "react";
import Link from "next/link";
import { Lightbulb } from "lucide-react";
import { DID_YOU_KNOW_TIPS, type DidYouKnowTip } from "@/content/did-you-know";

function pickRandomIndex(length: number, avoid: number): number {
  if (length <= 1) return 0;
  let next = Math.floor(Math.random() * length);
  if (next === avoid) next = (next + 1) % length;
  return next;
}

export function DidYouKnow() {
  // Seed with a random tip on mount. useMemo so it's stable across re-renders.
  const initialIndex = useMemo(
    () => Math.floor(Math.random() * DID_YOU_KNOW_TIPS.length),
    [],
  );
  const [index, setIndex] = useState(initialIndex);

  const tip: DidYouKnowTip | undefined = DID_YOU_KNOW_TIPS[index];
  if (!tip) return null;

  function handleAnother() {
    setIndex((prev) => pickRandomIndex(DID_YOU_KNOW_TIPS.length, prev));
  }

  return (
    <div className="mt-4 rounded-md border border-secondary/60 bg-black/5 dark:bg-white/[0.04] p-3">
      <div className="flex items-center gap-1.5 mb-1.5">
        <Lightbulb className="w-3 h-3 text-muted" />
        <h4 className="text-[10px] font-bold uppercase tracking-widest text-muted">
          Did you know?
        </h4>
      </div>
      <p className="text-xs font-semibold text-primary leading-snug mb-1">
        {tip.title}
      </p>
      <p className="text-xs leading-relaxed text-secondary">{tip.body}</p>
      <div className="mt-2 flex items-center justify-between gap-2">
        {tip.cta ? (
          <Link
            href={tip.cta.href}
            className="text-[10px] font-medium text-secondary hover:text-primary underline"
          >
            {tip.cta.label} →
          </Link>
        ) : (
          <span />
        )}
        <button
          type="button"
          onClick={handleAnother}
          className="text-[10px] text-muted hover:text-secondary underline"
        >
          another tip
        </button>
      </div>
    </div>
  );
}
