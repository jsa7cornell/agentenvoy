"use client";

/**
 * Mobile Event Links sheet — slide-up from the topbar header pill.
 *
 * **Thin shell for PR 3.** Two-group layout (Reusable links + Upcoming events
 * with filter chips, URL+copy on each card, cancel/archive on rows) lands in
 * PR 7 (`refactor-package-2026-04-25/PROJECT-PLAN.md` Phase 1). For PR 3 we
 * render the existing my-link list inline (same fetch path as
 * `MyLinksPopover` — `/api/tuner/preferences`) so users keep their links
 * surface, plus an "Upcoming events" row that hands off to
 * `/dashboard/meetings`.
 *
 * Animation primitive: pure CSS transform driven by an `open` prop. No
 * dependency added per brief §7.4.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import type { AvailabilityRule } from "@/lib/availability-rules";
import { getOfficeHoursDisplayName } from "@/lib/availability-rules";

interface EventLinksSheetProps {
  open: boolean;
  onClose: () => void;
}

type LinkRow = {
  key: string;
  kind: "general" | "office_hours";
  name: string;
  url: string;
};

export function EventLinksSheet({ open, onClose }: EventLinksSheetProps) {
  const [mounted, setMounted] = useState(false);
  const [rows, setRows] = useState<LinkRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    if (open) setMounted(true);
  }, [open]);

  // Same data source as MyLinksPopover; no new endpoint. Re-fetch each time the
  // sheet opens so a freshly-created link appears without a page reload.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoaded(false);
    fetch("/api/tuner/preferences")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        const origin = typeof window !== "undefined" ? window.location.origin : "";
        const slug = data.meetSlug as string | null | undefined;
        const out: LinkRow[] = [];
        if (slug) {
          out.push({
            key: "general",
            kind: "general",
            name: (data.generalLinkName as string) || "Standard link",
            url: `${origin}/meet/${slug}`,
          });
          const structured = (data.structuredRules as AvailabilityRule[]) ?? [];
          for (const r of structured) {
            if (r.action !== "office_hours" || r.status !== "active" || !r.officeHours) continue;
            const oh = r.officeHours;
            if (!oh.linkCode || !oh.linkSlug) continue;
            out.push({
              key: r.id,
              kind: "office_hours",
              name: getOfficeHoursDisplayName(oh),
              url: `${origin}/meet/${oh.linkSlug}/${oh.linkCode}`,
            });
          }
        }
        setRows(out);
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  if (!mounted) return null;

  function copy(row: LinkRow) {
    if (typeof navigator === "undefined" || !navigator.clipboard) return;
    navigator.clipboard.writeText(row.url);
    setCopied(row.key);
    setTimeout(() => setCopied((c) => (c === row.key ? null : c)), 1500);
  }

  return (
    <div
      className={`fixed inset-0 z-[60] md:hidden transition-opacity duration-200 ${
        open ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
      }`}
      aria-hidden={!open}
      data-testid="mobile-event-links-sheet"
    >
      {/* Overlay — tap to close. `top-12` mirrors the mockup `links-overlay`
          starting below the topbar so the avatar/calendar icon remain
          visible. */}
      <button
        type="button"
        onClick={onClose}
        className="absolute inset-x-0 top-12 bottom-0 bg-black/55"
        aria-label="Close Event Links"
        tabIndex={open ? 0 : -1}
      />

      {/* Sheet panel — slides up from the bottom */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="mobile-event-links-title"
        className={`absolute inset-x-0 bottom-0 bg-surface border-t border-secondary rounded-t-[18px] max-h-[88%] overflow-y-auto px-4 py-3 transition-transform duration-300 ease-out ${
          open ? "translate-y-0" : "translate-y-full"
        }`}
      >
        {/* Sheet handle */}
        <div className="w-10 h-1 rounded-full bg-secondary mx-auto mb-3" />

        <div className="flex items-center justify-between mb-2">
          <h3 id="mobile-event-links-title" className="text-base font-semibold text-primary tracking-tight">
            Event Links
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="w-7 h-7 rounded-full bg-surface-secondary/80 flex items-center justify-center text-secondary hover:text-primary"
            aria-label="Close"
            data-testid="mobile-event-links-close"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Reusable links group — re-uses MyLinksPopover's data source. PR 7
            redesigns the cards (URL + copy chip on each, "Create a reusable
            link" tile, etc.). */}
        <div className="text-[10px] font-semibold tracking-wider uppercase text-muted mt-2 mb-2 px-1">
          Reusable links
        </div>
        {!loaded ? (
          <div className="px-3 py-2 text-xs text-muted">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="px-3 py-2 text-xs text-muted">No links yet.</div>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {rows.map((r) => (
              <li
                key={r.key}
                className={`p-3 rounded-xl border ${
                  r.kind === "general" ? "border-accent/40 bg-accent-surface/30" : "border-secondary bg-surface-secondary/40"
                } flex items-center gap-2`}
                data-testid={`mobile-event-links-row-${r.kind}`}
              >
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-semibold text-primary truncate">
                    {r.name}
                    {r.kind === "general" && (
                      <span className="ml-1.5 text-[9px] uppercase tracking-wide text-muted font-normal">
                        default
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] font-mono text-muted truncate">
                    {r.url.replace(/^https?:\/\//, "")}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => copy(r)}
                  className="text-[10px] px-2 py-1 rounded bg-surface border border-secondary text-secondary hover:border-accent hover:text-accent transition flex-shrink-0"
                  title="Copy link"
                >
                  {copied === r.key ? "Copied" : "Copy"}
                </button>
              </li>
            ))}
          </ul>
        )}

        {/* Upcoming events — single hand-off row for PR 3. PR 7 replaces this
            with the filterable list. */}
        <div className="text-[10px] font-semibold tracking-wider uppercase text-muted mt-5 mb-2 px-1">
          Upcoming events
        </div>
        <Link
          href="/dashboard/meetings"
          onClick={onClose}
          className="block p-3 rounded-xl border border-secondary bg-surface-secondary/40 hover:border-accent/40 transition flex items-center justify-between"
          data-testid="mobile-event-links-upcoming"
        >
          <span className="text-sm text-primary">Upcoming events</span>
          <span aria-hidden className="text-muted">›</span>
        </Link>

        <div className="text-[10px] text-muted text-center mt-4 px-2 leading-relaxed">
          The full Event Links surface — reusable cards with copy + edit, and a filterable
          upcoming-events list — ships in a follow-up.
        </div>
      </div>
    </div>
  );
}
