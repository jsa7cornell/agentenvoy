"use client";

/**
 * Primary-link settings panel — host-set guest-flexibility toggles for the
 * default /meet/{slug} link.
 *
 * Reusable-link guest-picks proposal, decided 2026-04-28. Persists via PUT
 * /api/me/primary-link-settings; the same toggles also exist per-Office-Hours-
 * rule on the rule editor at /dashboard/availability. Both default `false` —
 * guests cannot change format or duration unless the host explicitly opts in.
 */

import { useState } from "react";
import Link from "next/link";

interface PrimaryLinkGuestPicks {
  format?: boolean;
  duration?: boolean;
}

export function PrimaryLinkSettings({
  initial,
}: {
  initial: PrimaryLinkGuestPicks | null;
}) {
  const [guestPicks, setGuestPicks] = useState<PrimaryLinkGuestPicks>(
    initial ?? {},
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedTick, setSavedTick] = useState(false);

  async function persist(next: PrimaryLinkGuestPicks) {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/me/primary-link-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ guestPicks: next }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
      setSavedTick(true);
      setTimeout(() => setSavedTick(false), 1500);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
      // Revert local state to the previous value on error.
      setGuestPicks(initial ?? {});
    } finally {
      setSaving(false);
    }
  }

  function setField(field: "format" | "duration", checked: boolean) {
    const next = { ...guestPicks, [field]: checked };
    setGuestPicks(next);
    void persist(next);
  }

  return (
    <div className="mt-4 rounded-xl border border-DEFAULT bg-surface-secondary p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-[11px] font-bold uppercase tracking-widest text-muted">
          Guest flexibility
        </h3>
        {savedTick && (
          <span className="text-[10px] text-emerald-400">✓ Saved</span>
        )}
        {error && (
          <span className="text-[10px] text-red-400">{error}</span>
        )}
      </div>
      <div className="flex flex-col gap-2.5">
        <label className="flex items-center gap-2 cursor-pointer text-[12.5px] text-primary">
          <input
            type="checkbox"
            className="rounded border-zinc-600 text-indigo-600 focus:ring-indigo-500 focus:ring-offset-0 h-4 w-4"
            checked={!!guestPicks.format}
            onChange={(e) => setField("format", e.target.checked)}
            disabled={saving}
          />
          Let guests change format
          <span className="text-muted text-[11px]">(phone / video / in-person)</span>
        </label>
        <label className="flex items-center gap-2 cursor-pointer text-[12.5px] text-primary">
          <input
            type="checkbox"
            className="rounded border-zinc-600 text-indigo-600 focus:ring-indigo-500 focus:ring-offset-0 h-4 w-4"
            checked={!!guestPicks.duration}
            onChange={(e) => setField("duration", e.target.checked)}
            disabled={saving}
          />
          Let guests change duration
          <span className="text-muted text-[11px]">(longer or shorter slot)</span>
        </label>
      </div>
      <p className="text-[11px] text-muted mt-3 leading-snug">
        Off by default. When on, guests can ask for a different format or length in chat
        and the meeting locks to their pick (within sensible bounds).
      </p>
      <Link href="/dashboard/availability" className="text-[11px] font-medium text-accent hover:text-accent-hover transition mt-3 inline-block">
        Manage rules →
      </Link>
    </div>
  );
}
