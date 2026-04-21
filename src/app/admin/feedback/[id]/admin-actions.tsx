"use client";

/**
 * Client-side actions panel for /admin/feedback/[id]:
 *   - Status dropdown → PATCH /api/admin/feedback/[id]
 *   - "Share with agent" → POST /api/admin/feedback/[id]/mint-token
 *   - "Revoke" on each active token → POST /api/admin/feedback/[id]/revoke-token
 *
 * The minted JWT is shown ONCE with `Referrer-Policy: no-referrer` on the
 * response. The admin copies it for curl (proposal §2 + §6.6).
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

type Status = "new" | "acknowledged" | "in_progress" | "resolved" | "wontfix";
const STATUS_OPTIONS: Status[] = [
  "new",
  "acknowledged",
  "in_progress",
  "resolved",
  "wontfix",
];

export interface ActiveToken {
  id: string;
  jti: string;
  mintedByEmail: string | null;
  createdAt: string;
  expiresAt: string;
  fetchCount: number;
}

export interface MintResult {
  jti: string;
  token: string;
  expiresAt: string;
  ttlSeconds: number;
  fetchUrl: string;
  curl: string;
}

export function AdminActionsPanel(props: {
  reportId: string;
  currentStatus: string;
  activeTokens: ActiveToken[];
}) {
  const router = useRouter();
  const [status, setStatus] = useState<string>(props.currentStatus);
  const [savingStatus, setSavingStatus] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);

  const [mintResult, setMintResult] = useState<MintResult | null>(null);
  const [mintError, setMintError] = useState<string | null>(null);
  const [minting, setMinting] = useState(false);

  const [, startTransition] = useTransition();

  async function onStatusChange(next: string) {
    setSavingStatus(true);
    setStatusError(null);
    try {
      const res = await fetch(`/api/admin/feedback/${props.reportId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      setStatus(next);
      startTransition(() => router.refresh());
    } catch (e) {
      setStatusError(e instanceof Error ? e.message : "Could not update status");
    } finally {
      setSavingStatus(false);
    }
  }

  async function onMint() {
    const ok = window.confirm(
      "Share this report with an agent?\n\n" +
        "You're about to mint a 15-minute signed link granting read-only access to this report's bundle (which may include PII). Expected use: debug only. Every fetch is audited.",
    );
    if (!ok) return;
    setMintError(null);
    setMintResult(null);
    setMinting(true);
    try {
      const res = await fetch(
        `/api/admin/feedback/${props.reportId}/mint-token`,
        { method: "POST", headers: { "Content-Type": "application/json" } },
      );
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(body?.detail ?? body?.error ?? `HTTP ${res.status}`);
      }
      setMintResult(body as MintResult);
      startTransition(() => router.refresh());
    } catch (e) {
      setMintError(e instanceof Error ? e.message : "Could not mint token");
    } finally {
      setMinting(false);
    }
  }

  async function onRevoke(jti?: string) {
    const ok = window.confirm(
      jti
        ? "Revoke this token immediately? Any in-flight agent fetch will get a 410."
        : "Revoke ALL active tokens on this report?",
    );
    if (!ok) return;
    try {
      const res = await fetch(
        `/api/admin/feedback/${props.reportId}/revoke-token`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(jti ? { jti } : {}),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      startTransition(() => router.refresh());
    } catch (e) {
      alert(e instanceof Error ? e.message : "Could not revoke");
    }
  }

  return (
    <section className="mb-5 rounded-lg border border-zinc-800 bg-zinc-900/60 p-5">
      <h2 className="mb-3 text-xs uppercase tracking-wider text-zinc-500">
        Admin actions
      </h2>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <label className="text-xs uppercase tracking-wide text-zinc-400">
            Status
          </label>
          <select
            value={status}
            disabled={savingStatus}
            onChange={(e) => onStatusChange(e.target.value)}
            className="rounded-lg border border-white/10 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-100 focus:border-sky-500/60 focus:outline-none disabled:opacity-50"
          >
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          {statusError ? (
            <span className="text-xs text-red-400">{statusError}</span>
          ) : null}
        </div>

        <div>
          <div className="mb-2 flex items-center gap-3">
            <button
              type="button"
              onClick={onMint}
              disabled={minting}
              className="rounded-lg border border-sky-500/40 bg-sky-500/10 px-3 py-1.5 text-xs font-medium text-sky-200 hover:bg-sky-500/20 disabled:opacity-50"
            >
              {minting ? "Minting…" : "Share with agent (15 min)"}
            </button>
            {props.activeTokens.length > 0 ? (
              <button
                type="button"
                onClick={() => onRevoke()}
                className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-xs font-medium text-red-200 hover:bg-red-500/20"
              >
                Revoke all
              </button>
            ) : null}
            {mintError ? (
              <span className="text-xs text-red-400">{mintError}</span>
            ) : null}
          </div>

          {mintResult ? (
            <div className="mt-2 rounded-md border border-sky-500/30 bg-sky-500/5 p-3 text-xs">
              <p className="mb-2 text-sky-200">
                Token minted. Expires{" "}
                <span className="font-mono">
                  {new Date(mintResult.expiresAt).toISOString().replace("T", " ").slice(0, 19)}Z
                </span>
                . Copy now — not shown again.
              </p>
              <label className="block">
                <span className="text-zinc-400">curl</span>
                <textarea
                  readOnly
                  rows={3}
                  value={mintResult.curl}
                  className="mt-1 w-full resize-none rounded border border-white/10 bg-black/60 px-2 py-1 font-mono text-[11px] text-zinc-200"
                />
              </label>
            </div>
          ) : null}
        </div>

        {props.activeTokens.length > 0 ? (
          <div>
            <h3 className="mb-2 text-[10px] uppercase tracking-wider text-zinc-500">
              Active tokens
            </h3>
            <ul className="space-y-1 text-xs">
              {props.activeTokens.map((t) => (
                <li
                  key={t.id}
                  className="flex items-center justify-between gap-3 rounded border border-zinc-800 bg-black/40 px-2 py-1"
                >
                  <div className="flex flex-col">
                    <span className="font-mono text-zinc-300">
                      {t.jti.slice(0, 8)}…
                    </span>
                    <span className="text-[10px] text-zinc-500">
                      minted by {t.mintedByEmail ?? "—"} · {t.fetchCount}/10 fetches
                      · expires {new Date(t.expiresAt).toISOString().slice(11, 19)}Z
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => onRevoke(t.jti)}
                    className="rounded border border-red-500/40 px-2 py-0.5 text-[11px] text-red-200 hover:bg-red-500/20"
                  >
                    Revoke
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </section>
  );
}
