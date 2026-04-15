"use client";

/**
 * TodayInsight — small card rendered under the dashboard calendar widget.
 *
 * Fetches /api/dashboard/insight on mount. Hides itself entirely if the
 * endpoint returns no content (empty/disconnected calendar) so the sidebar
 * stays clean instead of showing a dead card.
 */

import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";

export function TodayInsight() {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/dashboard/insight")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled) return;
        if (data?.content) setContent(data.content);
      })
      .catch(() => {
        /* silent — best effort */
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <div className="mt-4 rounded-md border border-secondary/60 p-3">
        <div className="h-2.5 w-16 rounded bg-secondary/40 mb-2" />
        <div className="h-2 w-full rounded bg-secondary/30 mb-1.5" />
        <div className="h-2 w-4/5 rounded bg-secondary/30" />
      </div>
    );
  }

  if (!content) return null;

  return (
    <div className="mt-4 rounded-md border border-secondary/60 bg-black/5 dark:bg-white/[0.04] p-3">
      <div className="flex items-center gap-1.5 mb-1.5">
        <Sparkles className="w-3 h-3 text-muted" />
        <h4 className="text-[10px] font-bold uppercase tracking-widest text-muted">
          Today&apos;s Insight
        </h4>
      </div>
      <p className="text-xs leading-relaxed text-secondary">{content}</p>
    </div>
  );
}
