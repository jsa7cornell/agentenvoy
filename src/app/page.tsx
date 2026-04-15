"use client";

import { signIn, useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { LogoIcon, LogoFull } from "@/components/logo";

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

/* ── Section label ───────────────────────────────────────── */
function SectionLabel({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <p className={`text-xs font-semibold tracking-widest uppercase text-accent mb-3 ${className}`}>
      {children}
    </p>
  );
}

/* ── Main page ───────────────────────────────────────────── */
export default function Home() {
  const { status } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (status === "authenticated") {
      router.push("/dashboard");
    }
  }, [status, router]);

  const handleSignIn = () => signIn("google", { callbackUrl: "/dashboard" });

  if (status === "authenticated") return null;

  return (
    <>
      {/* ── NAV ────────────────────────────────────────── */}
      <nav className="sticky top-0 z-50 bg-surface/80 backdrop-blur-md border-b border-secondary">
        <div className="max-w-[1120px] mx-auto px-6 h-14 flex items-center justify-between">
          <a href="/" className="flex items-center gap-2.5">
            <LogoFull height={24} className="text-primary" />
          </a>
          <div className="flex items-center gap-7">
            <a href="#demo" className="hidden md:inline text-sm text-secondary hover:text-primary transition">Demo</a>
            <a href="#how-it-works" className="hidden md:inline text-sm text-secondary hover:text-primary transition">How It Works</a>
            <a href="#features" className="hidden md:inline text-sm text-secondary hover:text-primary transition">Features</a>
            <button
              onClick={handleSignIn}
              className="bg-accent hover:bg-accent-hover text-white px-4 py-2 rounded-lg text-sm font-medium transition"
            >
              Get Started
            </button>
          </div>
        </div>
      </nav>

      {/* ── HERO ───────────────────────────────────────── */}
      <section className="min-h-[85vh] flex items-center justify-center text-center px-6 py-16 relative">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_50%_40%,#e8e8f0_0%,#ffffff_70%)] dark:bg-[radial-gradient(ellipse_at_50%_40%,#1a1a2e_0%,#0a0a0f_70%)]" />
        <div className="relative z-10 max-w-[700px]">
          <div className="flex justify-center mb-6">
            <LogoIcon size={56} className="text-accent" />
          </div>
          <h1 className="text-5xl md:text-7xl font-extrabold tracking-tight">
            <span className="bg-gradient-to-r from-indigo-500 via-purple-400 to-indigo-500 bg-clip-text text-transparent animate-[shimmer_3s_ease_infinite] bg-[length:200%_200%]">
              AgentEnvoy
            </span>
            <span className="text-muted font-light">.ai</span>
          </h1>
          <p className="mt-5 text-lg md:text-xl font-light text-secondary leading-relaxed">
            From <strong className="font-medium text-primary">scheduling meetings</strong> to{" "}
            <strong className="font-medium text-primary">navigating proposals</strong> — your AI
            negotiates so you don&apos;t have to.
          </p>
          <div className="mt-10 flex flex-col sm:flex-row gap-4 justify-center">
            <button
              onClick={handleSignIn}
              className="inline-flex items-center justify-center gap-2.5 bg-indigo-600 hover:bg-indigo-500 text-white px-8 py-3.5 rounded-xl text-base font-medium transition shadow-lg shadow-indigo-500/20 hover:-translate-y-0.5"
            >
              <GoogleIcon />
              Get Started with Google
            </button>
            <a
              href="#demo"
              className="inline-flex items-center justify-center gap-2 bg-surface-secondary hover:bg-surface-tertiary text-primary border border-DEFAULT px-7 py-3.5 rounded-xl text-base font-medium transition hover:-translate-y-0.5"
            >
              See It In Action
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 5v14M19 12l-7 7-7-7"/>
              </svg>
            </a>
          </div>
        </div>
      </section>

      {/* ── DEMO ───────────────────────────────────────── */}
      <section id="demo" className="bg-[#0a0a0f] py-20 md:py-24 text-center px-6">
        <div className="max-w-[1120px] mx-auto">
          <SectionLabel className="!text-indigo-400">See It In Action</SectionLabel>
          <h2 className="text-3xl md:text-4xl font-bold text-[#f4f4f5] mb-4">
            Watch how Envoy coordinates a meeting
          </h2>
          <p className="text-base md:text-lg text-[#a1a1aa] max-w-xl mx-auto mb-12">
            From the first request to a confirmed calendar invite — see the full experience in under two minutes.
          </p>
        </div>
        <div className="relative max-w-[880px] mx-auto">
          {/* Glow */}
          <div className="absolute inset-0 -m-16 bg-[radial-gradient(ellipse,rgba(99,102,241,0.12)_0%,transparent_70%)] pointer-events-none" />
          <div className="relative rounded-2xl overflow-hidden border border-[#2a2a3a] shadow-[0_20px_80px_rgba(0,0,0,0.5),inset_0_0_0_1px_rgba(255,255,255,0.05)]">
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

      {/* ── HOW IT WORKS ───────────────────────────────── */}
      <section id="how-it-works" className="py-24 px-6 text-center">
        <div className="max-w-[1120px] mx-auto">
          <SectionLabel>How It Works</SectionLabel>
          <h2 className="text-3xl md:text-4xl font-bold text-primary mb-4">
            Three steps to never schedule again
          </h2>
          <p className="text-base md:text-lg text-secondary max-w-xl mx-auto mb-14">
            Connect your calendar. Share a link. Envoy takes it from there.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-12 md:gap-12 text-center">
            {[
              {
                num: "1",
                title: "Connect your calendar",
                desc: "Sign in with Google. Envoy learns your schedule, preferences, and how you like to meet — in a 5\u2011minute calibration chat.",
              },
              {
                num: "2",
                title: "Share your link",
                desc: (
                  <>
                    Your personal link (<span className="text-accent font-mono text-sm">agentenvoy.ai/meet/you</span>) works for anyone. Or create event-specific links with custom rules.
                  </>
                ),
              },
              {
                num: "3",
                title: "Envoy handles the rest",
                desc: "Envoy proposes times, negotiates preferences, and books the meeting. You get a calendar invite. Done.",
              },
            ].map((step) => (
              <div key={step.num} className="relative">
                <div className="inline-flex items-center justify-center w-13 h-13 rounded-full border-2 border-accent bg-accent-surface text-accent text-xl font-bold mb-5">
                  {step.num}
                </div>
                <h3 className="text-lg font-semibold text-primary mb-3">{step.title}</h3>
                <p className="text-sm text-secondary leading-relaxed max-w-[300px] mx-auto">{step.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── CUSTOM LINKS SHOWCASE ──────────────────────── */}
      <section id="custom-links" className="py-24 px-6 bg-surface-inset">
        <div className="max-w-[1000px] mx-auto grid grid-cols-1 md:grid-cols-2 gap-16 items-center">
          {/* Text */}
          <div>
            <SectionLabel>The Killer Feature</SectionLabel>
            <h2 className="text-3xl md:text-4xl font-bold text-primary mb-4">
              Every meeting gets its own link
            </h2>
            <p className="text-base text-secondary leading-relaxed mb-7">
              Don&apos;t just share your calendar — tell Envoy <em>how</em> to schedule each meeting.
              Lock specific time slots, set the format, add context. Every guest gets a link
              pre-configured with your rules.
            </p>
            <ul className="space-y-2">
              {[
                ["Lock availability", "only offer the slots you want for this meeting"],
                ["Set the format", "phone, video, coffee, dinner — Envoy enforces it"],
                ["Add context", "\u201CThis is about Q2 planning, keep it to 30 min\u201D"],
                ["Per-guest rules", "different priorities for different people"],
                ["General link too", "a permanent link for your email signature that uses your default preferences"],
              ].map(([title, desc]) => (
                <li key={title} className="flex items-start gap-2.5 text-sm text-secondary">
                  <span className="text-accent font-bold mt-0.5 shrink-0">✓</span>
                  <span><strong className="text-primary font-medium">{title}</strong> — {desc}</span>
                </li>
              ))}
            </ul>
          </div>

          {/* Mock link card */}
          <div className="relative pb-4">
            <div className="relative z-10 bg-surface-secondary border border-DEFAULT rounded-2xl overflow-hidden shadow-lg dark:shadow-[0_8px_40px_rgba(0,0,0,0.3)]">
              {/* Header */}
              <div className="px-5 py-3.5 border-b border-secondary flex items-center gap-2.5">
                <span className="w-2 h-2 rounded-full bg-emerald-500" />
                <span className="font-mono text-xs text-muted flex-1">agentenvoy.ai/meet/john/q2-sarah</span>
              </div>
              {/* Body */}
              <div className="px-5 py-5">
                <p className="font-semibold text-primary text-sm mb-0.5">Q2 Planning — Sarah Chen</p>
                <p className="text-xs text-muted mb-5">Created 2 hours ago &middot; Expires Apr 18</p>

                {[
                  { icon: "📅", title: "Locked to Tue Apr 15", desc: "only 10am, 2pm, and 3:30pm offered" },
                  { icon: "📞", title: "Phone only", desc: "no video, no in-person" },
                  { icon: "⏱", title: "30 minutes max", desc: "quick sync on budget" },
                  { icon: "📋", title: "Context:", desc: "\u201CReview Q2 marketing budget before Thursday board meeting\u201D" },
                ].map((rule) => (
                  <div key={rule.title} className="flex items-start gap-3 py-2.5 border-t border-secondary">
                    <span className="shrink-0 w-7 h-7 rounded-md bg-accent-surface flex items-center justify-center text-sm">{rule.icon}</span>
                    <p className="text-sm text-secondary leading-snug">
                      <strong className="text-primary font-medium">{rule.title}</strong> — {rule.desc}
                    </p>
                  </div>
                ))}
              </div>
            </div>
            {/* Stacked card behind */}
            <div className="absolute bottom-0 left-3 right-3 h-14 bg-surface-tertiary border border-secondary rounded-b-2xl opacity-70 z-0" />
          </div>
        </div>
      </section>

      {/* ── OFFICE HOURS SHOWCASE ──────────────────────── */}
      <section id="office-hours" className="py-24 px-6">
        <div className="max-w-[1000px] mx-auto grid grid-cols-1 md:grid-cols-2 gap-16 items-center">
          {/* Text */}
          <div>
            <SectionLabel>New · Office Hours</SectionLabel>
            <h2 className="text-3xl md:text-4xl font-bold text-primary mb-4">
              One link. A recurring window. As many bookings as you want.
            </h2>
            <p className="text-base text-secondary leading-relaxed mb-7">
              Declare a window once &mdash; &ldquo;Tuesdays 2&ndash;4pm, 20-min video calls&rdquo; &mdash;
              and share a single URL. Anyone with the link can book an open slot without asking.
              Envoy handles conflicts, double-booking, and the calendar invite.
            </p>
            <ul className="space-y-2">
              {[
                ["Plain-English setup", "type it like a rule: \u201Coffice hours Fridays 10\u2013noon, 30-min phone\u201D"],
                ["One link, many guests", "each visitor books independently; already-taken slots disappear"],
                ["Overrides soft blocks", "focus time and weekends don\u2019t hide office hours; real events still do"],
                ["Lives with your rules", "pause, expire, or edit like any other availability rule"],
              ].map(([title, desc]) => (
                <li key={title} className="flex items-start gap-2.5 text-sm text-secondary">
                  <span className="text-accent font-bold mt-0.5 shrink-0">✓</span>
                  <span><strong className="text-primary font-medium">{title}</strong> &mdash; {desc}</span>
                </li>
              ))}
            </ul>
          </div>

          {/* Mock office hours card */}
          <div className="relative">
            <div className="bg-surface-secondary border border-DEFAULT rounded-2xl overflow-hidden shadow-lg dark:shadow-[0_8px_40px_rgba(0,0,0,0.3)]">
              <div className="px-5 py-3.5 border-b border-secondary flex items-center gap-2.5">
                <span className="w-2 h-2 rounded-full bg-accent" />
                <span className="font-mono text-xs text-muted flex-1">agentenvoy.ai/meet/john/a7k2mp9q</span>
              </div>
              <div className="px-5 py-5">
                <p className="font-semibold text-primary text-sm mb-0.5">Advising Office Hours</p>
                <p className="text-xs text-muted mb-5">Tuesdays 2&ndash;4 PM &middot; 20-min video &middot; No end date</p>
                <p className="text-[0.65rem] font-semibold uppercase tracking-wider text-accent mb-2">
                  Open slots this week
                </p>
                <div className="grid grid-cols-3 gap-2">
                  {["2:00 PM", "2:20 PM", "2:40 PM", "3:00 PM", "3:20 PM", "3:40 PM"].map((slot, i) => (
                    <span
                      key={slot}
                      className={`text-xs font-medium rounded-lg px-2 py-1.5 text-center border ${
                        i === 1
                          ? "text-muted line-through border-DEFAULT bg-surface"
                          : "text-primary border-accent bg-accent-surface"
                      }`}
                    >
                      {slot}
                    </span>
                  ))}
                </div>
                <p className="text-[10px] text-muted mt-3 italic">2:20 already booked &mdash; Envoy won&rsquo;t offer it again</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── GROUP MEETINGS SHOWCASE ────────────────────── */}
      <section id="groups" className="py-24 px-6">
        <div className="max-w-[1000px] mx-auto grid grid-cols-1 md:grid-cols-2 gap-16 items-center">
          {/* Mock group card (first on mobile, left on desktop) */}
          <div className="order-first">
            <div className="bg-surface-secondary border border-DEFAULT rounded-2xl overflow-hidden shadow-lg dark:shadow-[0_8px_40px_rgba(0,0,0,0.3)]">
              {/* Header */}
              <div className="px-5 py-4 border-b border-secondary">
                <p className="font-semibold text-primary text-sm">Product Launch Sync</p>
                <p className="text-xs text-muted">4 participants &middot; Finding overlap</p>
              </div>

              {/* Participants */}
              <div className="px-5 py-4 space-y-3">
                {[
                  { initials: "JA", name: "John (host)", status: "12 slots available this week", badge: "Host", badgeClass: "bg-emerald-500/10 text-emerald-500 dark:text-emerald-400", gradient: "from-indigo-500 to-indigo-400" },
                  { initials: "SC", name: "Sarah Chen", status: "Confirmed — prefers mornings", badge: "Confirmed", badgeClass: "bg-emerald-500/10 text-emerald-500 dark:text-emerald-400", gradient: "from-emerald-500 to-emerald-400" },
                  { initials: "MR", name: "Marcus Rivera", status: "Chatting with Envoy now...", badge: "In Progress", badgeClass: "bg-accent-surface text-accent", gradient: "from-amber-500 to-amber-400" },
                  { initials: "LP", name: "Lisa Park", status: "Link sent \u00b7 Not yet opened", badge: "Pending", badgeClass: "bg-amber-500/10 text-amber-600 dark:text-amber-400", gradient: "from-red-500 to-red-400" },
                ].map((p) => (
                  <div key={p.initials} className="flex items-center gap-3">
                    <div className={`w-8 h-8 rounded-full bg-gradient-to-br ${p.gradient} flex items-center justify-center text-xs font-semibold text-white shrink-0`}>
                      {p.initials}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-primary">{p.name}</p>
                      <p className="text-xs text-muted truncate">{p.status}</p>
                    </div>
                    <span className={`text-[0.65rem] font-medium px-2 py-0.5 rounded-full shrink-0 ${p.badgeClass}`}>
                      {p.badge}
                    </span>
                  </div>
                ))}
              </div>

              {/* Overlap */}
              <div className="px-5 py-4 border-t border-secondary bg-emerald-500/5">
                <p className="text-[0.65rem] font-semibold uppercase tracking-wider text-emerald-600 dark:text-emerald-400 mb-2">
                  Overlap found (3 of 4 confirmed)
                </p>
                <div className="flex gap-2 flex-wrap">
                  {["Tue 10:00 AM", "Wed 2:00 PM", "Thu 11:30 AM"].map((slot) => (
                    <span key={slot} className="text-xs font-medium text-primary bg-surface border border-emerald-500 rounded-lg px-2.5 py-1">
                      {slot}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* Text */}
          <div>
            <SectionLabel>Group Scheduling</SectionLabel>
            <h2 className="text-3xl md:text-4xl font-bold text-primary mb-4">
              Coordinate across multiple people
            </h2>
            <p className="text-base text-secondary leading-relaxed mb-7">
              Send each participant their own link. Everyone chats privately with Envoy — no reply-all
              chains, no polling. Envoy finds the overlap and books it.
            </p>
            <ul className="space-y-2">
              {[
                ["Private conversations", "each guest talks to Envoy 1:1, nobody sees anyone else\u2019s calendar"],
                ["Real-time overlap", "Envoy calculates availability across all participants as they respond"],
                ["No account needed", "guests just click a link and chat"],
                ["Scales naturally", "works for 2 people or 20"],
              ].map(([title, desc]) => (
                <li key={title} className="flex items-start gap-2.5 text-sm text-secondary">
                  <span className="text-emerald-500 font-bold mt-0.5 shrink-0">✓</span>
                  <span><strong className="text-primary font-medium">{title}</strong> — {desc}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {/* ── FEATURES GRID ──────────────────────────────── */}
      <section id="features" className="py-24 px-6 text-center">
        <div className="max-w-[1120px] mx-auto">
          <SectionLabel>And More</SectionLabel>
          <h2 className="text-3xl md:text-4xl font-bold text-primary mb-12">
            Built for real scheduling
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5 text-left">
            {[
              { icon: "📅", title: "Calendar Intelligence", desc: "Real-time Google Calendar sync. Understands declined invites, tentative holds, focus time, and recurring events." },
              { icon: "🔒", title: "Privacy First", desc: "Guests never see your calendar. Envoy shares only what it needs to negotiate. Your schedule stays private." },
              { icon: "🤖", title: "Agent-Native API", desc: "Your AI agent talks to Envoy via REST or MCP. No human in the loop for routine scheduling." },
              { icon: "⚡", title: "Scoring Engine", desc: "Every slot gets a protection score. Deterministic, <10ms, no AI calls. Consistent and explainable." },
            ].map((f) => (
              <div key={f.title} className="bg-surface-secondary border border-secondary rounded-2xl p-6 hover:border-DEFAULT hover:-translate-y-0.5 transition-all">
                <span className="text-2xl mb-3 block">{f.icon}</span>
                <h3 className="text-sm font-semibold text-primary mb-1.5">{f.title}</h3>
                <p className="text-xs text-secondary leading-relaxed">{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── TRUST BAR ──────────────────────────────────── */}
      <section className="py-16 px-6 bg-accent-surface text-center">
        <div className="max-w-[720px] mx-auto">
          <h3 className="text-base font-semibold text-primary mb-3 flex items-center justify-center gap-2">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-accent">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
            </svg>
            Your data, your rules
          </h3>
          <p className="text-sm text-secondary leading-relaxed mb-5">
            Envoy reads your calendar to understand your schedule — but never shares event details with guests.
            Preferences are stored as structured data, not sent to third parties. No training on your data. Delete anytime.
          </p>
          <div className="flex justify-center gap-6">
            <a href="/privacy" className="text-sm text-accent font-medium hover:underline">Read our Privacy Policy &rarr;</a>
            <a href="/faq#under-the-hood" className="text-sm text-accent font-medium hover:underline">See How Scoring Works &rarr;</a>
          </div>
        </div>
      </section>

      {/* ── FINAL CTA ──────────────────────────────────── */}
      <section id="cta" className="py-28 md:py-32 px-6 text-center relative">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_50%_60%,#e8e8f0_0%,#ffffff_70%)] dark:bg-[radial-gradient(ellipse_at_50%_60%,#1a1a2e_0%,#0a0a0f_70%)]" />
        <div className="relative z-10 max-w-[600px] mx-auto">
          <h2 className="text-3xl md:text-4xl font-bold text-primary mb-4">
            Ready to stop scheduling?
          </h2>
          <p className="text-base md:text-lg text-secondary mb-10">
            Connect your Google Calendar and let Envoy handle the back-and-forth.
          </p>
          <button
            onClick={handleSignIn}
            className="inline-flex items-center justify-center gap-2.5 bg-indigo-600 hover:bg-indigo-500 text-white px-10 py-4 rounded-xl text-lg font-medium transition shadow-lg shadow-indigo-500/20 hover:-translate-y-0.5"
          >
            <GoogleIcon className="w-5 h-5" />
            Get Started with Google
          </button>
          <p className="text-xs text-muted mt-4">Free while in beta. No credit card required.</p>
        </div>
      </section>
    </>
  );
}
