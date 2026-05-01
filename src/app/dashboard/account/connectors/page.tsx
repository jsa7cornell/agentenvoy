"use client";

/**
 * /dashboard/account/connectors — Personal Access Token (PAT) management UI.
 *
 * Lets a host mint, list, and revoke PATs that authenticate their own AI
 * (Claude Code, Claude.ai, ChatGPT, etc.) to act on their behalf via the
 * host-MCP surface at /api/mcp/host.
 *
 * Plaintext is shown ONCE on mint — never re-fetchable. UI surfaces this
 * loudly via a dismiss-required banner. Backend in:
 *   - POST   /api/host/tokens          (mint)
 *   - GET    /api/host/tokens          (list active)
 *   - DELETE /api/host/tokens/:id      (revoke)
 *
 * Workstream E (single-fetch agent surface follow-up). Per-token call log
 * ("what did this AI do?") is deferred to a follow-up.
 */
import { useEffect, useState } from "react";
import Link from "next/link";

type Scope = "read" | "schedule" | "admin";

const SCOPE_DESCRIPTIONS: Record<Scope, { label: string; description: string }> = {
  read: {
    label: "Read",
    description: "View your availability and see your scheduled meetings.",
  },
  schedule: {
    label: "Schedule",
    description: "Create new links and reschedule confirmed meetings on your behalf.",
  },
  admin: {
    label: "Admin (advanced)",
    description: "Manage tokens and view audit logs. Most agents do not need this.",
  },
};

interface ListedToken {
  id: string;
  displayId: string;
  name: string;
  scopes: string[];
  lastUsedAt: string | null;
  createdAt: string;
  expiresAt: string | null;
}

interface MintedToken {
  id: string;
  displayId: string;
  name: string;
  scopes: string[];
  createdAt: string;
  plaintext: string;
}

const ENDPOINT_URL =
  typeof window !== "undefined"
    ? `${window.location.origin}/api/mcp/host`
    : "https://agentenvoy.ai/api/mcp/host";

