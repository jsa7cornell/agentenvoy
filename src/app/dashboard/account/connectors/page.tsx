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
          <h1 className="text-2xl font-semibold tracking-tight text-primary">Connect Claude</h1>
          <p className="text-sm text-muted mt-1.5 leading-relaxed">
            Give Claude (or another AI) a token and it can act as you on AgentEnvoy — reading your
            calendar, creating meeting links, and rescheduling confirmed meetings, all without
            needing you to copy-paste anything.
          </p>
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

            {/* Token value */}
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-widest text-amber-700 dark:text-amber-400 mb-1.5">
                Your token
              </p>
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
            </div>

            {/* Step-by-step setup */}
            <div className="border-t border-amber-200 dark:border-amber-700/40 pt-4 space-y-4">
              <p className="text-xs font-semibold text-amber-900 dark:text-amber-200">
                Next: add AgentEnvoy to Claude
              </p>

              <SetupInstructions
                token={justMinted.plaintext}
                copiedConfig={copiedConfig}
                onCopyConfig={() => copyText(buildMcpConfig(justMinted.plaintext), setCopiedConfig)}
              />
            </div>
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

type ClientTab = "claude-ai" | "claude-code" | "chatgpt" | "gemini";

const CLIENT_TABS: { id: ClientTab; label: string }[] = [
  { id: "claude-ai", label: "Claude.ai" },
  { id: "claude-code", label: "Claude Code" },
  { id: "chatgpt", label: "ChatGPT" },
  { id: "gemini", label: "Gemini" },
];

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
  const [activeTab, setActiveTab] = useState<ClientTab>("claude-ai");
  const displayToken = token ?? "agentenvoy_pat_live_YOUR_TOKEN_HERE";
  const config = buildMcpConfig(displayToken);

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

      {/* ── Claude.ai ── */}
      {activeTab === "claude-ai" && (
        <div className="space-y-3">
          <ol className="space-y-3 list-none">
            <Step n={1}>
              In Claude.ai, open <strong className="text-primary font-medium">Settings → Connectors</strong> and
              click <strong className="text-primary font-medium">Add custom connector</strong>.
            </Step>
            <Step n={2}>Fill in the Name and URL, then open <strong className="text-primary font-medium">Advanced settings</strong> to add the Authorization header:</Step>
          </ol>

          <ConnectionFields token={displayToken} showHeader />

          <ol className="space-y-3 list-none" start={3}>
            <Step n={3}>
              Click <strong className="text-primary font-medium">Add</strong>. AgentEnvoy will appear in your connectors list.
              Try asking Claude <span className="italic text-primary">&ldquo;when am I free this week?&rdquo;</span>
            </Step>
          </ol>
        </div>
      )}

      {/* ── Claude Code ── */}
      {activeTab === "claude-code" && (
        <div className="space-y-3">
          <ol className="space-y-3 list-none">
            <Step n={1}>
              Open (or create){" "}
              <code className="font-mono text-primary bg-surface-secondary/60 px-1 rounded">~/.claude/mcp.json</code>{" "}
              — your user-level MCP config for Claude Code.
            </Step>
            <Step n={2}>
              Paste the block below{token ? " (your token is already filled in)" : ", replacing the placeholder with your token"}:
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

          <ol className="space-y-3 list-none" start={3}>
            <Step n={3}>
              Save the file, then restart Claude Code (or run{" "}
              <code className="font-mono text-primary bg-surface-secondary/60 px-1 rounded">/mcp</code>{" "}
              to reload servers without restarting).
            </Step>
            <Step n={4}>
              Try it: ask Claude <span className="italic text-primary">&ldquo;when am I free this week?&rdquo;</span>{" "}
              or <span className="italic text-primary">&ldquo;make me a 30-minute coffee chat link.&rdquo;</span>
            </Step>
          </ol>

          <p className="text-[10px] text-muted leading-relaxed">
            Want this only for one project? Use{" "}
            <code className="font-mono bg-surface-secondary/60 px-1 rounded">.mcp.json</code>{" "}
            at the project root instead of{" "}
            <code className="font-mono bg-surface-secondary/60 px-1 rounded">~/.claude/mcp.json</code>.
          </p>
        </div>
      )}

      {/* ── ChatGPT ── */}
      {activeTab === "chatgpt" && (
        <div className="space-y-3">
          <ol className="space-y-3 list-none">
            <Step n={1}>
              In ChatGPT, open <strong className="text-primary font-medium">Settings → Connectors</strong>{" "}
              (or <strong className="text-primary font-medium">Integrations</strong> depending on your plan){" "}
              and look for an option to add a custom MCP server.
            </Step>
            <Step n={2}>
              Enter the following — the exact field labels may differ but the values are the same:
            </Step>
          </ol>

          <ConnectionFields token={displayToken} showHeader />

          <ol className="space-y-3 list-none" start={3}>
            <Step n={3}>
              Save. ChatGPT will verify the connection and add AgentEnvoy to your available tools.
              Try asking <span className="italic text-primary">&ldquo;check my schedule for this week.&rdquo;</span>
            </Step>
          </ol>

          <p className="text-[10px] text-muted leading-relaxed">
            ChatGPT&apos;s MCP connector UI updates frequently. If the menu path above doesn&apos;t match what you see,
            look for &ldquo;MCP&rdquo; or &ldquo;custom connector&rdquo; in Settings — the URL and auth values above are always correct.
          </p>
        </div>
      )}

      {/* ── Gemini ── */}
      {activeTab === "gemini" && (
        <div className="space-y-3">
          <ol className="space-y-3 list-none">
            <Step n={1}>
              Open <strong className="text-primary font-medium">Google AI Studio</strong>{" "}
              (<code className="font-mono text-primary bg-surface-secondary/60 px-1 rounded">aistudio.google.com</code>)
              or <strong className="text-primary font-medium">Gemini Advanced</strong>. Go to{" "}
              <strong className="text-primary font-medium">Settings → Extensions</strong> or{" "}
              <strong className="text-primary font-medium">Tools → MCP Servers</strong>.
            </Step>
            <Step n={2}>
              Add a new MCP server with these values:
            </Step>
          </ol>

          <ConnectionFields token={displayToken} showHeader />

          <ol className="space-y-3 list-none" start={3}>
            <Step n={3}>
              Save and confirm. Try asking Gemini{" "}
              <span className="italic text-primary">&ldquo;what does my schedule look like this week?&rdquo;</span>
            </Step>
          </ol>

          <p className="text-[10px] text-muted leading-relaxed">
            Google&apos;s MCP support surface varies across Gemini Advanced, AI Studio, and Workspace. If the path
            above doesn&apos;t match, search your settings for &ldquo;MCP&rdquo; or &ldquo;custom tools.&rdquo;{" "}
            The URL and auth values above are always correct regardless of which surface you use.
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
