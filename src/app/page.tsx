"use client";

import { signIn, useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { LogoFull } from "@/components/logo";
import { TryItChat } from "@/components/tryit-chat";

/* ── Google logo (color) ─────────────────────────────────── */
function GoogleIcon({ className = "w-5 h-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
    </svg>
  );
}

function ArrowRight({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12h14M12 5l7 7-7 7"/>
    </svg>
  );
}

function SectionLabel({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <p className={`inline-flex items-center gap-2 text-[0.72rem] font-bold tracking-widest uppercase text-accent mb-3.5 ${className}`}>
      <span className="w-4 h-0.5 rounded-full bg-accent" />
      {children}
    </p>
  );
}

/* ═══════════════════════════════════════════════════════════ */

export default function Home() {
  const { data: session, status } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (status === "authenticated") {
      router.push(session?.user?.onboardingComplete ? "/dashboard" : "/dashboard");
    }
  }, [status, session, router]);

  const handleSignIn = () => signIn("google", { callbackUrl: "/dashboard" });

  if (status === "authenticated") return null;

  return (
    <>
      {/* ── NAV ───────────────────────────────────────────── */}
      <nav className="sticky top-0 z-50 bg-background/80 backdrop-blur-md border-b border-secondary">
        <div className="max-w-[1160px] mx-auto px-6 h-14 flex items-center justify-between">
          <a
            href="/"
            className="inline-flex items-center rounded-lg px-2 py-1 -ml-1 hover:bg-surface-secondary transition"
            title="Home"
          >
            <LogoFull height={22} className="text-primary" />
          </a>
          <div className="flex items-center gap-6">
            <a href="#demo" className="hidden md:inline text-sm text-secondary hover:text-primary transition">Demo</a>
            <a href="#how-it-works" className="hidden md:inline text-sm text-secondary hover:text-primary transition">How It Works</a>
            <a href="/agents" className="hidden md:inline text-sm text-secondary hover:text-primary transition">For Agents</a>
            <button
              onClick={handleSignIn}
              className="inline-flex items-center gap-2 bg-accent hover:bg-accent-hover text-white px-4 py-2 rounded-lg text-sm font-semibold transition shadow-accent-glow group"
            >
              Get Started
              <ArrowRight className="w-3.5 h-3.5 transition group-hover:translate-x-0.5" />
            </button>
          </div>
        </div>
      </nav>

      {/* ── HERO ──────────────────────────────────────────── */}
      <section className="relative px-6 py-16 md:py-20">
        <div className="max-w-[1160px] mx-auto grid lg:grid-cols-[1.05fr_1fr] gap-14 items-center">
          <div>
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-accent-surface text-accent text-xs font-semibold border border-accent/25 mb-6">
              <span className="w-1.5 h-1.5 rounded-full bg-accent3 animate-pulse-ring" />
              PERSONAL MEETING COORDINATION
            </div>
            <h1 className="text-4xl md:text-[3.5rem] lg:text-[4rem] font-extrabold leading-[1.05] tracking-[-0.03em] mb-5">
              Every meeting deserves its{" "}
              <span
                className="bg-clip-text text-transparent"
                style={{ backgroundImage: "linear-gradient(135deg, var(--accent), var(--accent-2))" }}
              >
                own scheduler
              </span>
              .
            </h1>
            <p className="text-lg text-secondary leading-relaxed mb-8 max-w-lg">
              Generic links with static slots don&apos;t fit real life. AgentEnvoy gives each meeting its own rules — locked times, the right format, shared context — and an AI that negotiates within them. Your agent handles it. You just show up.
            </p>
            <div className="flex flex-wrap gap-3.5 items-center">
              <button
                onClick={handleSignIn}
                className="inline-flex items-center gap-2.5 bg-accent hover:bg-accent-hover text-white px-7 py-3.5 rounded-xl text-base font-semibold transition shadow-accent-glow-lg hover:-translate-y-0.5 group"
              >
                <GoogleIcon className="w-[18px] h-[18px]" />
                Get Started with Google
                <ArrowRight className="w-4 h-4 transition group-hover:translate-x-0.5" />
              </button>
              <a
                href="/agents"
                className="inline-flex items-center gap-2 bg-transparent text-primary border border-DEFAULT hover:bg-surface-secondary hover:border-muted px-5 py-3.5 rounded-xl text-base font-medium transition"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>
                </svg>
                Point your agent at it
              </a>
            </div>
            <p className="mt-5 text-xs text-muted flex items-center gap-1.5">
              Free while in beta &middot; No credit card &middot; 30-second setup
            </p>
          </div>

          {/* Try It chat */}
          <div className="relative">
            <TryItChat />
          </div>
        </div>
      </section>

      {/* ── DEMO ──────────────────────────────────────────── */}
      <section id="demo" className="bg-[#0a0a0f] py-20 md:py-24 text-center px-6">
        <div className="max-w-[1160px] mx-auto">
          <p className="inline-flex items-center gap-2 text-[0.72rem] font-bold tracking-widest uppercase mb-3.5" style={{ color: "#c084fc" }}>
            <span className="w-4 h-0.5 rounded-full" style={{ background: "#c084fc" }} />
            See It In Action
          </p>
          <h2 className="text-3xl md:text-[2.5rem] font-extrabold tracking-tight text-zinc-100 mb-4">
            Watch how Envoy coordinates a meeting
          </h2>
          <p className="text-base md:text-lg text-zinc-400 max-w-xl mx-auto mb-12">
            From the first request to a confirmed calendar invite — the full flow in under two minutes.
          </p>
        </div>
        <div className="relative max-w-[920px] mx-auto">
          <div
            className="absolute -inset-12 pointer-events-none"
            style={{
              background: "radial-gradient(ellipse, rgba(129,140,248,0.15) 0%, transparent 65%)",
              filter: "blur(30px)",
            }}
          />
          <div className="relative rounded-[18px] overflow-hidden border border-[#2a2a3a] shadow-[0_30px_90px_rgba(0,0,0,0.55),inset_0_0_0_1px_rgba(255,255,255,0.04)]">
            <iframe
              src="/demo.html"
              title="AgentEnvoy Demo"
              className="w-full aspect-[16/10]"
              loading="lazy"
              allow="autoplay"
            />
          </div>
        </div>
      </section>

      {/* ── HOW IT WORKS ──────────────────────────────────── */}
      <section id="how-it-works" className="py-24 px-6 text-center">
        <div className="max-w-[1160px] mx-auto">
          <SectionLabel>How It Works</SectionLabel>
          <h2 className="text-3xl md:text-[2.5rem] font-extrabold tracking-tight mb-4">
            A custom scheduler for every meeting
          </h2>
          <p className="text-base md:text-lg text-secondary max-w-xl mx-auto mb-14">
            Connect your calendar. Set the rules per meeting. Envoy negotiates within them.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-10 md:gap-12">
            {[
              {
                num: "1",
                title: "Connect your calendar",
                desc: "Sign in with Google. Envoy learns your schedule, your habits, and how you like to meet — in a quick chat.",
              },
              {
                num: "2",
                title: "Customize each meeting",
                desc: (
                  <>
                    Tell Envoy who, when, what format, and the context. Each meeting gets its own link with your rules baked in. Or use your general link for quick catch-ups.
                  </>
                ),
              },
              {
                num: "3",
                title: "Envoy negotiates",
                desc: "Guests chat with Envoy — or their agent does. Times stay locked to your rules. Invites land in both calendars.",
              },
            ].map((step) => (
              <div key={step.num}>
                <div
                  className="inline-flex items-center justify-center w-14 h-14 rounded-2xl text-white text-xl font-extrabold mb-5 shadow-accent-glow"
                  style={{ background: "linear-gradient(135deg, var(--accent), var(--accent-2))" }}
                >
                  {step.num}
                </div>
                <h3 className="text-xl font-bold tracking-tight mb-2.5">{step.title}</h3>
                <p className="text-[0.95rem] text-secondary leading-relaxed max-w-[300px] mx-auto">{step.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── CUSTOM LINKS SHOWCASE ─────────────────────────── */}
      <section id="custom-links" className="py-24 px-6 bg-surface-inset">
        <div className="max-w-[1080px] mx-auto grid md:grid-cols-2 gap-16 items-center">
          <div>
            <SectionLabel>Per-Meeting Control</SectionLabel>
            <h2 className="text-3xl md:text-[2.5rem] font-extrabold tracking-tight mb-4 leading-[1.15]">
              Every meeting gets its own link
            </h2>
            <p className="text-base text-secondary leading-relaxed mb-7">
              Not one generic link for every situation. Each meeting is coordinated on its own terms — locked slots, required format, the context that matters. Envoy enforces the rules while it negotiates.
            </p>
            <ul className="space-y-2">
              {[
                ["Lock availability", "only offer the slots you want for this meeting"],
                ["Set the format", "phone, video, coffee, dinner — Envoy enforces it"],
                ["Add context", "\u201Cabout Q2 planning, keep it to 30 min\u201D"],
                ["Per-guest rules", "different priorities for different people"],
                ["General link too", "a permanent link for your email signature"],
              ].map(([title, desc]) => (
                <li key={title} className="flex items-start gap-3 text-[0.95rem] text-secondary leading-relaxed pl-0.5">
                  <span
                    className="shrink-0 w-4 h-4 rounded-full border border-accent flex items-center justify-center mt-1"
                    style={{ background: "var(--accent-surface)" }}
                  >
                    <span className="block w-1 h-[7px] border-r-2 border-b-2 border-accent rotate-45 -translate-y-px" />
                  </span>
                  <span>
                    <strong className="text-primary font-semibold">{title}</strong> — {desc}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          {/* Mock link card */}
          <div className="relative">
            <div className="relative z-10 bg-surface border border-DEFAULT rounded-3xl overflow-hidden shadow-[0_12px_48px_-8px_rgba(30,27,75,0.14)] dark:shadow-[0_12px_48px_-8px_rgba(0,0,0,0.5)]">
              <div className="flex items-center gap-2.5 px-5 py-3.5 border-b border-secondary bg-surface-secondary">
                <span
                  className="w-2 h-2 rounded-full bg-emerald-500"
                  style={{ boxShadow: "0 0 0 3px rgba(16,185,129,0.2)" }}
                />
                <span className="font-mono text-[0.78rem] text-muted flex-1 truncate">
                  agentenvoy.ai/meet/john/q2-sarah
                </span>
              </div>
              <div className="px-5 py-5">
                <p className="font-bold text-[1.02rem] text-primary mb-1 tracking-tight">Q2 Planning — Sarah Chen</p>
                <p className="text-[0.78rem] text-muted mb-4">Created 2 hours ago &middot; Expires Apr 18</p>

                {[
                  { icon: "📅", title: "Locked to Tue Apr 15", desc: "only 10am, 2pm, and 3:30pm offered" },
                  { icon: "📞", title: "Phone only", desc: "no video, no in-person" },
                  { icon: "⏱", title: "30 minutes max", desc: "quick sync on budget" },
                  { icon: "📋", title: "Context:", desc: "\u201CReview Q2 marketing budget before Thursday board meeting\u201D" },
                ].map((rule) => (
                  <div key={rule.title} className="flex items-start gap-3 py-2.5 border-t border-secondary">
                    <span
                      className="shrink-0 w-7 h-7 rounded-lg flex items-center justify-center text-sm border border-accent/15"
                      style={{
                        background:
                          "linear-gradient(135deg, var(--accent-surface), color-mix(in srgb, var(--accent-2) 10%, transparent))",
                      }}
                    >
                      {rule.icon}
                    </span>
                    <p className="text-[0.87rem] text-secondary leading-snug">
                      <strong className="text-primary font-semibold">{rule.title}</strong> — {rule.desc}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── GROUP MEETINGS SHOWCASE ───────────────────────── */}
      <section id="groups" className="py-24 px-6">
        <div className="max-w-[1080px] mx-auto grid md:grid-cols-2 gap-16 items-center">
          {/* Mock group card — first on mobile */}
          <div className="order-first md:order-none">
            <div className="bg-surface border border-DEFAULT rounded-3xl overflow-hidden shadow-[0_12px_48px_-8px_rgba(30,27,75,0.14)] dark:shadow-[0_12px_48px_-8px_rgba(0,0,0,0.5)]">
              <div className="px-5 py-4 border-b border-secondary bg-surface-secondary">
                <p className="font-bold text-[0.98rem] text-primary tracking-tight">Product Launch Sync</p>
                <p className="text-[0.78rem] text-muted">4 participants &middot; Finding overlap</p>
              </div>

              <div className="px-5 py-4 space-y-3">
                {[
                  { initials: "JA", name: "John (host)", status: "12 slots available this week", badge: "Host", badgeClass: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400", gradient: "from-indigo-500 to-purple-500" },
                  { initials: "SC", name: "Sarah Chen", status: "Confirmed — prefers mornings", badge: "Confirmed", badgeClass: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400", gradient: "from-emerald-500 to-emerald-400" },
                  { initials: "MR", name: "Marcus Rivera", status: "Chatting with Envoy now...", badge: "In Progress", badgeClass: "bg-accent-surface text-accent", gradient: "from-amber-500 to-amber-400" },
                  { initials: "LP", name: "Lisa Park", status: "Link sent · Not yet opened", badge: "Pending", badgeClass: "bg-amber-500/10 text-amber-600 dark:text-amber-400", gradient: "from-red-500 to-red-400" },
                ].map((p) => (
                  <div key={p.initials} className="flex items-center gap-3">
                    <div className={`w-9 h-9 rounded-full bg-gradient-to-br ${p.gradient} flex items-center justify-center text-[0.76rem] font-bold text-white shrink-0`}
                      style={{ boxShadow: "0 2px 6px rgba(0,0,0,0.15)" }}
                    >
                      {p.initials}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-[0.87rem] font-semibold text-primary">{p.name}</p>
                      <p className="text-[0.74rem] text-muted truncate">{p.status}</p>
                    </div>
                    <span className={`text-[0.68rem] font-semibold px-2.5 py-0.5 rounded-full shrink-0 ${p.badgeClass}`}>
                      {p.badge}
                    </span>
                  </div>
                ))}
              </div>

              <div className="px-5 py-4 border-t border-secondary bg-emerald-500/5">
                <p className="text-[0.72rem] font-bold uppercase tracking-wider text-emerald-600 dark:text-emerald-400 mb-2">
                  Overlap found (3 of 4 confirmed)
                </p>
                <div className="flex gap-2 flex-wrap">
                  {["Tue 10:00 AM", "Wed 2:00 PM", "Thu 11:30 AM"].map((slot) => (
                    <span key={slot} className="text-[0.8rem] font-semibold text-primary bg-surface border-2 border-emerald-500 rounded-xl px-2.5 py-1">
                      {slot}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <div>
            <SectionLabel>Group Scheduling</SectionLabel>
            <h2 className="text-3xl md:text-[2.5rem] font-extrabold tracking-tight mb-4 leading-[1.15]">
              Coordinate across multiple people
            </h2>
            <p className="text-base text-secondary leading-relaxed mb-7">
              Send each participant their own link. Everyone chats privately with Envoy — no reply-all chains, no polling. Envoy finds the overlap and books it.
            </p>
            <ul className="space-y-2">
              {[
                ["Private conversations", "each guest talks to Envoy 1:1, nobody sees anyone else\u2019s calendar"],
                ["Real-time overlap", "Envoy calculates availability across all participants as they respond"],
                ["No account needed", "guests just click a link and chat"],
                ["Scales naturally", "works for 2 people or 20"],
              ].map(([title, desc]) => (
                <li key={title} className="flex items-start gap-3 text-[0.95rem] text-secondary leading-relaxed pl-0.5">
                  <span className="shrink-0 w-4 h-4 rounded-full border border-emerald-500 flex items-center justify-center mt-1 bg-emerald-500/10">
                    <span className="block w-1 h-[7px] border-r-2 border-b-2 border-emerald-500 rotate-45 -translate-y-px" />
                  </span>
                  <span>
                    <strong className="text-primary font-semibold">{title}</strong> — {desc}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {/* ── AGENTS NEGOTIATING VISION ──────────────────────── */}
      <section className="relative py-24 px-6 text-center overflow-hidden bg-surface-inset">
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            background: "radial-gradient(ellipse 700px 300px at 50% 50%, color-mix(in srgb, var(--accent-2) 10%, transparent) 0%, transparent 70%)",
          }}
        />
        <div className="relative max-w-[1080px] mx-auto">
          <SectionLabel>Live today</SectionLabel>
          <h2 className="text-3xl md:text-[2.5rem] font-extrabold tracking-tight mb-4">
            Your agent can book this meeting for you.
          </h2>
          <p className="text-base md:text-lg text-secondary max-w-2xl mx-auto mb-14 leading-relaxed">
            Every AgentEnvoy meeting link doubles as a Model Context Protocol endpoint. Hand it to Claude, Cursor, or any MCP client, and your agent negotiates within the host&apos;s rules — same scoring engine, same confirmation pipeline as the web UI. No parallel track for humans vs. agents.
          </p>

          <div className="max-w-[900px] mx-auto grid md:grid-cols-[1fr_auto_1fr] gap-5 items-center">
            <AgentNode icon="🧑‍💼" label="Your Agent" sub="Claude, ChatGPT, or any MCP client" />
            <Connector />
            <AgentNode icon="🤝" label="AgentEnvoy" sub="Neutral administrator" highlighted />
          </div>
          <div className="max-w-[900px] mx-auto grid md:grid-cols-[1fr_auto_1fr] gap-5 items-center -mt-3">
            <div />
            <Connector />
            <AgentNode icon="👤" label="Their Agent" sub="Or a human on a link" />
          </div>
        </div>
      </section>

      {/* ── MCP TEASER ────────────────────────────────────── */}
      <section className="py-24 px-6">
        <div className="max-w-[1080px] mx-auto grid md:grid-cols-2 gap-16 items-center">
          <div>
            <SectionLabel>Open Standard</SectionLabel>
            <h2 className="text-3xl md:text-[2.5rem] font-extrabold tracking-tight mb-4 leading-[1.15]">
              Point your agent at it
            </h2>
            <p className="text-base text-secondary leading-relaxed mb-6">
              Every meeting URL is an MCP endpoint. Hand one to your AI, and it can read the host&apos;s rules, fetch scored availability, propose a time, and book — all through the same pipeline the web UI uses.
            </p>
            <div className="flex flex-wrap gap-2 mb-6">
              <TechBadge color="accent">MCP</TechBadge>
              <TechBadge color="accent2">URL-as-capability</TechBadge>
              <TechBadge color="accent3">Open Spec</TechBadge>
            </div>
            <a
              href="/agents"
              className="inline-flex items-center gap-2 bg-transparent text-primary border border-DEFAULT hover:bg-surface-secondary hover:border-muted px-5 py-3 rounded-xl text-[0.95rem] font-medium transition"
            >
              See how to connect your agent
              <ArrowRight className="w-3.5 h-3.5" />
            </a>
          </div>

          {/* Code block — real, copy-paste-able setup */}
          <div className="rounded-2xl overflow-hidden border border-DEFAULT shadow-[0_12px_48px_-8px_rgba(30,27,75,0.18)] font-mono" style={{ background: "#0c0c14" }}>
            <div className="px-4 py-3 flex items-center gap-2 border-b border-white/5" style={{ background: "rgba(255,255,255,0.03)" }}>
              <span className="w-2.5 h-2.5 rounded-full bg-red-500" />
              <span className="w-2.5 h-2.5 rounded-full bg-yellow-500" />
              <span className="w-2.5 h-2.5 rounded-full bg-green-500" />
              <span className="flex-1 text-center text-[0.78rem] text-zinc-400">terminal</span>
            </div>
            <pre className="px-5 py-5 text-[0.82rem] leading-[1.7] text-zinc-200 overflow-x-auto">
<span className="text-zinc-500 italic"># Add AgentEnvoy to Claude Code, once:</span>
{"\n"}<span className="text-emerald-300">$</span> claude mcp add --transport http \
  agentenvoy https://agentenvoy.ai/api/mcp

<span className="text-zinc-500 italic"># Then, in any Claude Code session:</span>
{"\n"}<span className="text-blue-300">&gt;</span> I got this invite: <span className="text-emerald-300">https://agentenvoy.ai/meet/abc123</span>
{"  "}Book me a time next Tuesday afternoon.

<span className="text-zinc-500 italic"># Claude calls get_availability → propose_lock.</span>
{"\n"}<span className="text-zinc-500 italic"># Calendar invites land in both inboxes.</span>
            </pre>
          </div>
        </div>
      </section>

      {/* ── FEATURES ──────────────────────────────────────── */}
      <section id="features" className="py-24 px-6 text-center bg-surface-inset">
        <div className="max-w-[1160px] mx-auto">
          <SectionLabel>Under the Hood</SectionLabel>
          <h2 className="text-3xl md:text-[2.5rem] font-extrabold tracking-tight mb-12">
            Built for real scheduling
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 text-left">
            {[
              { icon: "📅", title: "Calendar Intelligence", desc: "Real-time Google Calendar sync. Understands declined invites, tentative holds, focus time, and recurring events." },
              { icon: "🔒", title: "Privacy First", desc: "Guests never see your calendar. Envoy shares only what it needs. Your schedule stays private." },
              { icon: "🔌", title: "MCP + REST", desc: "Point any AI agent at our open API. MCP server, REST endpoints, and a published spec." },
              { icon: "⚡", title: "Scoring Engine", desc: "Every slot gets a protection score. Deterministic, <10ms, no AI calls. Consistent and explainable." },
            ].map((f) => (
              <div key={f.title} className="bg-surface border border-DEFAULT rounded-2xl p-6 transition hover:border-accent hover:-translate-y-0.5 hover:shadow-accent-glow">
                <div
                  className="inline-flex w-10 h-10 rounded-xl items-center justify-center mb-3.5 text-lg border border-accent/10"
                  style={{
                    background: "linear-gradient(135deg, var(--accent-surface), color-mix(in srgb, var(--accent-2) 10%, transparent))",
                  }}
                >
                  {f.icon}
                </div>
                <h3 className="text-[1rem] font-bold tracking-tight mb-1.5">{f.title}</h3>
                <p className="text-[0.85rem] text-secondary leading-relaxed">{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── TRUST BAR ─────────────────────────────────────── */}
      <section
        className="py-16 px-6 text-center border-t border-b border-secondary"
        style={{
          background:
            "linear-gradient(135deg, var(--accent-surface), color-mix(in srgb, var(--accent-2) 12%, transparent))",
        }}
      >
        <div className="max-w-[720px] mx-auto">
          <h3 className="text-lg font-bold tracking-tight mb-3.5 inline-flex items-center gap-2.5">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-accent">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
            </svg>
            Your data, your rules
          </h3>
          <p className="text-[0.95rem] text-secondary leading-relaxed mb-5">
            Envoy reads your calendar to understand your schedule — but never shares event details with guests. Preferences are stored as structured data. No training on your data. Delete anytime.
          </p>
          <div className="flex justify-center gap-7 flex-wrap">
            <a href="/privacy" className="text-sm text-accent font-semibold hover:underline">Privacy Policy &rarr;</a>
            <a href="/terms" className="text-sm text-accent font-semibold hover:underline">Terms &rarr;</a>
            <a href="/agents" className="text-sm text-accent font-semibold hover:underline">For Agents &rarr;</a>
          </div>
        </div>
      </section>

      {/* ── FINAL CTA ─────────────────────────────────────── */}
      <section id="cta" className="relative py-28 md:py-32 px-6 text-center overflow-hidden">
        <div
          className="absolute inset-0 -z-10 pointer-events-none"
          style={{
            background:
              "radial-gradient(ellipse 700px 400px at 50% 60%, color-mix(in srgb, var(--accent) 16%, transparent) 0%, transparent 70%), radial-gradient(ellipse 500px 300px at 80% 20%, color-mix(in srgb, var(--accent-2) 12%, transparent) 0%, transparent 70%)",
          }}
        />
        <div className="max-w-[620px] mx-auto">
          <h2 className="text-4xl md:text-[2.75rem] font-extrabold tracking-[-0.03em] mb-4">
            Ready to stop scheduling?
          </h2>
          <p className="text-base md:text-lg text-secondary mb-9">
            Connect your Google Calendar. Customize each meeting in seconds. Let Envoy handle the rest.
          </p>
          <div className="inline-flex gap-3.5 items-center flex-wrap justify-center">
            <button
              onClick={handleSignIn}
              className="inline-flex items-center gap-2.5 bg-accent hover:bg-accent-hover text-white px-9 py-4 rounded-xl text-lg font-semibold transition shadow-accent-glow-lg hover:-translate-y-0.5 group"
            >
              <GoogleIcon className="w-5 h-5" />
              Get Started with Google
              <ArrowRight className="w-4 h-4 transition group-hover:translate-x-0.5" />
            </button>
            <a
              href="/agents"
              className="inline-flex items-center gap-2 bg-transparent text-primary border border-DEFAULT hover:bg-surface-secondary px-6 py-4 rounded-xl text-base font-medium transition"
            >
              For agents
            </a>
          </div>
          <p className="text-xs text-muted mt-5">Free while in beta &middot; No credit card required</p>
        </div>
      </section>
    </>
  );
}

/* ── Sub-components ──────────────────────────────────────── */

function AgentNode({
  icon,
  label,
  sub,
  highlighted,
}: {
  icon: string;
  label: string;
  sub: string;
  highlighted?: boolean;
}) {
  if (highlighted) {
    return (
      <div
        className="rounded-3xl p-6 text-center text-white shadow-accent-glow-lg"
        style={{ background: "linear-gradient(135deg, var(--accent), var(--accent-2))" }}
      >
        <div className="inline-flex w-14 h-14 rounded-2xl items-center justify-center text-2xl mb-3 bg-white/20">
          {icon}
        </div>
        <div className="text-[0.95rem] font-bold tracking-tight mb-0.5">{label}</div>
        <div className="text-[0.78rem] opacity-80">{sub}</div>
      </div>
    );
  }
  return (
    <div className="bg-surface border border-DEFAULT rounded-3xl p-6 text-center shadow-[0_8px_32px_-8px_rgba(30,27,75,0.12)] dark:shadow-[0_8px_32px_-8px_rgba(0,0,0,0.4)]">
      <div
        className="inline-flex w-14 h-14 rounded-2xl items-center justify-center text-2xl mb-3"
        style={{ background: "var(--accent-surface)" }}
      >
        {icon}
      </div>
      <div className="text-[0.95rem] font-bold tracking-tight mb-0.5">{label}</div>
      <div className="text-[0.78rem] text-muted">{sub}</div>
    </div>
  );
}

function Connector() {
  return (
    <div className="flex justify-center md:block">
      <div
        className="relative h-0.5 w-20 rounded overflow-hidden md:rotate-0 rotate-90"
        style={{ background: "linear-gradient(90deg, var(--accent), var(--accent-2))" }}
      >
        <div
          className="absolute top-0 h-full w-[30%] animate-flow-line"
          style={{
            background: "linear-gradient(90deg, transparent, rgba(255,255,255,0.8), transparent)",
            left: "-30%",
          }}
        />
      </div>
    </div>
  );
}

function TechBadge({ children, color }: { children: React.ReactNode; color: "accent" | "accent2" | "accent3" }) {
  const styles = {
    accent: { bg: "var(--accent-surface)", fg: "var(--accent)", border: "color-mix(in srgb, var(--accent) 25%, transparent)" },
    accent2: { bg: "color-mix(in srgb, var(--accent-2) 12%, transparent)", fg: "var(--accent-2)", border: "color-mix(in srgb, var(--accent-2) 30%, transparent)" },
    accent3: { bg: "color-mix(in srgb, var(--accent-3) 12%, transparent)", fg: "var(--accent-3)", border: "color-mix(in srgb, var(--accent-3) 35%, transparent)" },
  }[color];
  return (
    <span
      className="text-[0.7rem] font-bold uppercase tracking-wider px-3 py-1.5 rounded-full border"
      style={{ background: styles.bg, color: styles.fg, borderColor: styles.border }}
    >
      {children}
    </span>
  );
}
