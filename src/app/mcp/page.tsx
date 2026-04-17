"use client";

import { useState } from "react";
import { LogoFull } from "@/components/logo";

export default function MCPPage() {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "done" | "error">("idle");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || state === "sending") return;
    setState("sending");
    try {
      const r = await fetch("/api/waitlist/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (!r.ok) throw new Error("failed");
      setState("done");
    } catch {
      setState("error");
    }
  };

  return (
    <>
      {/* Nav */}
      <nav className="sticky top-0 z-50 bg-background/80 backdrop-blur-md border-b border-secondary">
        <div className="max-w-[1160px] mx-auto px-6 h-14 flex items-center justify-between">
          <a href="/" className="inline-flex items-center rounded-lg px-2 py-1 -ml-1 hover:bg-surface-secondary transition">
            <LogoFull height={22} className="text-primary" />
          </a>
          <div className="flex items-center gap-6">
            <a href="/#demo" className="hidden md:inline text-sm text-secondary hover:text-primary transition">Demo</a>
            <a href="/#how-it-works" className="hidden md:inline text-sm text-secondary hover:text-primary transition">How It Works</a>
            <a href="/mcp" className="hidden md:inline text-sm font-semibold text-accent">Developers</a>
            <a href="/#cta" className="inline-flex items-center gap-2 bg-accent hover:bg-accent-hover text-white px-4 py-2 rounded-lg text-sm font-semibold transition shadow-accent-glow">
              Get Started
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
            </a>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="relative px-6 pt-20 pb-16 text-center overflow-hidden">
        <div
          className="absolute inset-0 -z-10"
          style={{
            background:
              "radial-gradient(ellipse 800px 400px at 50% 30%, color-mix(in srgb, var(--accent) 18%, transparent) 0%, transparent 60%), radial-gradient(ellipse 500px 300px at 80% 70%, color-mix(in srgb, var(--accent-2) 12%, transparent) 0%, transparent 60%)",
          }}
        />
        <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-accent-surface text-accent text-xs font-semibold border border-accent/25 mb-6">
          <span className="w-1.5 h-1.5 rounded-full bg-accent3" />
          FOR DEVELOPERS &amp; AI AGENTS
        </div>
        <h1 className="text-4xl md:text-6xl font-extrabold tracking-tight max-w-3xl mx-auto leading-[1.1] mb-5">
          AgentEnvoy for{" "}
          <span
            className="bg-clip-text text-transparent"
            style={{ backgroundImage: "linear-gradient(135deg, var(--accent), var(--accent-2))" }}
          >
            AI Agents
          </span>
        </h1>
        <p className="text-lg text-secondary max-w-2xl mx-auto mb-8 leading-relaxed">
          An open standard for AI scheduling. Point your MCP client or REST integration at AgentEnvoy, and your agent can read availability, propose times, and book meetings on behalf of your users — with host rules enforced.
        </p>
        <div className="inline-flex gap-2.5 flex-wrap justify-center">
          <Badge color="accent">MCP Compatible</Badge>
          <Badge color="accent2">REST API</Badge>
          <Badge color="accent3">Open Spec</Badge>
        </div>
      </section>

      {/* Two cards */}
      <div className="max-w-[1080px] mx-auto px-6 pb-16 grid md:grid-cols-2 gap-5">
        <DevCard
          title="MCP Server"
          desc="Drop AgentEnvoy into Claude Desktop, Cursor, or any MCP-compatible agent. Your users' agents schedule on their behalf."
          filename="claude_desktop_config.json"
          icon={
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>
            </svg>
          }
          code={`{
  "mcpServers": {
    "agentenvoy": {
      "url": "https://agentenvoy.ai/mcp",
      "auth": "oauth2"
    }
  }
}`}
        />
        <DevCard
          title="REST API"
          desc="Language-agnostic HTTP endpoints. Schedule meetings, check availability, create contextual links — from any backend."
          filename="curl"
          icon={
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="4" width="20" height="16" rx="2"/><path d="M6 8h.01M10 8h.01M14 8h.01"/><path d="M2 12h20"/>
            </svg>
          }
          code={`POST /api/v1/meetings
Authorization: Bearer sk_live_...

{
  "with": "sarah@acme.com",
  "context": "Q2 review",
  "duration": 30,
  "format": "phone"
}`}
        />
      </div>

      {/* Email capture */}
      <div className="max-w-[640px] mx-auto px-6 pb-20">
        <div
          className="rounded-3xl p-9 text-center border border-accent/25"
          style={{
            background: "linear-gradient(135deg, var(--accent-surface), color-mix(in srgb, var(--accent-2) 10%, transparent))",
          }}
        >
          <h2 className="text-2xl font-bold tracking-tight mb-2">Get notified when the public API launches</h2>
          <p className="text-sm text-secondary mb-5 leading-relaxed">
            We&apos;re finalizing the spec with early partners. Drop your email and we&apos;ll send you the SDK, docs, and API keys the day it ships.
          </p>
          {state === "done" ? (
            <p className="text-sm font-semibold text-emerald-600 dark:text-emerald-400">✓ On the list — thanks.</p>
          ) : (
            <form onSubmit={handleSubmit} className="flex gap-2.5 max-w-md mx-auto flex-wrap">
              <input
                type="email"
                required
                placeholder="you@company.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="flex-1 min-w-[220px] bg-surface border border-DEFAULT rounded-xl px-4 py-3 text-sm text-primary placeholder:text-muted outline-none focus:border-accent transition"
              />
              <button
                type="submit"
                disabled={state === "sending"}
                className="bg-accent hover:bg-accent-hover text-white px-5 py-3 rounded-xl text-sm font-semibold transition disabled:opacity-60"
              >
                {state === "sending" ? "Sending…" : "Notify me"}
              </button>
            </form>
          )}
          {state === "error" && <p className="text-xs text-red-500 mt-3">Something went wrong — try again?</p>}
        </div>
      </div>

      {/* Spec preview */}
      <section className="px-6 py-16 bg-surface-inset border-t border-b border-secondary">
        <div className="max-w-[1080px] mx-auto">
          <h2 className="text-3xl font-extrabold tracking-tight text-center mb-10">What the protocol covers</h2>
          <div className="grid md:grid-cols-3 gap-5">
            <SpecItem icon="📅" title="Availability" endpoint="GET /availability" desc="Read scored availability windows for a user. Respects preferences, calendar rules, and per-link overrides." />
            <SpecItem icon="🤝" title="Negotiate" endpoint="POST /negotiate" desc="Propose times to a guest (human or agent). Envoy mediates until both sides agree — then books." />
            <SpecItem icon="🔗" title="Links" endpoint="POST /links" desc="Create generic or contextual links programmatically. Set rules, formats, duration, expiry." />
            <SpecItem icon="👥" title="Groups" endpoint="POST /groups" desc="Coordinate multi-party meetings. Envoy handles private 1:1 conversations with each participant." />
            <SpecItem icon="📝" title="Preferences" endpoint="PATCH /prefs" desc="Update a user's scheduling rules — hours, formats, focus time, VIP priorities — from your app." />
            <SpecItem icon="🔔" title="Webhooks" endpoint="events.*" desc="Subscribe to meeting.booked, meeting.rescheduled, link.used, and more." />
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="py-10 text-center">
        <div className="flex justify-center gap-5 mb-3 flex-wrap">
          <a href="/" className="text-xs text-muted hover:text-secondary transition">Home</a>
          <a href="/privacy" className="text-xs text-muted hover:text-secondary transition">Privacy</a>
          <a href="/terms" className="text-xs text-muted hover:text-secondary transition">Terms</a>
          <a href="/mcp" className="text-xs text-muted hover:text-secondary transition">Developers</a>
        </div>
        <p className="text-[0.7rem] text-muted">© 2026 AgentEnvoy &middot; Protocol spec in progress</p>
      </footer>
    </>
  );
}

