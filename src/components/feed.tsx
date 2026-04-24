"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import ThreadCard from "./thread-card";
import { ChannelChatStreamParser, type ChannelChatFrame } from "@/lib/channel-chat-stream";
import { computeThreadStatus, computeGroupThreadStatus } from "@/lib/thread-status";
import { formatDuration } from "@/lib/format-duration";
import { QuickReplies } from "./onboarding/quick-replies";
import { PrimaryLinkFlow } from "./onboarding/primary-link-flow";
import { SchedulingStatusChip } from "./scheduling-status-chip";
import { SchedulingLinksChipList } from "./scheduling-links-chip-list";
import { GcalUpdateCard } from "./gcal-update-card";
import { SendFeedbackLink } from "./send-feedback";
import type { QuickReplyOption, OnboardingPhase } from "@/lib/onboarding-machine";

interface ChannelMsg {
  id: string;
  role: string; // "user" | "envoy" | "system"
  content: string;
  threadId?: string | null;
  createdAt: string;
  metadata?: Record<string, unknown> | null;
  thread?: {
    id: string;
    title?: string;
    status: string;
    statusLabel?: string;
    type: string;
    meetingType?: string;
    duration?: number;
    format?: string;
    archived?: boolean;
    agreedTime?: string;
    isGroupEvent?: boolean;
    participants?: Array<{ name: string | null; status: string; role: string }>;
    /** VIP flag extracted server-side from rules.isVip (with legacy
     *  priority string fallback). Renders a single badge on the card. */
    isVip?: boolean;
    /** Short TZ label (e.g. "CEST") resolved server-side from NegotiationSession.guestTimezone. */
    guestTimezoneLabel?: string | null;
    link: {
      inviteeName?: string;
      inviteeNames?: string[];
      inviteeEmail?: string;
      topic?: string;
      code?: string;
      slug: string;
      mode?: string;
      activityIcon?: string | null;
    };
    _count: { messages: number };
  } | null;
}

// ── First-run welcome ────────────────────────────────────────────────────

const SUGGESTION_CARDS = [
  {
    label: "🔗  Set up my primary invite link",
    sub: "Your main AgentEnvoy link — share it with anyone to book time",
    // This card triggers the PrimaryLinkFlow guided sequence rather than
    // seeding a prompt. Sentinel — see FirstRunWelcome handler.
    seed: "__primary_link_flow__",
  },
  {
    label: "☕  Find time for coffee",
    sub: "Grab coffee with someone specific",
    seed: "Help me set up a coffee with someone — send them a link so we can find a time that works.",
  },
  {
    label: "🕐  Create an Office Hours link",
    sub: "Recurring windows where anyone can book",
    seed: "Create an office hours link — 30-minute slots during my available windows, anyone can book",
  },
  {
    label: "🧘  Protect focus time",
    sub: "Block time I won't touch",
    seed: "Block my mornings before 11am — I need that time for deep work",
    mobileHidden: true,
  },
  {
    label: "🎉  Plan a special event",
    sub: "Custom link for a bike ride, dinner, or other occasion",
    seed: "Set up a custom link for a special occasion — like a bike ride or dinner with someone",
    mobileHidden: true,
  },
  {
    label: "👥  Schedule a group gathering",
    sub: "Find a time that works for everyone",
    seed: "Set up a group gathering for my team — about an hour, video call, next week",
    mobileHidden: true,
    comingSoon: true,
  },
  {
    label: "🔁  Coordinate a recurring event",
    sub: "Weekly 1:1s, monthly team syncs, standing book clubs",
    seed: "Help me set up a recurring event",
    mobileHidden: true,
    comingSoon: true,
    wide: true,
  },
] satisfies Array<{ label: string; sub: string; seed: string; mobileHidden?: boolean; wide?: boolean; comingSoon?: boolean }>;

function FirstRunWelcome({ onSeed }: { onSeed: (seed: string) => void }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="flex-1 flex flex-col justify-center py-6 gap-5">
      {/* Envoy welcome bubble */}
      <div className="flex flex-col gap-1">
        <span className="text-purple-400 text-[10px] font-semibold uppercase tracking-wide px-1">
          Envoy
        </span>
        <div className="bg-black/5 dark:bg-white/[0.07] rounded-2xl rounded-bl-sm px-4 py-3 text-sm text-primary max-w-lg leading-relaxed">
          👋 Hey! I&rsquo;m Envoy — I handle your scheduling so you don&rsquo;t have to. The most important thing to set up first is your <span className="font-medium">primary invite link</span>. Pick one below to get started.
        </div>
      </div>

      {/* Suggestion cards */}
      <div className="grid grid-cols-2 gap-2">
        {SUGGESTION_CARDS.map((card) => (
          <button
            key={card.label}
            type="button"
            disabled={card.comingSoon}
            onClick={() => !card.comingSoon && onSeed(card.seed)}
            className={[
              "text-left rounded-xl border border-secondary bg-surface transition px-3 py-2.5 flex-col gap-0.5 relative",
              card.wide ? "col-span-2" : "",
              card.mobileHidden && !expanded ? "hidden md:flex" : "flex",
              card.comingSoon
                ? "opacity-60 cursor-not-allowed"
                : "hover:bg-secondary/40",
            ].join(" ")}
          >
            <span className="text-xs font-medium text-primary flex items-center gap-1.5">
              {card.label}
              {card.comingSoon && (
                <span className="text-[9px] font-semibold uppercase tracking-wide text-purple-400 border border-purple-500/40 rounded px-1 py-[1px] leading-none">
                  Coming soon
                </span>
              )}
            </span>
            <span className="text-[11px] text-muted leading-snug">{card.sub}</span>
          </button>
        ))}

        {/* See more — mobile only, hidden once expanded */}
        {!expanded && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="md:hidden col-span-2 text-xs text-muted border border-dashed border-secondary rounded-xl px-3 py-2 hover:text-secondary transition"
          >
            See more ↓
          </button>
        )}
      </div>
    </div>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────