export default function ConnectorsPage() {
  const [tokens, setTokens] = useState<ListedToken[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [selectedScopes, setSelectedScopes] = useState<Set<Scope>>(
    new Set<Scope>(["read", "schedule"]),
  );
  const [minting, setMinting] = useState(false);
  const [mintError, setMintError] = useState<string | null>(null);
  const [justMinted, setJustMinted] = useState<MintedToken | null>(null);

  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  const [showInstructions, setShowInstructions] = useState(false);
  const [copied, setCopied] = useState(false);

  async function reloadTokens() {
    try {
      const res = await fetch("/api/host/tokens");
      if (!res.ok) {
        setLoadError(res.status === 401 ? "Sign in required" : `Failed to load tokens (${res.status})`);
        return;
      }
      const json = (await res.json()) as { tokens: ListedToken[] };
      setTokens(json.tokens);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Network error");
    }
  }

  useEffect(() => {
    void reloadTokens();
  }, []);

  function toggleScope(scope: Scope) {
    const next = new Set(selectedScopes);
    if (next.has(scope)) next.delete(scope);
    else next.add(scope);
    setSelectedScopes(next);
  }

  async function handleMint(e: React.FormEvent) {
    e.preventDefault();
    if (minting) return;
    if (!name.trim()) {
      setMintError("Give the token a name so you can identify it later.");
      return;
    }
    if (selectedScopes.size === 0) {
      setMintError("Pick at least one scope.");
      return;
    }
    setMinting(true);
    setMintError(null);
    try {
      const res = await fetch("/api/host/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          scopes: Array.from(selectedScopes),
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setMintError(typeof json?.error === "string" ? json.error : `Failed (${res.status})`);
        return;
      }
      setJustMinted(json as MintedToken);
      setName("");
      setSelectedScopes(new Set<Scope>(["read", "schedule"]));
      await reloadTokens();
    } catch (e) {
      setMintError(e instanceof Error ? e.message : "Network error");
    } finally {
      setMinting(false);
    }
  }

  async function handleRevoke(token: ListedToken) {
    if (revokingId) return;
    if (
      !window.confirm(
        `Revoke "${token.name}"? Any AI using this token will lose access immediately.`,
      )
    ) {
      return;
    }
    setRevokingId(token.id);
    setRevokeError(null);
    try {
      const res = await fetch(`/api/host/tokens/${token.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        setRevokeError(`Failed to revoke (${res.status})`);
        return;
      }
      await reloadTokens();
    } catch (e) {
      setRevokeError(e instanceof Error ? e.message : "Network error");
    } finally {
      setRevokingId(null);
    }
  }

  async function copyPlaintext() {
    if (!justMinted) return;
    try {
      await navigator.clipboard.writeText(justMinted.plaintext);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard failed — user can still copy manually.
    }
  }

  return (
    <main className="flex-1 overflow-y-auto bg-surface">
      <div className="max-w-3xl mx-auto w-full px-4 sm:px-6 lg:px-8 py-8 space-y-8">
        {/* Back link */}
        <div>
          <Link
            href="/dashboard/account"
            className="text-xs text-muted hover:text-secondary transition"
          >
            ← Back to Preferences
          </Link>
        </div>

        {/* Page heading */}
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-primary">Connectors</h1>
          <p className="text-sm text-muted mt-1">
            Connect Claude (or another AI) to AgentEnvoy. Tokens let your AI act
            on your behalf — read your calendar, mint links, reschedule meetings.
          </p>
        </div>

        {/* Just-minted plaintext banner — shown once, dismiss required */}
        {justMinted && (
          <section
            role="alert"
            className="rounded-xl border border-amber-300 dark:border-amber-700/60 bg-amber-50 dark:bg-amber-900/15 p-4 space-y-3"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-sm font-semibold text-amber-900 dark:text-amber-200">
                  New token: {justMinted.name}
                </h2>
                <p className="text-xs text-amber-800 dark:text-amber-300 mt-1">
                  Copy this token now — it&apos;s shown once and never again.
                  AgentEnvoy stores only a hash, not the plaintext.
                </p>
              </div>
              <button
                onClick={() => setJustMinted(null)}
                className="text-xs text-amber-700 dark:text-amber-300 hover:underline whitespace-nowrap"
              >
                I&apos;ve saved it
              </button>
            </div>
            <div className="flex items-center gap-2">
              <code className="flex-1 min-w-0 text-xs font-mono bg-white/70 dark:bg-black/30 border border-amber-200 dark:border-amber-700/40 rounded-md px-3 py-2 break-all">
                {justMinted.plaintext}
              </code>
              <button
                onClick={copyPlaintext}
                className="px-3 py-2 bg-amber-600 hover:bg-amber-700 text-white text-xs font-medium rounded-md transition whitespace-nowrap"
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          </section>
        )}

        {/* Mint form */}
        <section>
          <h2 className="text-[10px] font-bold uppercase tracking-widest text-muted mb-3">
            Mint a new token
          </h2>
          <form
            onSubmit={handleMint}
            className="rounded-xl border border-secondary bg-surface-inset/50 p-4 space-y-4"
          >
            <div>
              <label className="block text-xs font-medium text-secondary mb-1.5">
                Name
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. My Claude desktop"
                maxLength={100}
                className="w-full max-w-sm bg-surface-secondary/60 border border-surface-tertiary/50 rounded-lg px-3 py-2 text-sm text-primary placeholder:text-muted focus:outline-none focus:border-indigo-500 transition"
              />
              <p className="text-[10px] text-muted mt-1">
                Helps you identify the token if you need to revoke it.
              </p>
            </div>

            <div>
              <label className="block text-xs font-medium text-secondary mb-1.5">
                Scopes
              </label>
              <div className="space-y-2">
                {(Object.keys(SCOPE_DESCRIPTIONS) as Scope[]).map((scope) => (
                  <label
                    key={scope}
                    className="flex items-start gap-2.5 cursor-pointer p-2 rounded hover:bg-surface-secondary/30 transition"
                  >
                    <input
                      type="checkbox"
                      checked={selectedScopes.has(scope)}
                      onChange={() => toggleScope(scope)}
                      className="mt-0.5 h-4 w-4 rounded border-surface-tertiary text-indigo-600 focus:ring-indigo-500"
                    />
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-primary">
                        {SCOPE_DESCRIPTIONS[scope].label}
                      </div>
                      <div className="text-xs text-muted">
                        {SCOPE_DESCRIPTIONS[scope].description}
                      </div>
                    </div>
                  </label>
                ))}
              </div>
            </div>

            {mintError && (
              <p className="text-xs text-red-500 dark:text-red-400">{mintError}</p>
            )}

            <div>
              <button
                type="submit"
                disabled={minting || !name.trim() || selectedScopes.size === 0}
                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:bg-surface-tertiary disabled:text-muted text-white text-sm font-medium rounded-lg transition"
              >
                {minting ? "Minting…" : "Mint token"}
              </button>
            </div>
          </form>
        </section>

        {/* Active tokens */}
        <section>
          <h2 className="text-[10px] font-bold uppercase tracking-widest text-muted mb-3">
            Active tokens
          </h2>
          {revokeError && (
            <p className="text-xs text-red-500 dark:text-red-400 mb-2">{revokeError}</p>
          )}
          {loadError ? (
            <p className="text-sm text-red-500 dark:text-red-400">{loadError}</p>
          ) : tokens === null ? (
            <p className="text-sm text-muted">Loading…</p>
          ) : tokens.length === 0 ? (
            <div className="rounded-xl border border-dashed border-secondary bg-surface-inset/30 px-4 py-6 text-center">
              <p className="text-sm text-muted">
                No tokens yet. Mint one above to connect Claude or another AI.
              </p>
            </div>
          ) : (
            <ul className="space-y-2">
              {tokens.map((token) => (
                <li
                  key={token.id}
                  className="rounded-xl border border-secondary bg-surface-inset/30 p-3 sm:p-4 flex items-start justify-between gap-4"
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-primary truncate">
                      {token.name}
                    </div>
                    <div className="flex flex-wrap gap-1 mt-1">
                      {token.scopes.map((s) => (
                        <span
                          key={s}
                          className="text-[10px] font-medium uppercase tracking-wide text-secondary bg-surface-secondary/70 border border-surface-tertiary/40 rounded px-1.5 py-0.5"
                        >
                          {s}
                        </span>
                      ))}
                    </div>
                    <div className="text-[11px] text-muted mt-1.5">
                      <span className="font-mono">{token.displayId}</span>
                      <span className="mx-1.5">·</span>
                      <span>
                        {token.lastUsedAt
                          ? `Last used ${formatRelative(token.lastUsedAt)}`
                          : "Never used"}
                      </span>
                    </div>
                  </div>
                  <button
                    onClick={() => handleRevoke(token)}
                    disabled={revokingId === token.id}
                    className="text-xs text-red-500 dark:text-red-400 hover:underline disabled:opacity-50 whitespace-nowrap"
                  >
                    {revokingId === token.id ? "Revoking…" : "Revoke"}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* How-to instructions (collapsed by default) */}
        <section>
          <button
            onClick={() => setShowInstructions((v) => !v)}
            className="w-full flex items-center justify-between text-left rounded-xl border border-secondary bg-surface-inset/30 px-4 py-3 hover:bg-surface-inset/50 transition"
          >
            <span className="text-sm font-medium text-primary">
              How to connect Claude (or another AI)
            </span>
            <span className="text-muted">{showInstructions ? "▾" : "▸"}</span>
          </button>
          {showInstructions && (
            <div className="mt-3 rounded-xl border border-secondary bg-surface-inset/30 p-4 space-y-4 text-sm text-secondary">
              <div>
                <h3 className="text-xs font-semibold text-primary uppercase tracking-wide mb-1.5">
                  Claude.ai (custom connector)
                </h3>
                <ol className="list-decimal list-inside space-y-1 text-xs">
                  <li>Mint a token above and copy the plaintext.</li>
                  <li>
                    In Claude.ai, go to Settings → Custom Connectors → Add MCP
                    server.
                  </li>
                  <li>
                    URL: <code className="text-xs bg-surface-secondary/60 px-1.5 py-0.5 rounded">{ENDPOINT_URL}</code>
                  </li>
                  <li>
                    Auth header:{" "}
                    <code className="text-xs bg-surface-secondary/60 px-1.5 py-0.5 rounded">
                      Authorization: Bearer &lt;your token&gt;
                    </code>
                  </li>
                  <li>
                    Then ask Claude things like: <em>&quot;what does my calendar look
                    like next week?&quot;</em> or <em>&quot;create a 30-min coffee link for Maria.&quot;</em>
                  </li>
                </ol>
              </div>
              <div>
                <h3 className="text-xs font-semibold text-primary uppercase tracking-wide mb-1.5">
                  Test with curl
                </h3>
                <pre className="text-[11px] bg-surface-secondary/60 border border-surface-tertiary/40 rounded-md p-2.5 overflow-x-auto">{`curl -X POST ${ENDPOINT_URL} \\
  -H "Authorization: Bearer <your token>" \\
  -H "Content-Type: application/json" \\
  -H "Accept: application/json, text/event-stream" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'`}</pre>
              </div>
              <p className="text-xs text-muted">
                Lost a token? Revoke it above and mint a new one. Tokens are
                stored as a hash; even AgentEnvoy can&apos;t recover the plaintext.
              </p>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? "" : "s"} ago`;
  const years = Math.floor(months / 12);
  return `${years} year${years === 1 ? "" : "s"} ago`;
}