function Badge({ children, color }: { children: React.ReactNode; color: "accent" | "accent2" | "accent3" }) {
  const styles = {
    accent: { bg: "var(--accent-surface)", fg: "var(--accent)", border: "color-mix(in srgb, var(--accent) 25%, transparent)" },
    accent2: { bg: "color-mix(in srgb, var(--accent-2) 12%, transparent)", fg: "var(--accent-2)", border: "color-mix(in srgb, var(--accent-2) 30%, transparent)" },
    accent3: { bg: "color-mix(in srgb, var(--accent-3) 12%, transparent)", fg: "var(--accent-3)", border: "color-mix(in srgb, var(--accent-3) 35%, transparent)" },
  }[color];
  return (
    <span
      className="text-[0.72rem] font-bold uppercase tracking-wider px-3.5 py-1.5 rounded-full border"
      style={{ background: styles.bg, color: styles.fg, borderColor: styles.border }}
    >
      {children}
    </span>
  );
}

function DevCard({
  title,
  desc,
  filename,
  icon,
  code,
}: {
  title: string;
  desc: string;
  filename: string;
  icon: React.ReactNode;
  code: string;
}) {
  return (
    <div className="bg-surface border border-DEFAULT rounded-3xl overflow-hidden transition hover:border-accent hover:-translate-y-1 hover:shadow-accent-glow-lg">
      <div className="p-7 pb-0">
        <div
          className="inline-flex w-12 h-12 rounded-xl items-center justify-center text-white mb-4 shadow-accent-glow"
          style={{ background: "linear-gradient(135deg, var(--accent), var(--accent-2))" }}
        >
          {icon}
        </div>
        <h3 className="text-xl font-bold tracking-tight mb-1.5 flex items-center gap-2 flex-wrap">
          {title}
          <span className="text-[0.65rem] font-bold tracking-wider uppercase px-2.5 py-0.5 rounded-full"
            style={{ background: "color-mix(in srgb, var(--accent-2) 15%, transparent)", color: "var(--accent-2)" }}
          >
            Coming Soon
          </span>
        </h3>
        <p className="text-sm text-secondary leading-relaxed mb-5">{desc}</p>
      </div>
      <div className="mx-7 mb-7 rounded-xl overflow-hidden border border-DEFAULT" style={{ background: "#0c0c14" }}>
        <div className="px-4 py-2.5 flex items-center gap-2 border-b border-white/5" style={{ background: "rgba(255,255,255,0.03)" }}>
          <span className="w-2.5 h-2.5 rounded-full bg-red-500" />
          <span className="w-2.5 h-2.5 rounded-full bg-yellow-500" />
          <span className="w-2.5 h-2.5 rounded-full bg-green-500" />
          <span className="flex-1 text-center text-[0.72rem] text-zinc-400 font-mono">{filename}</span>
        </div>
        <pre className="p-5 text-[0.8rem] leading-relaxed text-zinc-200 overflow-x-auto font-mono">
          <code>{code}</code>
        </pre>
      </div>
    </div>
  );
}

function SpecItem({ icon, title, endpoint, desc }: { icon: string; title: string; endpoint: string; desc: string }) {
  return (
    <div className="p-5 bg-surface border border-secondary rounded-2xl">
      <h4 className="font-bold text-[0.95rem] mb-1.5 flex items-center gap-2 flex-wrap">
        <span>{icon} {title}</span>
        <code className="text-[0.72rem] bg-surface-secondary text-accent px-2 py-0.5 rounded font-mono">{endpoint}</code>
      </h4>
      <p className="text-[0.85rem] text-secondary leading-relaxed">{desc}</p>
    </div>
  );
}
