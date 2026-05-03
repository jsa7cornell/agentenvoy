"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import type { AvailabilityPreference } from "@/lib/availability-rules";
import { getBookableLinkDisplayName } from "@/lib/availability-rules";

type LinkRow = {
  key: string;
  kind: "primary" | "bookable";
  name: string;
  url: string;
  ruleId?: string;
};

export function prefillComposer(text: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent("envoy:prefill-composer", { detail: text }),
  );
}

export function MyLinksPopover() {
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<LinkRow[]>([]);
  const [copied, setCopied] = useState<string | null>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetch("/api/tuner/preferences")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        const origin = window.location.origin;
        const slug = data.meetSlug as string | null | undefined;
        if (!slug) return;
        const out: LinkRow[] = [];
        out.push({
          key: "primary",
          kind: "primary",
          // TODO(vocab-cleanup): remove primaryLinkName || generalLinkName fallback after migration
          name: (data.primaryLinkName as string) || (data.generalLinkName as string) || "Primary link",
          url: `${origin}/meet/${slug}`,
        });
        const structured = (data.structuredRules as AvailabilityPreference[]) ?? [];
        for (const r of structured) {
          // TODO(vocab-cleanup): remove || "office_hours" after migration
          const bookableData = r.bookable ?? (r as unknown as { officeHours?: typeof r.bookable }).officeHours;
          if ((r.action !== "bookable" && r.action !== ("office_hours" as string)) || r.status !== "active" || !bookableData) continue;
          const oh = bookableData;
          if (!oh.linkCode || !oh.linkSlug) continue;
          out.push({
            key: r.id,
            kind: "bookable",
            name: getBookableLinkDisplayName(oh),
            url: `${origin}/meet/${oh.linkSlug}/${oh.linkCode}`,
            ruleId: r.id,
          });
        }
        setRows(out);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      const t = e.target as Node;
      if (rootRef.current?.contains(t)) return;
      setOpen(false);
    }
    function onEsc(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  function copy(row: LinkRow) {
    navigator.clipboard.writeText(row.url);
    setCopied(row.key);
    setTimeout(() => setCopied((c) => (c === row.key ? null : c)), 1500);
  }

  function editName(row: LinkRow) {
    const text = row.kind === "primary"
      ? `Rename my Primary link to `
      : `Rename my "${row.name}" link to `;
    setOpen(false);
    if (pathname !== "/dashboard" && pathname !== "/dashboard/") {
      router.push("/dashboard");
    }
    setTimeout(() => prefillComposer(text), 60);
  }

  function createBookableLink() {
    setOpen(false);
    if (pathname !== "/dashboard" && pathname !== "/dashboard/") {
      router.push("/dashboard");
    }
    setTimeout(() => prefillComposer("Create a drop-in hours link"), 60);
  }

  const primaryRow = rows.find((r) => r.kind === "primary");
  const label = primaryRow?.name || "Links";

  return (
    <div className="relative" ref={rootRef}>
      {/* Desktop trigger — pill showing Primary link name */}
      <button
        ref={btnRef}
        onClick={() => setOpen((o) => !o)}
        className="hidden sm:flex items-center gap-2 bg-surface-secondary/60 border border-surface-tertiary/50 rounded-full pl-3 pr-2.5 py-1 hover:border-purple-500/40 transition max-w-[280px]"
        title="My links"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <svg className="w-3.5 h-3.5 text-purple-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m9.86-2.776a4.5 4.5 0 00-1.242-7.244l-4.5-4.5a4.5 4.5 0 00-6.364 6.364L4.25 8.016" />
        </svg>
        <span className="text-xs font-mono text-purple-400 truncate">{label}</span>
        <span className="text-[10px] text-muted">▾</span>
      </button>

      {/* Mobile trigger */}
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex sm:hidden items-center justify-center w-7 h-7 rounded-lg bg-surface-secondary/60 border border-surface-tertiary/50 hover:border-purple-500/40 transition"
        title="My links"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <svg className="w-3.5 h-3.5 text-purple-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m9.86-2.776a4.5 4.5 0 00-1.242-7.244l-4.5-4.5a4.5 4.5 0 00-6.364 6.364L4.25 8.016" />
        </svg>
      </button>

      {open && (
        <div
          ref={popRef}
          role="menu"
          className="absolute left-0 mt-2 w-[340px] max-w-[calc(100vw-2rem)] bg-surface border border-surface-tertiary/70 rounded-xl shadow-xl py-1.5 z-[60]"
        >
          <div className="px-3 py-1.5 text-[10px] uppercase tracking-wide text-muted">My links</div>
          {rows.length === 0 ? (
            <div className="px-3 py-2 text-xs text-muted">Loading…</div>
          ) : (
            <ul className="max-h-[320px] overflow-y-auto">
              {rows.map((r) => (
                <li key={r.key} className="group flex items-center gap-2 px-2 py-1.5 hover:bg-surface-secondary/60 rounded-md mx-1">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-medium text-primary truncate">{r.name}</span>
                      {r.kind === "primary" && (
                        <span className="text-[9px] uppercase tracking-wide text-muted">default</span>
                      )}
                    </div>
                    <div className="text-[11px] font-mono text-muted truncate">{r.url.replace(/^https?:\/\//, "")}</div>
                  </div>
                  <button
                    onClick={() => copy(r)}
                    className="text-[10px] px-2 py-1 rounded bg-surface-secondary/80 hover:bg-surface-tertiary text-secondary"
                    title="Copy link"
                  >
                    {copied === r.key ? <span className="text-emerald-400">Copied</span> : "Copy"}
                  </button>
                  <button
                    onClick={() => editName(r)}
                    className="opacity-0 group-hover:opacity-100 transition w-6 h-6 rounded flex items-center justify-center text-muted hover:text-primary hover:bg-surface-tertiary"
                    title="Rename"
                    aria-label={`Rename ${r.name}`}
                  >
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931z" />
                    </svg>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="border-t border-surface-tertiary/50 mt-1 pt-1 px-1">
            <button
              onClick={createBookableLink}
              className="w-full text-left px-2 py-1.5 text-xs text-secondary hover:bg-surface-secondary/60 rounded-md flex items-center gap-2"
            >
              <span className="text-purple-400">+</span> Create Drop-in Hours link
            </button>
            <Link
              href="/dashboard/my-links"
              onClick={() => setOpen(false)}
              className="block px-2 py-1.5 text-xs text-muted hover:text-primary hover:bg-surface-secondary/60 rounded-md"
            >
              All my links →
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
