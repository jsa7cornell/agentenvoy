"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Slot = { label: string; time: string; place: string };
type Confirm = { title: string; meta: string };

type Scenario = {
  key: string;
  chipLabel: string;
  userMsg: string;
  envoyIntro: string;
  slots: Slot[];
  envoyPick: string;
  confirm: Confirm;
  /** Optional: render a small badge on the user message (used for agent-to-agent) */
  userBadge?: string;
};

const SCENARIOS: Record<string, Scenario> = {
  coffee: {
    key: "coffee",
    chipLabel: "☕ Quick coffee next week",
    userMsg: "Quick coffee next week?",
    envoyIntro: "Coffee — nice. John's free on a few mornings. Pick one:",
    slots: [
      { label: "Tue Apr 15", time: "9:00 AM", place: "☕ Blue Bottle" },
      { label: "Wed Apr 16", time: "8:30 AM", place: "☕ Sightglass" },
      { label: "Fri Apr 18", time: "10:00 AM", place: "☕ John's choice" },
    ],
    envoyPick: "Perfect. I'll send the invite to both of you.",
    confirm: {
      title: "Coffee with John",
      meta: "Wed Apr 16 · 8:30 AM · Sightglass Coffee",
    },
  },
  demo: {
    key: "demo",
    chipLabel: "📞 30-min product demo",
    userMsg: "Looking for a 30-min product demo",
    envoyIntro: "Product demo — I'll keep it to 30 minutes. John's next open slots:",
    slots: [
      { label: "Mon Apr 14", time: "2:00 PM", place: "📞 Phone" },
      { label: "Tue Apr 15", time: "3:30 PM", place: "📹 Video" },
      { label: "Thu Apr 17", time: "11:00 AM", place: "📹 Video" },
    ],
    envoyPick: "Locked in. Calendar invite with the video link is on its way.",
    confirm: {
      title: "Product demo with John",
      meta: "Tue Apr 15 · 3:30 PM · 30 min · Video call",
    },
  },
  team: {
    key: "team",
    chipLabel: "👥 Team sync with 3 people",
    userMsg: "Team sync with 3 people",
    envoyIntro:
      "Group meeting — I'll coordinate with everyone separately. Here's where the team overlaps this week:",
    slots: [
      { label: "Tue Apr 15", time: "10:00 AM", place: "3 confirmed" },
      { label: "Wed Apr 16", time: "2:00 PM", place: "4 confirmed" },
      { label: "Thu Apr 17", time: "11:30 AM", place: "3 confirmed" },
    ],
    envoyPick: "Confirmed. All four calendars now show the invite.",
    confirm: {
      title: "Team sync (4 people)",
      meta: "Wed Apr 16 · 2:00 PM · 4 of 4 confirmed",
    },
  },
  agent: {
    key: "agent",
    chipLabel: "🤖 Hi, I'm Sarah's agent",
    userMsg: "Hi — I'm coordinating on behalf of Sarah. Can we grab 30 minutes with John this week?",
    userBadge: "agent",
    envoyIntro:
      "Got it — working directly with Sarah's agent. I'll propose times John's free that fit Sarah's preferences (mornings, video).",
    slots: [
      { label: "Tue Apr 15", time: "10:00 AM", place: "📹 Both agree" },
      { label: "Wed Apr 16", time: "9:30 AM", place: "📹 Both agree" },
      { label: "Thu Apr 17", time: "11:00 AM", place: "📹 Both agree" },
    ],
    envoyPick:
      "Confirmed with Sarah's agent. Zero humans touched this — invites are in both calendars.",
    confirm: {
      title: "John ↔ Sarah (agent-to-agent)",
      meta: "Wed Apr 16 · 9:30 AM · 30 min · Video",
    },
  },
};

type Msg =
  | { id: string; kind: "user"; text: string; badge?: string }
  | { id: string; kind: "envoy"; text: string }
  | { id: string; kind: "typing" }
  | {
      id: string;
      kind: "slots";
      slots: Slot[];
      scenario: string;
      locked: boolean;
    }
  | { id: string; kind: "confirm"; confirm: Confirm };

let msgIdCounter = 0;
const nextId = () => `m${++msgIdCounter}`;

const INITIAL_MSG: Msg = {
  id: "greet",
  kind: "envoy",
  text: "Hi — I'm Envoy, John's scheduling agent. What can I help you with?",
};

