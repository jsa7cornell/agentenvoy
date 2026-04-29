"use client";

/**
 * Links chip list — sits just under the scheduling status chip at the
 * top of the feed. Renders every way someone can book time with the
 * host as an expandable chip (proposal
 * `2026-04-23_primary-link-config-convergence` §3.2 pattern (b)):
 *
 *   🔗 Meet John Anderson                               [▼]
 *   🕐 Office hours — 30m · Mon Tue Fri 9–5             [▼]
 *   🎉 Birthday dinner — 2h · expires 2026-05-15         [▼]
 *   + New link
 *
 * V2 PR3 (2026-04-23): read-only. Tap a chip to expand its card in-place
 * — URL + copy button + metadata. "+ New link" routes to the existing
 * /dashboard/my-links page for now; in-thread creation lands in a
 * later PR along with the standard-as-diff-baseline UX.
 *
 * Data source: GET /api/me/links (unified view — standard + office
 * hours + contextual). Swaps to /api/me/scheduling-state when that
 * endpoint ships.
 */

import Link from "next/link";
import { useEffect, useState } from "react";
import { EditedPill } from "@/components/edited-pill";

type LinkEntry =
  | {
      kind: "standard";
      title: string;
      url: string;
      slug: string;
    }
  | {
      kind: "office_hours";
      title: string;
      url: string;
      slug: string;
      code: string;
      windowStart: string;
      windowEnd: string;
      daysOfWeek: number[];
      durationMinutes: number;
      expiryDate: string | null;
    }
  | {
      kind: "contextual";
      title: string;
      url: string;
      slug: string;
      code: string;
      inviteeName: string | null;
      topic: string | null;
      expiresAt: string | null;
      createdAt: string;
      // Per-field "Edited" pill metadata — proposal 2026-04-28 §3.C.
      lastMaterialEditAt: string | null;
      lastEditedFields: string[];
    };

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function kindIcon(kind: LinkEntry["kind"]): string {
  if (kind === "standard") return "🔗";
  if (kind === "office_hours") return "🕐";
  return "🎉";
}

function shortSubtitle(l: LinkEntry): string {
  if (l.kind === "standard") return "share with anyone";
  if (l.kind === "office_hours") {
    const days =
      l.daysOfWeek.length === 0
        ? "every day"
        : l.daysOfWeek.map((d) => DAY_NAMES[d]).join(" ");
    return `${l.durationMinutes}m · ${days} ${l.windowStart}–${l.windowEnd}`;
  }
  const bits = [] as string[];
  if (l.inviteeName) bits.push(l.inviteeName);
  if (l.expiresAt) {
    bits.push(`expires ${l.expiresAt.slice(0, 10)}`);
  }
  return bits.join(" · ") || "single-use";
}

export function SchedulingLinksChipList() {
  const [links, setLinks] = useState<LinkEntry[] | null>(null);
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/me/links")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        setLinks(data.links ?? []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  if (!links) return null;
  if (links.length === 0) {
    // Account not yet initialized — nothing to show.
    return null;
  }

  const copy = async (url: string, idx: number) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedIdx(idx);
      setTimeout(() => setCopiedIdx(null), 2000);
    } catch {
      /* no-op — clipboard denied */
    }
  };

  return (
    <div
      className="self-center w-full max-w-md flex flex-col gap-1.5"
      aria-label="Your scheduling links"
    >
      {links.map((l, i) => {
        const open = expandedIdx === i;
        return (
          <div
            key={`${l.kind}-${i}`}
            className="rounded-xl border border-secondary/50 bg-black/[0.02] dark:bg-white/[0.03] overflow-hidden"
          >
            <button
              type="button"
              onClick={() => setExpandedIdx(open ? null : i)}
              aria-expanded={open}
              className="w-full flex items-center gap-2 text-xs px-3 py-2 hover:bg-black/[0.04] dark:hover:bg-white/[0.04] transition text-left"
            >
              <span aria-hidden="true">{kindIcon(l.kind)}</span>
              <span className="flex-1 min-w-0 flex items-center gap-2">
                <span className="truncate font-medium text-primary">
                  {l.title}
                </span>
                <span className="truncate text-muted tabular-nums">
                  {shortSubtitle(l)}
                </span>
                {l.kind === "contextual" && (
                  <EditedPill
                    lastMaterialEditAt={l.lastMaterialEditAt}
                    lastEditedFields={l.lastEditedFields}
                  />
                )}
              </span>
              <span aria-hidden="true" className="text-muted/60">
                {open ? "▴" : "▾"}
              </span>
            </button>
            {open && (
              <div className="px-3 pb-3 pt-1 flex flex-col gap-2 border-t border-secondary/30">
                <code className="text-[11px] text-purple-400 break-all font-mono">
                  {l.url}
                </code>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => copy(l.url, i)}
                    className="px-2.5 py-1 bg-purple-600 hover:bg-purple-500 text-white text-[11px] font-medium rounded-md transition"
                  >
                    {copiedIdx === i ? "Copied!" : "Copy link"}
                  </button>
                  <a
                    href={l.url}
                    target="_blank"
                    rel="noreferrer"
                    className="px-2.5 py-1 text-[11px] border border-secondary/60 text-secondary hover:text-primary hover:border-purple-500/60 rounded-md transition"
                  >
                    Open →
                  </a>
                </div>
              </div>
            )}
          </div>
        );
      })}
      <Link
        href="/dashboard/my-links"
        className="text-[11px] text-muted hover:text-primary self-start px-3 py-1 transition"
      >
        + New link
      </Link>
    </div>
  );
}