/** Render **bold** and [link](url) markdown in message content */
function renderMarkdown(text: string): React.ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g);
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={i} className="font-semibold">{part.slice(2, -2)}</strong>;
    }
    const linkMatch = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (linkMatch) {
      return <a key={i} href={linkMatch[2]} className="text-purple-400 hover:text-purple-300 underline">{linkMatch[1]}</a>;
    }
    return <span key={i}>{part}</span>;
  });
}

function MeetLinkCard({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-3 bg-purple-500/10 border border-purple-500/20 rounded-lg p-3 flex items-center gap-3">
      <code className="text-xs text-purple-400 truncate flex-1">{url}</code>
      <button
        onClick={() => {
          navigator.clipboard.writeText(url);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        }}
        className="px-3 py-1.5 bg-purple-600 hover:bg-purple-500 text-white text-xs font-medium rounded-md transition flex-shrink-0"
      >
        {copied ? "Copied!" : "Copy link"}
      </button>
    </div>
  );
}

// ── Feed component ──────────────────────────────────────────────────────

export default function Feed({ onboardReturnTo }: { onboardReturnTo?: string | null } = {}) {
  const router = useRouter();
  const [messages, setMessages] = useState<ChannelMsg[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  // Progress narration status row (proposal decided 2026-04-21). Shows a
  // rotating calendar-themed status line while the server moves through
  // pipeline stages. Replaced by the final envoy bubble on the `text` frame.
  // Screen-reader behaviour: the visible row is aria-live="off" so we don't
  // queue four intermediate announcements; a single aria-live="polite"
  // "Response ready." fires at the text-frame boundary (§2.3 N9).
  const [statusCopy, setStatusCopy] = useState<string | null>(null);
  // Nonce counter for the aria-live "Response ready." announcement. Bumping
  // this re-mounts the aria-live region (via `key={announcementNonce}` on the
  // div) so screen readers re-announce on consecutive turns — without having
  // to put any unique identifier in the text content itself. Previous approach
  // (`Response ready. ${Date.now()}`) leaked the timestamp to sighted users in
  // production when `sr-only` didn't fully hide the region. Fixed 2026-04-21.
  const [announcementNonce, setAnnouncementNonce] = useState(0);
  // Clarifier quick-replies from the intent router's `unclear` tier. When set,
  // quick-reply pills render beneath the most-recent envoy bubble; click
  // re-submits `originalText` with the selected `userIntentHint`, bypassing
  // the classifier. Proposal: 2026-04-21_dashboard-chat-intent-router §2.6.
  const [clarifierState, setClarifierState] = useState<{
    originalText: string;
    replies: Array<{ label: string; intent: "schedule" | "inquire" }>;
  } | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [calendarConnected, setCalendarConnected] = useState(true);
  const [isCalibrated, setIsCalibrated] = useState(true);
  // Primary-link guided setup flow — toggled from the 🔗 welcome card.
  // Replaces the suggestion grid with a scripted Q&A that writes to
  // scheduling-defaults. Stays active until the user navigates or sends
  // their first real chat message (at which point the normal feed takes
  // over because messages.length > 0).
  const [primaryLinkFlowActive, setPrimaryLinkFlowActive] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const hasLoadedRef = useRef(false);

  // ── Onboarding state ──────────────────────────────────────────────────
  const [onboardingPhase, setOnboardingPhase] = useState<OnboardingPhase | null>(null);
  const [activeOptions, setActiveOptions] = useState<QuickReplyOption[] | null>(null);
  const [optionsLocked, setOptionsLocked] = useState(false);
  const [inputPlaceholder, setInputPlaceholder] = useState<string | null>(null);
  const pendingSendRef = useRef<string | null>(null);
  const onboardingInitRef = useRef(false);

  const isOnboarding = !isCalibrated && onboardingPhase !== null && onboardingPhase !== "complete";

  // Composer prefill bus — MyLinksPopover dispatches `envoy:prefill-composer`
  // with a seeded string when the host clicks Rename or Create office-hours.
  useEffect(() => {
    function onPrefill(e: Event) {
      const ce = e as CustomEvent<string>;
      const text = typeof ce.detail === "string" ? ce.detail : "";
      if (!text) return;
      setInput(text);
      textareaRef.current?.focus();
      const el = textareaRef.current;
      if (el) {
        const len = text.length;
        try { el.setSelectionRange(len, len); } catch {}
      }
    }
    window.addEventListener("envoy:prefill-composer", onPrefill);
    return () => window.removeEventListener("envoy:prefill-composer", onPrefill);
  }, []);

  // Load channel history
  useEffect(() => {
    if (hasLoadedRef.current) return;
    hasLoadedRef.current = true;
    async function loadMessages() {
      try {
        const res = await fetch("/api/channel/messages");
        if (res.ok) {
          const data = await res.json();
          setMessages(data.messages || []);
          if (data.calendarConnected !== undefined) setCalendarConnected(data.calendarConnected);
          if (data.lastCalibratedAt !== undefined) setIsCalibrated(!!data.lastCalibratedAt);
        }
      } catch (e) {
        console.error("Failed to load channel messages:", e);
      } finally {
        setInitialLoading(false);
      }
    }
    loadMessages();
  }, []);

  // ── Calibrated user with onboardReturnTo → bounce immediately ──────────
  // If the user arrived at /dashboard?onboardReturnTo=... but is already
  // calibrated (returning host, no onboarding to run), honor the returnTo
  // instead of showing the dashboard. Proposal §2.3.
  useEffect(() => {
    if (initialLoading || !isCalibrated || !onboardReturnTo) return;
    router.replace(onboardReturnTo);
  }, [initialLoading, isCalibrated, onboardReturnTo, router]);

  // ── Initialize onboarding when uncalibrated ───────────────────────────
  useEffect(() => {
    if (initialLoading || isCalibrated || onboardingInitRef.current) return;
    onboardingInitRef.current = true;

    async function initOnboarding() {
      try {
        // Seed the server with the browser-detected tz so the welcome can
        // assume a reasonable zone before Google Calendar settings are
        // consulted. Server validates + stamps `timezoneSource:"browser-detected"`;
        // invalid values are ignored.
        const browserTz = (() => {
          try {
            return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
          } catch {
            return "";
          }
        })();
        const params = new URLSearchParams();
        if (onboardReturnTo) params.set("hasReturnTo", "1");
        if (browserTz) params.set("browserTz", browserTz);
        const qs = params.toString();
        const url = qs ? `/api/onboarding/chat?${qs}` : "/api/onboarding/chat";
        const res = await fetch(url);
        if (!res.ok) return;
        const data = await res.json();

        if (data.redirect) {
          window.location.href = data.redirect;
          return;
        }

        // If we already loaded persisted onboarding history from the channel,
        // don't re-add the current-phase messages — just sync phase + options.
        // Otherwise we'd duplicate the last turn on every reload.
        const hasPersistedHistory = messages.some(
          (m) => (m.metadata as { kind?: string } | null)?.kind === "onboarding"
        );
        if (hasPersistedHistory) {
          setOnboardingPhase(data.phase);
          setInputPlaceholder(data.placeholder || null);
          const lastMsg = data.messages?.[data.messages.length - 1];
          if (lastMsg?.options?.length > 0) {
            setActiveOptions(lastMsg.options);
            setOptionsLocked(false);
          }
          return;
        }

        processOnboardingResult(data);
      } catch (e) {
        console.error("Failed to initialize onboarding:", e);
      }
    }
    initOnboarding();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialLoading, isCalibrated]);

  // ── Process onboarding API result ─────────────────────────────────────
  const processOnboardingResult = useCallback(
    (data: {
      phase: OnboardingPhase;
      messages: Array<{ content: string; options?: QuickReplyOption[]; delay?: number }>;
      autoAdvance?: boolean;
      onboardingComplete?: boolean;
      placeholder?: string;
    },
    // Belt-and-suspenders gate for the demo auto-draft: only arm the
    // Anderson draft when we arrived at `complete` by advancing from the
    // terminal phase in THIS session — never on a stale re-POST or a GET
    // that lands an already-complete user back on /dashboard. The server
    // already gates `onboardingComplete: true` to the terminal phase
    // advance, so this is defense-in-depth.
    fromPhase?: OnboardingPhase,
    ) => {
      // Onboarding finished — switch to normal chat mode (no reload)
      if (data.onboardingComplete) {
        for (const msg of data.messages) {
          addEnvoyMessage(msg.content);
        }
        setOnboardingPhase(null);
        setInputPlaceholder(null);
        setActiveOptions(null);
        setIsCalibrated(true);

        // onboardReturnTo path: user came in mid-flow (e.g. booking a deal
        // room). Bounce them to the original destination instead of the
        // demo-meeting auto-fire, so they resume the interrupted task.
        if (onboardReturnTo) {
          setTimeout(() => {
            router.replace(onboardReturnTo);
          }, 1200);
          return;
        }

        // Only arm the demo auto-draft if this complete came from advancing
        // the terminal phase (`intro`) in this session. initOnboarding calls
        // this fn with no fromPhase, so a resumed already-complete user
        // never arms the draft. (Post-2026-04-23 the terminal advance is
        // intro→complete; the sunset `defaults_confirm` beat is still
        // accepted as a legacy value for in-flight users.)
        if (fromPhase !== "intro" && fromPhase !== "defaults_confirm") {
          return;
        }

        // Auto-fire a test meeting after a short pause so the user sees the
        // "watch what happens..." message first, then Envoy creates the demo
        // invite in front of their eyes.
        setTimeout(() => {
          // Tone note: phrase this as a concrete, completed-sounding request
          // so the LLM's reply is a short acknowledgement ("Ok, here's the
          // invite I drafted for John — [slot/link]. Let me know any tweaks.")
          // rather than a performative recap of what it's about to do.
          pendingSendRef.current = "Draft a 5-minute meet & greet video call with John Anderson, founder of AgentEnvoy, at my next available time. Keep your reply short — just confirm the draft with the time + link and invite tweaks.";
          setInput(pendingSendRef.current);
        }, 2500);
        return;
      }

      setOnboardingPhase(data.phase);
      setInputPlaceholder(data.placeholder || null);

      // Add envoy messages
      for (const msg of data.messages) {
        addEnvoyMessage(msg.content);
      }

      // Get options from last message (if any)
      const lastMsg = data.messages[data.messages.length - 1];
      if (lastMsg?.options && lastMsg.options.length > 0) {
        setActiveOptions(lastMsg.options);
        setOptionsLocked(false);
      } else {
        setActiveOptions(null);
      }

      // Auto-advance phases: show content, then auto-POST to advance
      if (data.autoAdvance) {
        setActiveOptions(null);
        setTimeout(() => {
          advanceOnboarding(data.phase, "auto");
        }, 2500);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  function addEnvoyMessage(content: string) {
    const msg: ChannelMsg = {
      id: `onboarding-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      role: "envoy",
      content,
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, msg]);
  }

  function addUserMessage(content: string) {
    const msg: ChannelMsg = {
      id: `onboarding-user-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      role: "user",
      content,
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, msg]);
  }

  // ── Advance onboarding ────────────────────────────────────────────────
  async function advanceOnboarding(
    phase: OnboardingPhase,
    response: string,
    extra?: Record<string, unknown>
  ) {
    setLoading(true);
    setOptionsLocked(true);
    try {
      const res = await fetch("/api/onboarding/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phase, response, ...extra }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error || "Failed to advance onboarding");
      }
      const data = await res.json();
      processOnboardingResult(data, phase);
    } catch (e) {
      console.error("Onboarding advance error:", e);
      addEnvoyMessage("Something went wrong. Please try again.");
      setOptionsLocked(false);
    } finally {
      setLoading(false);
    }
  }

  // ── Handle quick reply selection ──────────────────────────────────────
  function handleQuickReply(value: string, label: string) {
    if (optionsLocked || !onboardingPhase) return;
    addUserMessage(label);
    setActiveOptions(null);
    advanceOnboarding(onboardingPhase, value, { responseLabel: label });
  }

  // Auto-send after post-onboarding quick reply sets the input
  useEffect(() => {
    if (pendingSendRef.current && input === pendingSendRef.current) {
      pendingSendRef.current = null;
      handleSend();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input]);

  // Scroll feed container to bottom. On new messages (OR on message-array
  // identity changes — e.g., post-turn refetch that rehydrates `thread` data
  // on the last Envoy message without changing array length), we pin to the
  // bottom (stickToBottomRef). A ResizeObserver on the inner content pins
  // again if async card content (ThreadCard, calendar, images) grows the
  // wrapper. And a short rAF-retry loop pins on every frame for ~300ms after
  // each message change — this is the fallback for late-rendering content
  // that the observer's timing can miss (observer fires after React commit
  // but before final browser paint; scrollHeight read may be stale).
  //
  // Reported 2026-04-21: prior two fixes (#46 adds observer + pb-8, #51
  // instant-scroll) still left ThreadCards clipped under the composer because
  // (a) the post-turn `setMessages` REPLACES the array at the same length, so
  // the length-based scroll trigger didn't fire, and (b) pb-8 (32px) is less
  // than a ThreadCard's full post-hydration height (~80px), so the observer
  // was the only mechanism — and it sometimes missed.
  const prevMessageCount = useRef(0);
  const stickToBottomRef = useRef(true);
  const prevMessagesRef = useRef<ChannelMsg[]>([]);

  useEffect(() => {
    if (messages.length === 0) {
      prevMessageCount.current = 0;
      prevMessagesRef.current = messages;
      return;
    }
    const container = scrollContainerRef.current;
    if (!container) return;

    const lengthGrew = messages.length > prevMessageCount.current;
    const initial = prevMessageCount.current === 0;
    // Array identity check — post-turn refetch replaces the array even when
    // length is stable (e.g., the last Envoy message gets `thread` hydrated).
    // That refetch often produces the biggest layout growth (ThreadCard) and
    // therefore the most clipping risk; detect it here.
    const arrayChanged = messages !== prevMessagesRef.current;

    if (initial || lengthGrew || arrayChanged) {
      stickToBottomRef.current = true;
      // rAF retry loop — pin on every frame for ~300ms. Each tick is idempotent
      // (no-op when scrollTop already equals scrollHeight). Catches async
      // content that renders after the initial pin AND after the observer
      // would have fired.
      const deadline = performance.now() + 300;
      const tick = () => {
        if (!stickToBottomRef.current) return;
        if (!scrollContainerRef.current) return;
        const c = scrollContainerRef.current;
        c.scrollTop = c.scrollHeight;
        if (performance.now() < deadline) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }
    prevMessageCount.current = messages.length;
    prevMessagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    const end = messagesEndRef.current;
    if (!container || !end) return;
    const onScroll = () => {
      // Widened from 24px to 96px (≈ composer height). User scrolled up by
      // less than a composer's worth of pixels (trackpad overshoot, mobile
      // momentum) still counts as "at the bottom, please keep pinning."
      const nearBottom =
        container.scrollHeight - container.scrollTop - container.clientHeight < 96;
      stickToBottomRef.current = nearBottom;
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    const observer = new ResizeObserver(() => {
      if (!stickToBottomRef.current) return;
      container.scrollTop = container.scrollHeight;
    });
    const inner = end.parentElement;
    if (inner) observer.observe(inner);
    return () => {
      container.removeEventListener("scroll", onScroll);
      observer.disconnect();
    };
  }, []);

  // Auto-resize textarea
  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    const el = e.target;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 120) + "px";
  }, []);

  // Open deal room in a new tab so host doesn't lose the dashboard context.
  function navigateToThread(thread: NonNullable<ChannelMsg["thread"]>) {
    const url = thread.link.code
      ? `/meet/${thread.link.slug}/${thread.link.code}`
      : `/meet/${thread.link.slug}`;
    window.open(url, "_blank", "noopener,noreferrer");
  }

  // Archive a thread
  async function handleArchive(sessionId: string) {
    try {
      await fetch("/api/negotiate/archive", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, archived: true }),
      });
      const res = await fetch("/api/channel/messages");
      if (res.ok) {
        const data = await res.json();
        setMessages(data.messages || []);
      }
    } catch (e) {
      console.error("Archive error:", e);
    }
  }

  // Send message
  const handleSend = async (
    overrideText?: string,
    intentHint?: "schedule" | "inquire",
  ) => {
    const text = (overrideText ?? input).trim();
    if (!text || loading) return;
    // Any new turn invalidates previous clarifier quick-replies.
    setClarifierState(null);

    // ── Onboarding freeform input (about_you, protection_blocks, etc.) ──
    // Intro phase is an exception: freetext during the welcome dwell falls
    // through to normal channel chat so a fresh user can type
    // "Book time w/ Danny..." the moment the welcome renders, using the
    // seeded tz, without being blocked by a phase that no longer asks for
    // anything.
    if (isOnboarding && onboardingPhase && onboardingPhase !== "intro") {
      setInput("");
      if (textareaRef.current) textareaRef.current.style.height = "auto";
      addUserMessage(text);
      setActiveOptions(null);
      advanceOnboarding(onboardingPhase, text);
      return;
    }

    // Host directive: :: prefix
    if (text.startsWith("::")) {
      const directive = text.slice(2).trim();
      if (!directive) return;
      setInput("");
      if (textareaRef.current) textareaRef.current.style.height = "auto";
      try {
        await fetch("/api/negotiate/directive", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: directive }),
        });
        setMessages((prev) => [
          ...prev,
          {
            id: `directive-${Date.now()}`,
            role: "system",
            content: `Directive saved: "${directive}"`,
            createdAt: new Date().toISOString(),
          },
        ]);
      } catch {}
      return;
    }

    setInput("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";

    // Optimistic add user message
    const userMsg: ChannelMsg = {
      id: `temp-${Date.now()}`,
      role: "user",
      content: text,
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMsg]);
    setLoading(true);

    try {
      const res = await fetch("/api/channel/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          ...(intentHint ? { userIntentHint: intentHint } : {}),
        }),
      });

      if (!res.ok) {
        let errorMsg = "Failed to send message. Please try again.";
        try {
          const errBody = await res.json();
          if (errBody.error) {
            errorMsg = errBody.retryable
              ? `${errBody.error} — try again in a moment.`
              : errBody.error;
          }
        } catch {}
        throw new Error(errorMsg);
      }

      const contentType = res.headers.get("content-type") || "";

      if (contentType.includes("application/json")) {
        const data = await res.json();
        // Trim trailing whitespace on the main message before concatenating
        // the share note — the LLM often emits messages ending in a newline,
        // and combining that with our literal \n\n separator produces \n\n\n
        // inside a `whitespace-pre-wrap` bubble, which shows as a visible
        // blank line mid-message. Trimming restores a clean single gap.
        const envoyContent = data.shareNote
          ? `${(data.message ?? "").trimEnd()}\n\n${data.shareNote}`
          : data.message;

        const envoyMsg: ChannelMsg = {
          id: `temp-envoy-${Date.now()}`,
          role: "envoy",
          content: envoyContent,
          createdAt: new Date().toISOString(),
        };
        setMessages((prev) => [...prev, envoyMsg]);

        // Reload messages to get the full thread card from the server
        const refreshRes = await fetch("/api/channel/messages");
        if (refreshRes.ok) {
          const refreshData = await refreshRes.json();
          setMessages(refreshData.messages || []);
        }
      } else {
        // JSON-lines stream (application/x-ndjson). Status frames update the
        // inline status row; the terminating text frame renders the final
        // envoy bubble. Proposal: envoy-progress-reasoning-narration
        // (decided 2026-04-21). Minimum 400ms dwell: a status update that
        // would be superseded by the next frame within 400ms is skipped.
        //
        // Duplicate seq is allowed (renders twice, cosmetic only — §2.4 N7).
        // Garbage lines are ignored by the parser; we treat zero frames as
        // a silent success with empty text.
        const MIN_DWELL_MS = 400;
        const parser = new ChannelChatStreamParser();
        let finalText: string | null = null;
        // Wrapped in an object so TS retains narrow typing through closure
        // mutation — a bare `let` reassigned inside handleFrames narrows to
        // `never` at the post-stream check.
        const clarifierBox: {
          value: {
            replies: Array<{ label: string; intent: "schedule" | "inquire" }>;
          } | null;
        } = { value: null };
        let pendingCopy: string | null = null;
        let pendingAt = 0;
        let rafTimer: ReturnType<typeof setTimeout> | null = null;
        const maybeRender = () => {
          const now = Date.now();
          const since = now - pendingAt;
          if (pendingCopy === null) return;
          if (since >= MIN_DWELL_MS) {
            setStatusCopy(pendingCopy);
            pendingCopy = null;
            if (rafTimer) { clearTimeout(rafTimer); rafTimer = null; }
          } else {
            if (rafTimer) clearTimeout(rafTimer);
            rafTimer = setTimeout(() => {
              if (pendingCopy !== null) {
                setStatusCopy(pendingCopy);
                pendingCopy = null;
              }
              rafTimer = null;
            }, MIN_DWELL_MS - since);
          }
        };
        const handleFrames = (frames: ChannelChatFrame[]) => {
          for (const f of frames) {
            if (f.type === "text") {
              finalText = f.content;
              continue;
            }
            if (f.type === "clarifier") {
              finalText = f.text;
              clarifierBox.value = { replies: f.quickReplies };
              continue;
            }
            if (f.type === "reaction") {
              // Patch the optimistic user message with the reaction emoji.
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === userMsg.id
                    ? { ...m, metadata: { ...(m.metadata ?? {}), reaction: f.emoji } }
                    : m,
                ),
              );
              continue;
            }
            // status frame — supersede any pending one; dwell-gate on render.
            if (f.type !== "status") continue;
            pendingCopy = f.copy;
            pendingAt = Date.now();
            maybeRender();
          }
        };

        const reader = res.body?.getReader();
        if (reader) {
          const decoder = new TextDecoder();
          // eslint-disable-next-line no-constant-condition
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value, { stream: true });
            const { frames } = parser.feed(chunk);
            handleFrames(frames);
          }
          const tail = parser.flush();
          handleFrames(tail.frames);
        } else {
          // Body-less response — fall through to empty content.
          const txt = await res.text();
          const { frames } = parser.feed(txt);
          handleFrames(frames);
          const tail = parser.flush();
          handleFrames(tail.frames);
        }

        if (rafTimer) { clearTimeout(rafTimer); rafTimer = null; }
        setStatusCopy(null);

        const content = finalText ?? "";
        const displayContent = content
          .replace(/```agentenvoy-action\s*\n?[\s\S]*?\n?```/g, "")
          .replace(/\s*\[ACTION\].*?\[\/ACTION\]\s*/g, "")
          .trim();

        // Chitchat reactions produce no envoy bubble — finalText is null.
        if (finalText !== null) {
          const envoyMsg: ChannelMsg = {
            id: `temp-envoy-${Date.now()}`,
            role: "envoy",
            content: displayContent || content,
            createdAt: new Date().toISOString(),
          };
          setMessages((prev) => [...prev, envoyMsg]);
        }
        if (clarifierBox.value) {
          setClarifierState({
            originalText: text,
            replies: clarifierBox.value.replies,
          });
        }
        // Single polite announcement at the text-frame boundary (§2.3 N9).
        // Bumping the nonce forces the aria-live region to re-mount (via
        // `key={announcementNonce}`) so screen readers re-announce without
        // the visible text ever changing. Prevents the timestamp-in-text
        // leak that was visible to sighted users in production.
        setAnnouncementNonce((n) => n + 1);

        // Refresh messages to pick up thread cards created during streaming
        const refreshRes = await fetch("/api/channel/messages");
        if (refreshRes.ok) {
          const refreshData = await refreshRes.json();
          setMessages(refreshData.messages || []);
        }
      }
    } catch (e) {
      console.error("Send error:", e);
      const errorContent = e instanceof Error ? e.message : "Failed to send message. Please try again.";
      setMessages((prev) => [
        ...prev,
        {
          id: `error-${Date.now()}`,
          role: "system",
          content: errorContent,
          createdAt: new Date().toISOString(),
        },
      ]);
    } finally {
      setLoading(false);
      setStatusCopy(null);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // Determine placeholder text
  const placeholder = isOnboarding && inputPlaceholder
    ? inputPlaceholder
    : "Tell Envoy what to schedule...";

  if (initialLoading) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex-1 flex items-center justify-center">
          <div className="flex gap-1">
            <div className="w-1.5 h-1.5 rounded-full bg-muted animate-bounce" style={{ animationDelay: "0ms" }} />
            <div className="w-1.5 h-1.5 rounded-full bg-muted animate-bounce" style={{ animationDelay: "150ms" }} />
            <div className="w-1.5 h-1.5 rounded-full bg-muted animate-bounce" style={{ animationDelay: "300ms" }} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Messages — scroll container spans full column width so the scrollbar
          lands at the sidebar divider; inner wrapper re-centers the content. */}
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto min-h-0">
        <div className="max-w-3xl mx-auto w-full min-h-full px-4 sm:px-6 pt-5 pb-16 flex flex-col gap-1.5">
        {/* Scheduling status chip — read-only posture summary pinned at the
            top of the feed for calibrated users. See proposal
            `2026-04-23_primary-link-config-convergence` §3.2 pattern (a). */}
        {isCalibrated && (
          <div className="self-center mb-2 w-full flex flex-col items-center gap-2">
            <SchedulingStatusChip />
            <SchedulingLinksChipList />
          </div>
        )}
        {/* First-run welcome — only for calibrated users with no messages.
            When the user picks the 🔗 primary-link card, we swap the welcome
            cards out for the guided PrimaryLinkFlow in-place. */}
        {messages.length === 0 && !loading && isCalibrated && !primaryLinkFlowActive && (
          <FirstRunWelcome
            onSeed={(seed) => {
              if (seed === "__primary_link_flow__") {
                setPrimaryLinkFlowActive(true);
                return;
              }
              setInput(seed);
              textareaRef.current?.focus();
            }}
          />
        )}
        {messages.length === 0 && !loading && isCalibrated && primaryLinkFlowActive && (
          <PrimaryLinkFlow />
        )}

        {messages.map((msg) => {
          // Thread card — skip archived
          if (msg.threadId && msg.thread) {
            if (msg.thread.archived) return null;

            const isGroup = msg.thread.isGroupEvent || msg.thread.link.mode === "group";
            const guestParticipants = (msg.thread.participants || []).filter((p) => p.role === "guest");

            const status = isGroup && guestParticipants.length > 0
              ? computeGroupThreadStatus(
                  guestParticipants.map((p) => ({ name: p.name || "Unknown", status: p.status })),
                  msg.thread.status
                )
              : computeThreadStatus({
                  status: msg.thread.status,
                  inviteeName: msg.thread.link.inviteeName,
                  guestEmail: msg.thread.link.inviteeEmail,
                });

            const canArchive =
              msg.thread.status === "agreed" ||
              msg.thread.status === "expired" ||
              (msg.thread.agreedTime && new Date(msg.thread.agreedTime) < new Date());

            return (
              <div key={msg.id} className="self-start flex flex-col gap-2 max-w-[85%]">
                {msg.content && (
                  <div className="max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed bg-black/5 dark:bg-white/7 rounded-bl-sm">
                    <div className="text-[10px] font-semibold uppercase tracking-wide mb-1 text-purple-400">Envoy</div>
                    <div className="whitespace-pre-wrap">{renderMarkdown(msg.content)}</div>
                  </div>
                )}
                <ThreadCard
                  title={msg.thread.title || "Thread"}
                  statusLabel={status.label}
                  statusColor={status.color}
                  activityIcon={msg.thread.link.activityIcon || undefined}
                  subtitle={[
                    msg.thread.format === "phone" ? "Phone call" : msg.thread.format === "video" ? "Video" : msg.thread.format,
                    msg.thread.duration ? formatDuration(msg.thread.duration) : null,
                    isGroup ? `${guestParticipants.length} participant${guestParticipants.length !== 1 ? "s" : ""}` : null,
                  ].filter(Boolean).join(" · ") || undefined}
                  inviteeName={msg.thread.link.inviteeName || undefined}
                  inviteeEmail={msg.thread.link.inviteeEmail || undefined}
                  messageCount={msg.thread._count.messages}
                  linkSlug={msg.thread.link.slug}
                  linkCode={msg.thread.link.code || undefined}
                  canArchive={!!canArchive}
                  onArchive={() => handleArchive(msg.thread!.id)}
                  onClick={() => navigateToThread(msg.thread!)}
                  isGroupEvent={isGroup}
                  participants={msg.thread.participants || undefined}
                  isVip={msg.thread.isVip ?? false}
                  guestTimezoneLabel={msg.thread.guestTimezoneLabel || undefined}
                  inviteeCount={
                    Array.isArray(msg.thread.link.inviteeNames) && msg.thread.link.inviteeNames.length > 0
                      ? msg.thread.link.inviteeNames.length
                      : msg.thread.link.inviteeName
                      ? 1
                      : 0
                  }
                />
              </div>
            );
          }

          // System message
          if (msg.role === "system") {
            if (msg.metadata?.kind === "gcal_update_proposal") {
              return (
                <div key={msg.id} className="py-2">
                  <GcalUpdateCard proposal={msg.metadata as unknown as Parameters<typeof GcalUpdateCard>[0]["proposal"]} />
                </div>
              );
            }
            return (
              <div key={msg.id} className="text-center text-xs text-muted py-2">
                {msg.content}
              </div>
            );
          }

          // Chat bubble
          const isUser = msg.role === "user";
          const meetLinkMatch = !isUser ? msg.content.match(/(https?:\/\/[^\s]+\/meet\/[^\s]+)/) : null;
          const reaction = isUser ? (msg.metadata?.reaction as string | undefined) : undefined;
          return (
            <div key={msg.id} className={`relative ${isUser ? "self-end" : "self-start"}`}>
              <div
                className={`max-w-[72%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                  isUser
                    ? "bg-purple-600 text-white rounded-br-sm"
                    : "bg-black/5 dark:bg-white/7 rounded-bl-sm"
                }`}
              >
                <div
                  className={`text-[10px] font-semibold uppercase tracking-wide mb-1 ${
                    isUser ? "text-white/60" : "text-purple-400"
                  }`}
                >
                  {isUser ? "You" : "Envoy"}
                </div>
                <div className="whitespace-pre-wrap">{renderMarkdown(msg.content)}</div>
                {meetLinkMatch && <MeetLinkCard url={meetLinkMatch[1]} />}
              </div>
              {reaction && (
                <div className="absolute -bottom-3 right-2 bg-white dark:bg-zinc-800 border border-black/10 dark:border-white/10 rounded-full px-1.5 py-0.5 text-sm shadow-sm select-none">
                  {reaction}
                </div>
              )}
            </div>
          );
        })}

        {/* Quick replies — below the last envoy message */}
        {activeOptions && activeOptions.length > 0 && (
          <div className="self-start max-w-[72%] mt-1">
            <QuickReplies
              options={activeOptions}
              onSelect={handleQuickReply}
              disabled={optionsLocked || loading}
            />
          </div>
        )}

        {/* Intent-clarifier quick-replies — rendered after an `unclear`-tier
            turn from the chat intent router. Clicking a pill re-submits the
            original utterance with the chosen `userIntentHint`, bypassing
            the classifier. Proposal: 2026-04-21_dashboard-chat-intent-router. */}
        {clarifierState && clarifierState.replies.length > 0 && !loading && (
          <div className="self-start flex flex-wrap gap-2 mt-1">
            {clarifierState.replies.map((reply, i) => (
              <button
                key={i}
                onClick={() => {
                  const { originalText, replies } = clarifierState;
                  const chosen = replies[i];
                  setClarifierState(null);
                  handleSend(originalText, chosen.intent);
                }}
                className="px-3 py-1.5 bg-purple-500/10 hover:bg-purple-500/20 border border-purple-500/30 text-purple-300 text-xs font-medium rounded-full transition"
              >
                {reply.label}
              </button>
            ))}
          </div>
        )}

        {/* Typing indicator + progress narration status row. When the server
            has emitted a status frame, show the copy in place of the spinner.
            aria-live="off" on the visible row (see §2.3 N9) — we announce
            only the terminal "Response ready" via the hidden polite region
            below, to avoid screen-reader queue-drain on JAWS/NVDA/VoiceOver. */}
        {loading && (
          <div
            className="self-start bg-black/5 dark:bg-white/7 rounded-2xl rounded-bl-sm px-4 py-3 flex items-center gap-2"
            aria-live="off"
            role="presentation"
          >
            {statusCopy ? (
              <span className="text-xs italic text-muted">{statusCopy}</span>
            ) : (
              <>
                <div className="w-1.5 h-1.5 rounded-full bg-muted animate-bounce" style={{ animationDelay: "0ms" }} />
                <div className="w-1.5 h-1.5 rounded-full bg-muted animate-bounce" style={{ animationDelay: "150ms" }} />
                <div className="w-1.5 h-1.5 rounded-full bg-muted animate-bounce" style={{ animationDelay: "300ms" }} />
              </>
            )}
          </div>
        )}
        {/* Single polite announcement at the `type:"text"` frame boundary.
            Kept outside the loading row so removal of the row from the
            accessibility tree can't re-read stale status text.

            Remounted via `key={announcementNonce}` on every turn so screen
            readers re-announce the identical "Response ready." text. This
            replaces the earlier pattern of appending Date.now() to the
            announcement text — which leaked the timestamp to sighted users
            in production when sr-only wasn't sufficient to hide the region.
            Now the visible text is always constant; the nonce never touches
            user-visible DOM. Belt-and-suspenders: also using inline styles
            in case a CSS regression ever breaks sr-only.
        */}
        {announcementNonce > 0 && (
          <div
            key={announcementNonce}
            aria-live="polite"
            aria-atomic="true"
            className="sr-only"
            style={{
              position: "absolute",
              width: 1,
              height: 1,
              padding: 0,
              margin: -1,
              overflow: "hidden",
              clip: "rect(0, 0, 0, 0)",
              whiteSpace: "nowrap",
              borderWidth: 0,
            }}
          >
            Response ready.
          </div>
        )}

        <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Input */}
      <div className="px-4 sm:px-6 py-4 border-t border-black/5 dark:border-white/5 flex-shrink-0">
        <div className="max-w-3xl mx-auto w-full">
        {/* Calendar connection prompt — only show for calibrated users without calendar */}
        {!calendarConnected && isCalibrated && (
          <div className="flex items-center gap-3 bg-amber-500/10 border border-amber-500/20 rounded-xl px-4 py-3 mb-3">
            <span className="text-amber-400 text-lg flex-shrink-0">&#128197;</span>
            <div className="flex-1">
              <p className="text-sm text-primary">Connect your Google Calendar</p>
              <p className="text-xs text-muted">Envoy needs access to your schedule to find available times.</p>
            </div>
            <a
              href="/dashboard/account"
              className="px-3 py-1.5 bg-amber-600 hover:bg-amber-500 text-white text-xs font-medium rounded-lg transition flex-shrink-0"
            >
              Connect
            </a>
          </div>
        )}
        <div className="flex gap-2 items-end">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            rows={1}
            className="flex-1 bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl px-4 py-3 text-sm text-primary placeholder-muted resize-none outline-none focus:border-purple-500/50 min-h-[44px] max-h-[120px]"
          />
          <button
            onClick={() => handleSend()}
            disabled={!input.trim() || loading}
            className="w-11 h-11 rounded-xl bg-purple-600 text-white flex items-center justify-center flex-shrink-0 hover:bg-purple-700 transition-colors disabled:opacity-30 disabled:cursor-default text-lg"
          >
            &uarr;
          </button>
        </div>
        <div className="mt-2 flex justify-end">
          <SendFeedbackLink />
        </div>
        </div>
      </div>
    </div>
  );
}
