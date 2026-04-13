"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { QuickReplies } from "./quick-replies";
import { InlineCalendar } from "./inline-calendar";
import { SimulatedDealRoom } from "./simulated-deal-room";
import { LogoIcon } from "@/components/logo";

/** Render simple markdown: **bold** and line breaks */
function renderMarkdown(text: string) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={i} className="font-semibold">{part.slice(2, -2)}</strong>;
    }
    return <span key={i}>{part}</span>;
  });
}

interface QuickReplyOption {
  number: number;
  label: string;
  value: string;
}

interface EnvoyMessage {
  content: string;
  options?: QuickReplyOption[];
  delay?: number;
}

interface WidgetConfig {
  type: string;
  data: Record<string, unknown>;
}

interface ChatMessage {
  id: string;
  role: "envoy" | "user";
  content: string;
  options?: QuickReplyOption[];
  widget?: WidgetConfig;
  visible: boolean;
}

const TIMEZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Phoenix",
  "America/Anchorage",
  "Pacific/Honolulu",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Asia/Tokyo",
  "Asia/Shanghai",
  "Australia/Sydney",
];

export function OnboardingChat() {
  useSession();
  const router = useRouter();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [currentPhase, setCurrentPhase] = useState<string>("intro");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [freeformInput, setFreeformInput] = useState("");
  const [showTimezonePickerFor, setShowTimezonePickerFor] = useState(false);
  const [showHoursPickerFor, setShowHoursPickerFor] = useState(false);
  const [hoursStart, setHoursStart] = useState(9);
  const [hoursEnd, setHoursEnd] = useState(17);
  // Event answers for batch submission
  const [eventAnswers, setEventAnswers] = useState<Array<{ eventId: string; answer: string }>>([]);
  const [eventIds, setEventIds] = useState<string[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const initRef = useRef(false);

  // Auto-scroll to bottom
  useEffect(() => {
    requestAnimationFrame(() => {
      if (scrollRef.current) {
        scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
      }
    });
  }, [messages]);

  // Load initial state
  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;
    fetch("/api/onboarding/chat")
      .then((r) => r.json())
      .then((data) => {
        if (data.redirect) {
          window.location.href = data.redirect;
          return;
        }
        setCurrentPhase(data.currentPhase || data.phase);
        addEnvoyMessages(data.messages, data.widget);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const addEnvoyMessages = useCallback(
    (envoyMsgs: EnvoyMessage[], widget?: WidgetConfig, ids?: string[]) => {
      if (ids) setEventIds(ids);

      const newMessages: ChatMessage[] = envoyMsgs.map((m, i) => ({
        id: `envoy-${Date.now()}-${i}`,
        role: "envoy" as const,
        content: m.content,
        options: m.options,
        widget: i === 0 && widget ? widget : undefined,
        visible: !m.delay || m.delay === 0,
      }));

      setMessages((prev) => [...prev, ...newMessages]);

      // Reveal delayed messages with typing effect
      newMessages.forEach((msg, i) => {
        const envoyMsg = envoyMsgs[i];
        if (envoyMsg.delay && envoyMsg.delay > 0) {
          setTimeout(() => {
            setMessages((prev) =>
              prev.map((m) => (m.id === msg.id ? { ...m, visible: true } : m))
            );
          }, envoyMsg.delay);
        }
      });
    },
    []
  );

  // Send response to API
  const sendResponse = useCallback(
    async (response: string, extra?: Record<string, unknown>) => {
      if (sending) return;
      setSending(true);

      // Add user message (suppress internal signals)
      if (!response.startsWith("events_complete")) {
        setMessages((prev) => [
          ...prev,
          {
            id: `user-${Date.now()}`,
            role: "user",
            content: response,
            visible: true,
          },
        ]);
      }

      try {
        const body: Record<string, unknown> = {
          phase: currentPhase,
          response,
          ...extra,
        };

        const res = await fetch("/api/onboarding/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

        const data = await res.json();

        if (data.redirect) {
          // Full reload to pick up fresh session (onboardingComplete)
          setTimeout(() => { window.location.href = data.redirect; }, 1500);
        }

        setCurrentPhase(data.phase);
        if (data.messages?.length > 0) {
          addEnvoyMessages(data.messages, data.widget, data.eventIds);
        }

        // Reset event tracking for new events phase
        if (data.phase === "events" && data.eventIds) {
          setEventAnswers([]);
        }

        // Show timezone picker if needed
        if (data.widget?.type === "timezone-picker") {
          setShowTimezonePickerFor(true);
        }
        if (data.widget?.type === "hours-picker") {
          setShowHoursPickerFor(true);
        }
      } catch (e) {
        console.error("Onboarding send error:", e);
      } finally {
        setSending(false);
        setFreeformInput("");
      }
    },
    [sending, currentPhase, router, addEnvoyMessages]
  );

  // Handle quick reply selection
  const handleQuickReply = useCallback(
    (value: string, label: string) => {
      // For events phase, collect answers locally then auto-submit when done
      if (currentPhase === "events") {
        const idx = eventAnswers.length;
        const newAnswers = [...eventAnswers, { eventId: eventIds[idx] || `q${idx}`, answer: value }];
        setEventAnswers(newAnswers);

        // Add user message for this answer
        setMessages((prev) => [
          ...prev,
          { id: `user-${Date.now()}`, role: "user", content: label, visible: true },
        ]);

        // Auto-submit when all questions answered
        if (newAnswers.length >= eventIds.length) {
          // Small delay so the user sees their last answer before transitioning
          setTimeout(() => {
            sendResponse("events_complete", { eventAnswers: newAnswers });
          }, 400);
        }
        return;
      }

      sendResponse(value);
    },
    [currentPhase, eventAnswers, eventIds, sendResponse]
  );

  // Handle freeform text submit
  const handleFreeformSubmit = useCallback(() => {
    const text = freeformInput.trim();
    if (!text || sending) return;
    sendResponse(text);
  }, [freeformInput, sending, sendResponse]);

  // Determine if we need freeform input for this phase
  const needsFreeformInput =
    currentPhase === "protection_blocks" && !sending;

  // Progress indicator
  const phases = [
    "intro",
    "timezone",
    "calendar_reveal",
    "events",
    "protection",
    "format",
    "rules_intro",
    "simulation",
    "complete",
  ];
  const progressIndex = phases.indexOf(
    // Map sub-phases to their parent
    currentPhase === "protection_duration" || currentPhase === "protection_blocks"
      ? "protection"
      : currentPhase === "hours" || currentPhase === "hours_posture"
        ? "protection" // group with protection in progress
        : currentPhase === "simulation_walkthrough"
          ? "simulation"
          : currentPhase
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="flex gap-1">
          <div className="w-2 h-2 rounded-full bg-indigo-400 animate-bounce" style={{ animationDelay: "0ms" }} />
          <div className="w-2 h-2 rounded-full bg-indigo-400 animate-bounce" style={{ animationDelay: "150ms" }} />
          <div className="w-2 h-2 rounded-full bg-indigo-400 animate-bounce" style={{ animationDelay: "300ms" }} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="flex items-center justify-between px-4 sm:px-6 py-3 border-b border-black/5 dark:border-white/5">
        <div className="flex items-center gap-2">
          <LogoIcon size={24} className="text-indigo-400" />
          <span className="text-sm font-semibold text-primary">AgentEnvoy Setup</span>
        </div>
        {/* Progress dots */}
        <div className="flex gap-1.5">
          {phases.map((p, i) => (
            <div
              key={p}
              className={`w-2 h-2 rounded-full transition-colors ${
                i <= progressIndex
                  ? "bg-indigo-500"
                  : "bg-black/10 dark:bg-white/10"
              }`}
            />
          ))}
        </div>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 sm:px-6 py-5 flex flex-col gap-3">
        {messages.map((msg) => {
          if (!msg.visible) {
            // Show typing indicator for delayed messages
            return (
              <div
                key={msg.id}
                className="self-start bg-black/5 dark:bg-white/7 rounded-2xl rounded-bl-sm px-4 py-3 flex items-center gap-1"
              >
                <div className="w-1.5 h-1.5 rounded-full bg-muted animate-bounce" style={{ animationDelay: "0ms" }} />
                <div className="w-1.5 h-1.5 rounded-full bg-muted animate-bounce" style={{ animationDelay: "150ms" }} />
                <div className="w-1.5 h-1.5 rounded-full bg-muted animate-bounce" style={{ animationDelay: "300ms" }} />
              </div>
            );
          }

          if (msg.role === "user") {
            return (
              <div
                key={msg.id}
                className="self-end max-w-[80%] bg-indigo-600 text-white rounded-2xl rounded-br-sm px-4 py-3 text-sm"
              >
                {msg.content}
              </div>
            );
          }

          // Envoy message
          return (
            <div key={msg.id} className="flex flex-col gap-2 max-w-[85%]">
              <div className="self-start bg-black/5 dark:bg-white/7 rounded-2xl rounded-bl-sm px-4 py-3">
                <div className="text-[10px] font-semibold uppercase tracking-wide mb-1 text-indigo-400">
                  Envoy
                </div>
                <div className="text-sm text-primary whitespace-pre-wrap leading-relaxed">
                  {renderMarkdown(msg.content)}
                </div>
              </div>

              {/* Inline widget */}
              {msg.widget?.type === "calendar-reveal" && (
                <div className="ml-0 my-2">
                  <InlineCalendar
                    slots={(msg.widget.data.slots as Array<{ start: string; end: string; score: number }>) || []}
                  />
                </div>
              )}
              {msg.widget?.type === "simulated-deal-room" && (
                <div className="ml-0 my-2">
                  <SimulatedDealRoom data={msg.widget.data} />
                </div>
              )}

              {/* Quick replies */}
              {msg.options && msg.options.length > 0 && (
                <QuickReplies
                  options={msg.options}
                  onSelect={handleQuickReply}
                  disabled={sending}
                />
              )}
            </div>
          );
        })}


        {/* Typing indicator when sending */}
        {sending && (
          <div className="self-start bg-black/5 dark:bg-white/7 rounded-2xl rounded-bl-sm px-4 py-3 flex items-center gap-1">
            <div className="w-1.5 h-1.5 rounded-full bg-muted animate-bounce" style={{ animationDelay: "0ms" }} />
            <div className="w-1.5 h-1.5 rounded-full bg-muted animate-bounce" style={{ animationDelay: "150ms" }} />
            <div className="w-1.5 h-1.5 rounded-full bg-muted animate-bounce" style={{ animationDelay: "300ms" }} />
          </div>
        )}
      </div>

      {/* Timezone picker overlay */}
      {showTimezonePickerFor && (
        <div className="px-4 sm:px-6 py-3 border-t border-black/5 dark:border-white/5">
          <label className="text-xs text-muted block mb-1">Select your timezone:</label>
          <div className="flex gap-2">
            <select
              defaultValue="America/Los_Angeles"
              onChange={(e) => {
                sendResponse(e.target.value, { timezoneValue: e.target.value });
                setShowTimezonePickerFor(false);
              }}
              className="flex-1 bg-surface-secondary border border-DEFAULT rounded-lg px-3 py-2 text-sm text-primary"
            >
              {TIMEZONES.map((tz) => (
                <option key={tz} value={tz}>
                  {tz.replace(/_/g, " ")}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      {/* Hours picker overlay */}
      {showHoursPickerFor && (
        <div className="px-4 sm:px-6 py-3 border-t border-black/5 dark:border-white/5">
          <label className="text-xs text-muted block mb-2">Set your business hours:</label>
          <div className="flex items-center gap-3">
            <select
              value={hoursStart}
              onChange={(e) => setHoursStart(Number(e.target.value))}
              className="bg-surface-secondary border border-DEFAULT rounded-lg px-3 py-2 text-sm text-primary"
            >
              {Array.from({ length: 16 }, (_, i) => i + 5).map((h) => (
                <option key={h} value={h}>
                  {h > 12 ? `${h - 12}pm` : h === 12 ? "12pm" : `${h}am`}
                </option>
              ))}
            </select>
            <span className="text-muted text-sm">to</span>
            <select
              value={hoursEnd}
              onChange={(e) => setHoursEnd(Number(e.target.value))}
              className="bg-surface-secondary border border-DEFAULT rounded-lg px-3 py-2 text-sm text-primary"
            >
              {Array.from({ length: 16 }, (_, i) => i + 5).map((h) => (
                <option key={h} value={h}>
                  {h > 12 ? `${h - 12}pm` : h === 12 ? "12pm" : `${h}am`}
                </option>
              ))}
            </select>
            <button
              onClick={() => {
                sendResponse(`${hoursStart}-${hoursEnd}`);
                setShowHoursPickerFor(false);
              }}
              className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm rounded-lg transition"
            >
              Set
            </button>
          </div>
        </div>
      )}

      {/* Freeform text input (for protection_blocks phase) */}
      {needsFreeformInput && (
        <div className="px-4 sm:px-6 py-3 border-t border-black/5 dark:border-white/5">
          <div className="flex gap-2 items-end">
            <textarea
              ref={inputRef}
              value={freeformInput}
              onChange={(e) => setFreeformInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleFreeformSubmit();
                }
              }}
              placeholder='e.g., "I surf 7-9am weekdays" or "nothing"'
              rows={1}
              className="flex-1 bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl px-4 py-3 text-sm text-primary placeholder-muted resize-none outline-none focus:border-indigo-500/50"
            />
            <button
              onClick={handleFreeformSubmit}
              disabled={!freeformInput.trim() || sending}
              className="w-11 h-11 rounded-xl bg-indigo-600 text-white flex items-center justify-center flex-shrink-0 hover:bg-indigo-500 transition disabled:opacity-30 text-lg"
            >
              &uarr;
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
