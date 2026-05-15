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
 */
import { useEffect, useState, useRef } from "react";
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

const MCP_URL = "https://agentenvoy.ai/api/mcp/host";

function buildClaudeCodeCli(token: string) {
  return `claude mcp add --transport http agentenvoy ${MCP_URL} --header "Authorization: Bearer ${token}"`;
}

function buildMcpConfig(token: string) {
  return JSON.stringify(
    {
      mcpServers: {
        agentenvoy: {
          type: "http",
          url: MCP_URL,
          headers: {
            Authorization: `Bearer ${token}`,
          },
        },
      },
    },
    null,
    2,
  );
}

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

  const [copiedToken, setCopiedToken] = useState(false);
  const [copiedConfig, setCopiedConfig] = useState(false);
  const [copiedSetupConfig, setCopiedSetupConfig] = useState(false);

  // Whether the user has expanded the "Already have a token?" setup section
  const [setupExpanded, setSetupExpanded] = useState(false);
  const mintBannerRef = useRef<HTMLDivElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  // Test-connection state for the freshly-minted token
  const [verifyState, setVerifyState] = useState<"idle" | "verifying" | "ok" | "fail">("idle");
  const [verifyMessage, setVerifyMessage] = useState<string>("");
  const [copiedCli, setCopiedCli] = useState(false);

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

  // Scroll to banner when a token is freshly minted
  useEffect(() => {
    if (justMinted && mintBannerRef.current) {
      mintBannerRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [justMinted]);

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
      nameInputRef.current?.focus();
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
      setVerifyState("idle");
      setVerifyMessage("");
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

  async function handleVerify() {
    if (!justMinted || verifyState === "verifying") return;
    setVerifyState("verifying");
    setVerifyMessage("");
    try {
      const res = await fetch("/api/host/tokens/verify", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${justMinted.plaintext}`,
        },
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok && json?.ok) {
        setVerifyState("ok");
        const scopeList = Array.isArray(json.scopes) ? json.scopes.join(", ") : "";
        setVerifyMessage(scopeList ? `Token works — granted: ${scopeList}` : "Token works");
      } else {
        setVerifyState("fail");
        setVerifyMessage(json?.reason ?? `HTTP ${res.status}`);
      }
    } catch (e) {
      setVerifyState("fail");
      setVerifyMessage(e instanceof Error ? e.message : "Network error");
    }
  }

  async function copyText(text: string, setCopied: (v: boolean) => void) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable — user can copy manually.
    }
  }

  const placeholderConfig = buildMcpConfig("agentenvoy_pat_live_YOUR_TOKEN_HERE");

  return (
    <main className="flex-1 overflow-y-auto bg-surface">
      <div className="max-w-3xl mx-auto w-full px-4 sm:px-6 lg:px-8 py-8 space-y-10">

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
          <h1 className="text-2xl font-semibold tracking-tight text-primary">Connect your AI</h1>
          <p className="text-sm text-muted mt-1.5 leading-relaxed">
            Give Claude (or another MCP-compatible AI) a token and it can act as you on AgentEnvoy —
            reading your calendar, creating meeting links, and rescheduling confirmed meetings.
          </p>
        </div>

        {/* Hosted-client notice — Claude.ai web, ChatGPT, etc. need OAuth */}
        <div className="rounded-xl border border-secondary bg-surface-inset/30 p-4 flex items-start gap-3">
          <svg className="w-4 h-4 text-muted shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <div className="text-xs leading-relaxed">
            <p className="text-primary font-medium">Heads up: hosted clients aren&apos;t supported yet.</p>
            <p className="text-muted mt-1">
              Claude.ai (web/desktop) and ChatGPT custom connectors require OAuth, which AgentEnvoy
              hasn&apos;t shipped yet. For now, the working clients are{" "}
              <strong className="text-secondary font-medium">Claude Code, Cursor, VS Code, and other config-file based MCP clients</strong>{" "}
              that let you set a static Authorization header.
            </p>
          </div>
        </div>

        {/* What Claude can do */}
        <section>
          <h2 className="text-[10px] font-bold uppercase tracking-widest text-muted mb-4">
            What Claude can do for you
          </h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <CapabilityCard
              icon={
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
              }
              title="Check your real availability"
              description={'Ask Claude "when am I free this week?" and it reads your actual calendar — busy times, preferences, and all — not just a generic response.'}
              scope="read"
            />
            <CapabilityCard
              icon={
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                </svg>
              }
              title="Create meeting links on command"
              description={`Say "make me a 30-minute coffee chat link" and Claude mints a shareable AgentEnvoy URL instantly — no dashboard visit required.`}
              scope="schedule"
            />
            <CapabilityCard
              icon={
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
              }
              title="Reschedule confirmed meetings"
              description="Claude can shift a confirmed meeting to a new time — it patches your Google Calendar event and notifies the other side, all in one step."
              scope="schedule"
            />
            <CapabilityCard
              icon={
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                </svg>
              }
              title="See your scheduled meetings"
              description="Ask Claude to list who you're meeting this week, check whether a session is confirmed, or find a specific meeting — it queries your sessions directly."
              scope="read"
            />
          </div>
          <p className="text-[11px] text-muted mt-3 leading-relaxed">
            Claude only has the access you grant. A <span className="font-medium text-secondary">Read</span> token
            can look but not touch. A <span className="font-medium text-secondary">Schedule</span> token can also
            create links and reschedule — nothing else. You can revoke any token instantly from this page.
          </p>
        </section>

        {/* Just-minted plaintext banner — shown once, dismiss required */}
        {justMinted && (
          <section
            ref={mintBannerRef}
            role="alert"
            className="rounded-xl border border-amber-300 dark:border-amber-700/60 bg-amber-50 dark:bg-amber-900/15 p-5 space-y-5 scroll-mt-6"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-sm font-semibold text-amber-900 dark:text-amber-200">
                  Token minted: {justMinted.name}
                </h2>
                <p className="text-xs text-amber-800 dark:text-amber-300 mt-1">
                  Copy this now — it&apos;s shown once and never again. AgentEnvoy stores only a hash.
                </p>
              </div>
              <button
                onClick={() => setJustMinted(null)}
                className="text-xs text-amber-700 dark:text-amber-300 hover:underline whitespace-nowrap shrink-0"
              >
                I&apos;ve saved it ✓
              </button>
            </div>

            {/* HERO: one-line install command for Claude Code */}
            <div className="rounded-lg border border-emerald-300 dark:border-emerald-700/60 bg-emerald-50 dark:bg-emerald-900/20 p-4 space-y-3">
              <div>
                <p className="text-[10px] font-bold uppercase tracking-widest text-emerald-700 dark:text-emerald-400">
                  Fastest path · Claude Code
                </p>
                <p className="text-sm text-emerald-900 dark:text-emerald-100 mt-1 leading-relaxed">
                  <strong>1.</strong> Copy this command. <strong>2.</strong> Paste it into your Terminal. Done.
                </p>
              </div>
              <div className="relative">
                <pre className="text-[11px] font-mono leading-relaxed bg-white/80 dark:bg-black/40 border border-emerald-200 dark:border-emerald-800/50 rounded-md px-3 py-3 overflow-x-auto whitespace-pre pr-20">
                  {buildClaudeCodeCli(justMinted.plaintext)}
                </pre>
                <button
                  onClick={() => copyText(buildClaudeCodeCli(justMinted.plaintext), setCopiedCli)}
                  className="absolute top-2 right-2 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold rounded-md transition whitespace-nowrap"
                >
                  {copiedCli ? "Copied ✓" : "Copy command"}
                </button>
              </div>
              <div className="flex flex-wrap items-center gap-3 text-xs">
                <button
                  onClick={handleVerify}
                  disabled={verifyState === "verifying"}
                  className="px-3 py-1.5 border border-emerald-400 dark:border-emerald-700 text-emerald-900 dark:text-emerald-200 bg-white/60 dark:bg-black/30 hover:bg-white/90 dark:hover:bg-black/50 rounded-md font-medium transition disabled:opacity-50"
                >
                  {verifyState === "verifying" ? "Testing…" : "Test connection"}
                </button>
                {verifyState === "ok" && (
                  <span className="text-emerald-700 dark:text-emerald-300 font-medium">✓ {verifyMessage}</span>
                )}
                {verifyState === "fail" && (
                  <span className="text-red-700 dark:text-red-400 font-medium">✗ {verifyMessage}</span>
                )}
                {verifyState === "idle" && (
                  <span className="text-emerald-700/70 dark:text-emerald-400/70">
                    Confirm the token works before you paste it anywhere.
                  </span>
                )}
              </div>
            </div>

            {/* Raw token — still shown for advanced users / non-Claude-Code clients */}
            <details className="group">
              <summary className="cursor-pointer text-xs font-medium text-amber-800 dark:text-amber-300 hover:underline list-none flex items-center gap-1.5">
                <svg className="w-3 h-3 transition-transform group-open:rotate-90" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                </svg>
                Show raw token (for Cursor, VS Code, or other clients)
              </summary>
              <div className="mt-3 space-y-3">
                <div className="flex items-center gap-2">
                  <code className="flex-1 min-w-0 text-xs font-mono bg-white/70 dark:bg-black/30 border border-amber-200 dark:border-amber-700/40 rounded-md px-3 py-2 break-all">
                    {justMinted.plaintext}
                  </code>
                  <button
                    onClick={() => copyText(justMinted.plaintext, setCopiedToken)}
                    className="px-3 py-2 bg-amber-600 hover:bg-amber-700 text-white text-xs font-medium rounded-md transition whitespace-nowrap"
                  >
                    {copiedToken ? "Copied" : "Copy"}
                  </button>
                </div>
                <SetupInstructions
                  token={justMinted.plaintext}
                  copiedConfig={copiedConfig}
                  onCopyConfig={() => copyText(buildMcpConfig(justMinted.plaintext), setCopiedConfig)}
                />
              </div>
            </details>
          </section>
        )}

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
                No tokens yet. Mint one below to connect Claude.
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
                ref={nameInputRef}
                type="text"
                value={name}
                onChange={(e) => { setName(e.target.value); if (mintError) setMintError(null); }}
                placeholder="e.g. My Claude on laptop"
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
                disabled={minting}
                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition"
              >
                {minting ? "Minting…" : "Mint token"}
              </button>
            </div>
          </form>
        </section>

        {/* Setup instructions — for users who already have a token */}
        {!justMinted && (
          <section>
            <button
              onClick={() => setSetupExpanded((v) => !v)}
              className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-muted hover:text-secondary transition w-full text-left mb-3"
            >
              <span>Already have a token? Here&apos;s how to add it to Claude</span>
              <svg
                className={`w-3.5 h-3.5 transition-transform ${setupExpanded ? "rotate-180" : ""}`}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {setupExpanded && (
              <SetupInstructions
                token={null}
                copiedConfig={copiedSetupConfig}
                onCopyConfig={() => copyText(placeholderConfig, setCopiedSetupConfig)}
              />
            )}
          </section>
        )}

      </div>
    </main>
  );
}

/** Capability card used in the "What Claude can do" grid */
function CapabilityCard({
  icon,
  title,
  description,
  scope,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  scope: "read" | "schedule";
}) {
  return (
    <div className="rounded-xl border border-secondary bg-surface-inset/40 p-4 space-y-2">
      <div className="flex items-center gap-2.5">
        <span className="text-secondary">{icon}</span>
        <h3 className="text-sm font-medium text-primary leading-tight">{title}</h3>
      </div>
      <p className="text-xs text-muted leading-relaxed">{description}</p>
      <span className="inline-block text-[10px] font-semibold uppercase tracking-wide text-secondary bg-surface-secondary/70 border border-surface-tertiary/40 rounded px-1.5 py-0.5">
        {scope}
      </span>
    </div>
  );
}

type ClientTab = "claude-code" | "cursor" | "vscode" | "other";

const CLIENT_TABS: { id: ClientTab; label: string }[] = [
  { id: "claude-code", label: "Claude Code" },
  { id: "cursor", label: "Cursor" },
  { id: "vscode", label: "VS Code" },
  { id: "other", label: "Other" },
];

/** Client config snippets — each editor expects a slightly different JSON shape */
function buildCursorConfig(token: string) {
  return JSON.stringify(
    {
      mcpServers: {
        agentenvoy: {
          url: MCP_URL,
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    },
    null,
    2,
  );
}

function buildVscodeConfig(token: string) {
  return JSON.stringify(
    {
      servers: {
        agentenvoy: {
          type: "http",
          url: MCP_URL,
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    },
    null,
    2,
  );
}

/** Reusable field table for URL + auth values */
function ConnectionFields({ token, showHeader = false }: { token: string; showHeader?: boolean }) {
  return (
    <div className="bg-surface-secondary/60 border border-surface-tertiary/50 rounded-lg overflow-hidden text-xs">
      {showHeader && (
        <div className="flex items-center gap-3 px-4 py-2.5 border-b border-surface-tertiary/40">
          <span className="text-muted w-20 shrink-0 font-medium">Name</span>
          <code className="font-mono text-primary">AgentEnvoy</code>
        </div>
      )}
      <div className="flex items-start gap-3 px-4 py-2.5 border-b border-surface-tertiary/40">
        <span className="text-muted w-20 shrink-0 font-medium pt-px">URL</span>
        <code className="font-mono text-primary break-all select-all">{MCP_URL}</code>
      </div>
      <div className="flex items-start gap-3 px-4 py-2.5 border-b border-surface-tertiary/40">
        <span className="text-muted w-20 shrink-0 font-medium pt-px">Header</span>
        <code className="font-mono text-primary">Authorization</code>
      </div>
      <div className="flex items-start gap-3 px-4 py-2.5">
        <span className="text-muted w-20 shrink-0 font-medium pt-px">Value</span>
        <code className="font-mono text-primary break-all select-all">Bearer {token}</code>
      </div>
    </div>
  );
}

/** Numbered step item */
function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-2.5">
      <span className="shrink-0 w-5 h-5 rounded-full bg-surface-secondary/70 border border-surface-tertiary/50 flex items-center justify-center text-[10px] font-bold text-muted">
        {n}
      </span>
      <span className="text-xs text-secondary leading-relaxed">{children}</span>
    </li>
  );
}

/** Step-by-step MCP setup instructions, reused in both the post-mint banner and the collapsed section */
function SetupInstructions({
  token,
  copiedConfig,
  onCopyConfig,
}: {
  token: string | null;
  copiedConfig: boolean;
  onCopyConfig: () => void;
}) {
  const [activeTab, setActiveTab] = useState<ClientTab>("claude-code");
  const displayToken = token ?? "agentenvoy_pat_live_YOUR_TOKEN_HERE";
  const config = buildMcpConfig(displayToken);
  const cursorConfig = buildCursorConfig(displayToken);
  const vscodeConfig = buildVscodeConfig(displayToken);
  const cliCommand = `claude mcp add --transport http agentenvoy ${MCP_URL} --header "Authorization: Bearer ${displayToken}"`;

  return (
    <div className="space-y-4">
      {/* Tab switcher — scrollable on narrow viewports */}
      <div className="flex gap-1 bg-surface-secondary/50 rounded-lg p-1 overflow-x-auto">
        {CLIENT_TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition whitespace-nowrap ${
              activeTab === tab.id
                ? "bg-surface text-primary shadow-sm"
                : "text-muted hover:text-secondary"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* ── Claude Code ── */}
      {activeTab === "claude-code" && (
        <div className="space-y-3">
          <p className="text-[11px] text-muted leading-relaxed">
            Two ways — pick whichever you prefer.
          </p>

          {/* Option A: CLI command */}
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-widest text-muted mb-1.5">
              Option A — one command
            </p>
            <div className="relative">
              <pre className="text-[11px] font-mono leading-relaxed bg-surface-secondary/60 border border-surface-tertiary/50 rounded-lg px-4 py-3 overflow-x-auto whitespace-pre">
                {cliCommand}
              </pre>
            </div>
          </div>

          {/* Option B: JSON file */}
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-widest text-muted mb-1.5">
              Option B — edit the config file
            </p>
            <ol className="space-y-2 list-none mb-2">
              <Step n={1}>
                Open (or create){" "}
                <code className="font-mono text-primary bg-surface-secondary/60 px-1 rounded">~/.claude/mcp.json</code>.
              </Step>
              <Step n={2}>
                Paste the block below{token ? " (your token is pre-filled)" : ", replacing the placeholder with your token"}:
              </Step>
            </ol>
            <div className="relative">
              <pre className="text-[11px] font-mono leading-relaxed bg-surface-secondary/60 border border-surface-tertiary/50 rounded-lg px-4 py-3 overflow-x-auto whitespace-pre">
                {config}
              </pre>
              <button
                onClick={onCopyConfig}
                className="absolute top-2 right-2 px-2.5 py-1 text-[10px] font-medium bg-surface border border-surface-tertiary/60 rounded text-secondary hover:text-primary transition"
              >
                {copiedConfig ? "Copied ✓" : "Copy"}
              </button>
            </div>
          </div>

          <ol className="space-y-3 list-none" start={3}>
            <Step n={3}>
              Restart Claude Code, or run{" "}
              <code className="font-mono text-primary bg-surface-secondary/60 px-1 rounded">/mcp</code>{" "}
              to reload servers without restarting.
            </Step>
            <Step n={4}>
              Try it: ask Claude{" "}
              <span className="italic text-primary">&ldquo;when am I free this week?&rdquo;</span>{" "}
              or <span className="italic text-primary">&ldquo;make me a 30-minute coffee chat link.&rdquo;</span>
            </Step>
          </ol>

          <p className="text-[10px] text-muted leading-relaxed">
            Want it scoped to one project? Use{" "}
            <code className="font-mono bg-surface-secondary/60 px-1 rounded">.mcp.json</code>{" "}
            at the project root instead.
          </p>
        </div>
      )}

      {/* ── Cursor ── */}
      {activeTab === "cursor" && (
        <div className="space-y-3">
          <ol className="space-y-3 list-none">
            <Step n={1}>
              Open (or create){" "}
              <code className="font-mono text-primary bg-surface-secondary/60 px-1 rounded">~/.cursor/mcp.json</code>{" "}
              — global, applies to every Cursor project.
            </Step>
            <Step n={2}>
              Paste this{token ? " (your token is pre-filled)" : ", replacing the placeholder with your token"}:
            </Step>
          </ol>

          <pre className="text-[11px] font-mono leading-relaxed bg-surface-secondary/60 border border-surface-tertiary/50 rounded-lg px-4 py-3 overflow-x-auto whitespace-pre">
            {cursorConfig}
          </pre>

          <ol className="space-y-3 list-none" start={3}>
            <Step n={3}>
              Restart Cursor, or open{" "}
              <strong className="text-primary font-medium">Settings → MCP</strong> and toggle
              the AgentEnvoy server on. Tools will appear in the agent panel.
            </Step>
          </ol>

          <p className="text-[10px] text-muted leading-relaxed">
            Project-scoped? Use{" "}
            <code className="font-mono bg-surface-secondary/60 px-1 rounded">.cursor/mcp.json</code>{" "}
            at the project root instead.
          </p>
        </div>
      )}

      {/* ── VS Code ── */}
      {activeTab === "vscode" && (
        <div className="space-y-3">
          <ol className="space-y-3 list-none">
            <Step n={1}>
              In your project, create{" "}
              <code className="font-mono text-primary bg-surface-secondary/60 px-1 rounded">.vscode/mcp.json</code>{" "}
              (or open VS Code user settings if you want it global).
            </Step>
            <Step n={2}>
              Paste this{token ? " (your token is pre-filled)" : ", replacing the placeholder with your token"}:
            </Step>
          </ol>

          <pre className="text-[11px] font-mono leading-relaxed bg-surface-secondary/60 border border-surface-tertiary/50 rounded-lg px-4 py-3 overflow-x-auto whitespace-pre">
            {vscodeConfig}
          </pre>

          <ol className="space-y-3 list-none" start={3}>
            <Step n={3}>
              Reload VS Code. With GitHub Copilot installed, AgentEnvoy will appear in the
              agent&apos;s tools palette.
            </Step>
          </ol>

          <p className="text-[10px] text-muted leading-relaxed">
            Note: VS Code uses{" "}
            <code className="font-mono bg-surface-secondary/60 px-1 rounded">servers</code>{" "}
            as the root key, not{" "}
            <code className="font-mono bg-surface-secondary/60 px-1 rounded">mcpServers</code>{" "}
            — slight difference from Claude Code / Cursor.
          </p>
        </div>
      )}

      {/* ── Other (Windsurf, Gemini CLI, generic MCP clients) ── */}
      {activeTab === "other" && (
        <div className="space-y-3">
          <p className="text-xs text-secondary leading-relaxed">
            AgentEnvoy speaks standard <strong className="text-primary font-medium">Streamable HTTP MCP</strong>{" "}
            with bearer-token auth. Any client that lets you specify a URL and a custom Authorization
            header will work — including <strong className="text-primary font-medium">Windsurf</strong>,{" "}
            <strong className="text-primary font-medium">Zed</strong>,{" "}
            <strong className="text-primary font-medium">Gemini CLI</strong>, and{" "}
            <strong className="text-primary font-medium">Continue.dev</strong>.
          </p>

          <p className="text-xs text-secondary leading-relaxed">
            Drop these values into your client&apos;s MCP config:
          </p>

          <ConnectionFields token={displayToken} showHeader />

          <p className="text-[10px] text-muted leading-relaxed">
            Each client has slightly different config-file location and JSON shape (e.g. Windsurf uses{" "}
            <code className="font-mono bg-surface-secondary/60 px-1 rounded">~/.codeium/windsurf/mcp_config.json</code>;
            Gemini CLI uses{" "}
            <code className="font-mono bg-surface-secondary/60 px-1 rounded">~/.gemini/settings.json</code>).
            Check your client&apos;s MCP docs for the exact format — the URL and auth values above are
            what you&apos;re plugging in.
          </p>
        </div>
      )}
    </div>
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