export function TryItChat() {
  const [messages, setMessages] = useState<Msg[]>([INITIAL_MSG]);
  const [busy, setBusy] = useState(false);
  const [ctaShown, setCtaShown] = useState(false);
  const [chipsHidden, setChipsHidden] = useState(false);
  const [inputValue, setInputValue] = useState("");
  const bodyRef = useRef<HTMLDivElement>(null);

  // Auto-scroll chat body to bottom on new message
  useEffect(() => {
    if (bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [messages]);

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  const appendMessage = (m: Msg) => {
    setMessages((prev) => [...prev, m]);
  };

  const replaceLastTyping = (replacement: Msg) => {
    setMessages((prev) => {
      const filtered = prev.filter((p) => p.kind !== "typing");
      return [...filtered, replacement];
    });
  };

  const lockSlots = (scenarioKey: string) => {
    setMessages((prev) =>
      prev.map((m) =>
        m.kind === "slots" && m.scenario === scenarioKey ? { ...m, locked: true } : m
      )
    );
  };

  const runScenario = useCallback(
    async (key: string) => {
      if (busy) return;
      const scenario = SCENARIOS[key];
      if (!scenario) return;

      setBusy(true);
      setChipsHidden(true);

      // User message
      await sleep(120);
      appendMessage({
        id: nextId(),
        kind: "user",
        text: scenario.userMsg,
        badge: scenario.userBadge,
      });

      // Typing → intro
      await sleep(500);
      appendMessage({ id: nextId(), kind: "typing" });
      await sleep(900);
      replaceLastTyping({ id: nextId(), kind: "envoy", text: scenario.envoyIntro });

      // Slots
      await sleep(300);
      appendMessage({
        id: nextId(),
        kind: "slots",
        slots: scenario.slots,
        scenario: key,
        locked: false,
      });

      setBusy(false);
    },
    [busy]
  );

  const handlePickSlot = useCallback(
    async (scenarioKey: string, slot: Slot) => {
      const scenario = SCENARIOS[scenarioKey];
      if (!scenario) return;

      lockSlots(scenarioKey);

      await sleep(120);
      appendMessage({
        id: nextId(),
        kind: "user",
        text: `${slot.label} at ${slot.time}`,
      });

      await sleep(500);
      appendMessage({ id: nextId(), kind: "typing" });
      await sleep(800);
      replaceLastTyping({ id: nextId(), kind: "envoy", text: scenario.envoyPick });

      await sleep(400);
      appendMessage({ id: nextId(), kind: "confirm", confirm: scenario.confirm });

      setCtaShown(true);
    },
    []
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputValue.trim() || busy) return;
    setInputValue("");
    // Any freeform input triggers the coffee scenario
    runScenario("coffee");
  };

  const visibleChips = Object.values(SCENARIOS).slice(0, 3); // first 3 chips; agent scenario accessed via "More" for now

  return (
    <div className="relative rounded-3xl overflow-hidden bg-surface border border-DEFAULT shadow-[0_24px_60px_-12px_rgba(30,27,75,0.18)] dark:shadow-[0_24px_60px_-12px_rgba(0,0,0,0.6)]">
      {/* Glow halo */}
      <div
        className="absolute -inset-10 -z-10 pointer-events-none"
        style={{
          background: "radial-gradient(ellipse at center, var(--accent-glow) 0%, transparent 65%)",
          filter: "blur(40px)",
        }}
      />

      {/* Header */}
      <div className="flex items-center gap-3 px-5 py-3.5 bg-surface-secondary border-b border-secondary">
        <div
          className="w-8 h-8 rounded-xl flex items-center justify-center text-white font-bold text-sm shadow-accent-glow"
          style={{ background: "linear-gradient(135deg, var(--accent), var(--accent-2))" }}
        >
          E
        </div>
        <div className="flex-1 leading-tight">
          <div className="text-sm font-semibold text-primary">Envoy</div>
          <div className="text-[0.72rem] text-muted flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
            Online &middot; John&apos;s scheduling agent
          </div>
        </div>
        <span className="text-[0.65rem] font-semibold uppercase tracking-wider text-accent bg-accent-surface px-2.5 py-1 rounded-full">
          Try it
        </span>
      </div>

      {/* Body */}
      <div
        ref={bodyRef}
        className="px-4 py-4 flex flex-col gap-2.5 overflow-y-auto scroll-smooth"
        style={{ minHeight: 340, maxHeight: 420 }}
      >
        {messages.map((m) => {
          if (m.kind === "envoy") {
            return (
              <div
                key={m.id}
                className="self-start max-w-[82%] bg-surface-secondary text-primary rounded-2xl rounded-bl-md px-3.5 py-2.5 text-[0.92rem] leading-snug animate-fade-up"
              >
                {m.text}
              </div>
            );
          }
          if (m.kind === "user") {
            return (
              <div
                key={m.id}
                className="self-end max-w-[82%] bg-accent text-white rounded-2xl rounded-br-md px-3.5 py-2.5 text-[0.92rem] leading-snug animate-fade-up"
              >
                {m.badge ? (
                  <span className="text-[0.65rem] font-semibold uppercase tracking-wider bg-white/25 px-2 py-0.5 rounded-full mr-2">
                    {m.badge}
                  </span>
                ) : null}
                {m.text}
              </div>
            );
          }
          if (m.kind === "typing") {
            return (
              <div
                key={m.id}
                className="self-start inline-flex gap-1 bg-surface-secondary rounded-2xl rounded-bl-md px-4 py-3"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-muted animate-typing-bounce" />
                <span
                  className="w-1.5 h-1.5 rounded-full bg-muted animate-typing-bounce"
                  style={{ animationDelay: "0.15s" }}
                />
                <span
                  className="w-1.5 h-1.5 rounded-full bg-muted animate-typing-bounce"
                  style={{ animationDelay: "0.3s" }}
                />
              </div>
            );
          }
          if (m.kind === "slots") {
            return (
              <div
                key={m.id}
                className="self-start max-w-[90%] grid grid-cols-3 gap-1.5 animate-fade-up"
              >
                {m.slots.map((s, i) => (
                  <button
                    key={i}
                    type="button"
                    disabled={m.locked}
                    onClick={() => handlePickSlot(m.scenario, s)}
                    className="bg-surface border border-DEFAULT rounded-xl px-2 py-2.5 text-[0.76rem] font-medium text-primary text-center leading-tight transition hover:border-accent hover:bg-accent-surface hover:-translate-y-0.5 disabled:opacity-50 disabled:pointer-events-none"
                  >
                    <span className="block text-accent text-[0.8rem] font-semibold mb-0.5">
                      {s.label}
                    </span>
                    {s.time}
                    <br />
                    <span className="text-muted text-[0.68rem]">{s.place}</span>
                  </button>
                ))}
              </div>
            );
          }
          if (m.kind === "confirm") {
            return (
              <div
                key={m.id}
                className="self-start max-w-[90%] bg-surface border border-emerald-500 rounded-2xl p-3.5 animate-fade-up"
                style={{ boxShadow: "0 4px 16px rgba(16, 185, 129, 0.12)" }}
              >
                <div className="inline-flex items-center gap-1.5 text-[0.68rem] font-bold uppercase tracking-wider text-emerald-600 dark:text-emerald-400 mb-2">
                  <span className="inline-flex w-4 h-4 items-center justify-center bg-emerald-500 text-white rounded-full text-[0.6rem]">
                    ✓
                  </span>
                  Confirmed
                </div>
                <div className="text-[0.95rem] font-semibold text-primary mb-0.5">
                  {m.confirm.title}
                </div>
                <div className="text-[0.8rem] text-secondary">{m.confirm.meta}</div>
                <div className="text-[0.78rem] text-muted mt-1.5">Calendar invite sent.</div>
              </div>
            );
          }
          return null;
        })}
      </div>

      {/* Inline CTA */}
      {ctaShown && (
        <div className="mx-3.5 mb-3.5 flex items-center justify-between gap-2.5 p-3 rounded-xl border border-accent/20 animate-fade-up"
          style={{
            background:
              "linear-gradient(135deg, var(--accent-surface), color-mix(in srgb, var(--accent-2) 10%, transparent))",
          }}
        >
          <div className="text-[0.82rem]">
            <strong className="font-semibold text-primary">That&apos;s what your guests experience.</strong>
            <br />
            <span className="text-secondary">Get your own link in 30 seconds.</span>
          </div>
          <a
            href="#cta"
            className="shrink-0 bg-accent hover:bg-accent-hover text-white text-xs font-semibold px-3.5 py-1.5 rounded-lg transition"
          >
            Get Started &rarr;
          </a>
        </div>
      )}

      {/* Footer: chips + input */}
      <div className="px-3.5 pb-3.5 pt-3 border-t border-secondary bg-surface">
        {!chipsHidden && (
          <div className="flex gap-1.5 flex-wrap mb-2.5">
            {visibleChips.map((c) => (
              <button
                key={c.key}
                type="button"
                onClick={() => runScenario(c.key)}
                className="text-[0.78rem] font-medium text-secondary bg-surface-secondary border border-secondary rounded-full px-3 py-1.5 transition hover:bg-accent-surface hover:text-accent hover:border-accent/30"
              >
                {c.chipLabel}
              </button>
            ))}
            <button
              type="button"
              onClick={() => runScenario("agent")}
              className="text-[0.78rem] font-medium text-accent2 bg-accent2/10 border border-accent2/30 rounded-full px-3 py-1.5 transition hover:bg-accent2/20"
            >
              {SCENARIOS.agent.chipLabel}
            </button>
          </div>
        )}
        <form onSubmit={handleSubmit} className="flex gap-2 items-center">
          <input
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            placeholder="Or just type anything..."
            className="flex-1 bg-surface-secondary border border-secondary rounded-xl px-3.5 py-2.5 text-[0.9rem] text-primary placeholder:text-muted outline-none focus:border-accent transition"
          />
          <button
            type="submit"
            aria-label="Send"
            className="bg-accent hover:bg-accent-hover text-white w-9 h-9 rounded-xl flex items-center justify-center transition"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="5" y1="12" x2="19" y2="12" />
              <polyline points="12 5 19 12 12 19" />
            </svg>
          </button>
        </form>
      </div>
    </div>
  );
}
