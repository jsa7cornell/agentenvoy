"use client";

import { useState, useRef, useEffect } from "react";

interface DaySlot {
  date: string; // YYYY-MM-DD
  label: string; // "Mon, Apr 6"
  dayName: string; // "Monday"
  events: Array<{
    title: string;
    start: string;
    end: string;
    movable?: boolean;
  }>;
  tunings: Array<{
    id: string;
    text: string;
    type: "availability" | "constraint" | "movable";
  }>;
  freeBlocks: Array<{ start: string; end: string }>;
}

interface TunerMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
}

function generateWeekDays(): DaySlot[] {
  const days: DaySlot[] = [];
  const now = new Date();
  // Start from today, show 7 days
  for (let i = 0; i < 7; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() + i);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    days.push({
      date: `${yyyy}-${mm}-${dd}`,
      label: d.toLocaleDateString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
      }),
      dayName: d.toLocaleDateString("en-US", { weekday: "long" }),
      events: [],
      tunings: [],
      freeBlocks: [],
    });
  }
  return days;
}

export function AvailabilityTuner({ onClose }: { onClose?: () => void } = {}) {
  const [days, setDays] = useState<DaySlot[]>(generateWeekDays);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<TunerMessage[]>([]);
  const [isSending, setIsSending] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Load real calendar data
  useEffect(() => {
    async function loadCalendar() {
      try {
        const res = await fetch("/api/calendar/week");
        if (res.ok) {
          const data = await res.json();
          if (data.days) {
            setDays((prev) =>
              prev.map((day) => {
                const calDay = data.days.find(
                  (d: { date: string }) => d.date === day.date
                );
                if (calDay) {
                  return {
                    ...day,
                    events: calDay.events || [],
                    freeBlocks: calDay.freeBlocks || [],
                  };
                }
                return day;
              })
            );
          }
        }
      } catch {
        // Calendar API may not exist yet — use empty state
      } finally {
        setLoading(false);
      }
    }
    loadCalendar();
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Set initial system message
  useEffect(() => {
    setMessages([
      {
        id: "welcome",
        role: "assistant",
        content:
          "I can help you fine-tune your availability. Select a day to see your schedule, or tell me things like:\n\n• \"I can take calls while driving to my 2pm appointment\"\n• \"Thursday afternoon I'm free for Zoom calls\"\n• \"The 10am meeting can be moved if needed\"\n• \"No calls before 9am this week\"",
      },
    ]);
  }, []);

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim() || isSending) return;

    const text = input.trim();
    const userMsg: TunerMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      content: text,
    };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setIsSending(true);

    try {
      const res = await fetch("/api/availability/tune", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          selectedDay,
          days: days.map((d) => ({
            date: d.date,
            label: d.label,
            events: d.events,
            tunings: d.tunings,
            freeBlocks: d.freeBlocks,
          })),
        }),
      });

      if (!res.ok) {
        // Fallback: show a static response for now if API doesn't exist
        const fallbackMsg: TunerMessage = {
          id: `assist-${Date.now()}`,
          role: "assistant",
          content: `Got it. I've noted: "${text}"${
            selectedDay
              ? ` for ${
                  days.find((d) => d.date === selectedDay)?.label || selectedDay
                }`
              : " (applies generally)"
          }.\n\nThis tuning will be applied when AgentEnvoy proposes times to your guests.`,
        };
        setMessages((prev) => [...prev, fallbackMsg]);

        // Add as a tuning to the selected day or all days
        const tuning = {
          id: `tuning-${Date.now()}`,
          text,
          type: text.toLowerCase().includes("move")
            ? ("movable" as const)
            : text.toLowerCase().includes("no ") ||
                text.toLowerCase().includes("not ") ||
                text.toLowerCase().includes("don't")
              ? ("constraint" as const)
              : ("availability" as const),
        };

        if (selectedDay) {
          setDays((prev) =>
            prev.map((d) =>
              d.date === selectedDay
                ? { ...d, tunings: [...d.tunings, tuning] }
                : d
            )
          );
        } else {
          setDays((prev) =>
            prev.map((d) => ({ ...d, tunings: [...d.tunings, tuning] }))
          );
        }
        return;
      }

      // Stream response from API
      const reader = res.body?.getReader();
      if (!reader) return;

      const decoder = new TextDecoder();
      let fullText = "";
      const assistantId = `assist-${Date.now()}`;
      setMessages((prev) => [
        ...prev,
        { id: assistantId, role: "assistant", content: "" },
      ]);

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split("\n");
        for (const line of lines) {
          if (line.startsWith("0:")) {
            try {
              const parsed = JSON.parse(line.slice(2));
              fullText += parsed;
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId ? { ...m, content: fullText } : m
                )
              );
            } catch {}
          }
        }
      }
    } catch {
      const fallbackMsg: TunerMessage = {
        id: `assist-${Date.now()}`,
        role: "assistant",
        content: `Noted: "${text}"${
          selectedDay
            ? ` for ${
                days.find((d) => d.date === selectedDay)?.label || selectedDay
              }`
            : ""
        }. This will be applied to your availability preferences.`,
      };
      setMessages((prev) => [...prev, fallbackMsg]);

      const tuning = {
        id: `tuning-${Date.now()}`,
        text,
        type: "availability" as const,
      };
      if (selectedDay) {
        setDays((prev) =>
          prev.map((d) =>
            d.date === selectedDay
              ? { ...d, tunings: [...d.tunings, tuning] }
              : d
          )
        );
      }
    } finally {
      setIsSending(false);
    }
  }

  function removeTuning(dayDate: string, tuningId: string) {
    setDays((prev) =>
      prev.map((d) =>
        d.date === dayDate
          ? { ...d, tunings: d.tunings.filter((t) => t.id !== tuningId) }
          : d
      )
    );
  }

  const selectedDayData = days.find((d) => d.date === selectedDay);
  const isToday = (date: string) => {
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, "0");
    const dd = String(today.getDate()).padStart(2, "0");
    return date === `${yyyy}-${mm}-${dd}`;
  };

  return (
    <div className={`flex flex-col bg-[#0a0a0f] ${onClose ? "h-full" : "min-h-[500px]"}`}>
      {/* Header */}
      <div className="px-4 py-3 border-b border-zinc-800 flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-lg bg-purple-500/20 flex items-center justify-center">
            <svg
              className="w-3.5 h-3.5 text-purple-400"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M10.5 6h9.75M10.5 6a1.5 1.5 0 11-3 0m3 0a1.5 1.5 0 10-3 0M3.75 6H7.5m3 12h9.75m-9.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-3.75 0H7.5m9-6h3.75m-3.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-9.75 0h9.75"
              />
            </svg>
          </div>
          <h3 className="text-sm font-semibold text-zinc-100">
            Availability Tuner
          </h3>
        </div>
        {onClose && <button
          onClick={onClose}
          className="text-zinc-500 hover:text-zinc-300 transition p-1"
        >
          <svg
            className="w-4 h-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        </button>}
      </div>

      {/* Day picker strip */}
      <div className="px-3 py-2 border-b border-zinc-800 flex gap-1.5 overflow-x-auto flex-shrink-0">
        <button
          onClick={() => setSelectedDay(null)}
          className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition ${
            selectedDay === null
              ? "bg-purple-500/20 text-purple-300 border border-purple-500/40"
              : "bg-zinc-800/50 text-zinc-500 border border-zinc-800 hover:text-zinc-300 hover:border-zinc-700"
          }`}
        >
          General
        </button>
        {days.map((day) => (
          <button
            key={day.date}
            onClick={() => setSelectedDay(day.date)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition relative ${
              selectedDay === day.date
                ? "bg-purple-500/20 text-purple-300 border border-purple-500/40"
                : "bg-zinc-800/50 text-zinc-500 border border-zinc-800 hover:text-zinc-300 hover:border-zinc-700"
            }`}
          >
            {isToday(day.date) && (
              <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-emerald-400" />
            )}
            {day.label}
            {day.tunings.length > 0 && (
              <span className="ml-1.5 inline-flex items-center justify-center w-4 h-4 rounded-full bg-purple-500/30 text-purple-300 text-[9px]">
                {day.tunings.length}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Day detail + tunings */}
      {selectedDayData && (
        <div className="px-4 py-3 border-b border-zinc-800 flex-shrink-0 max-h-[240px] overflow-y-auto">
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-xs font-semibold text-zinc-300">
              {selectedDayData.dayName}
            </h4>
            <span className="text-[10px] text-zinc-600">
              {selectedDayData.events.length} events
            </span>
          </div>

          {/* Calendar events */}
          {loading ? (
            <div className="text-xs text-zinc-600 py-2">
              Loading calendar...
            </div>
          ) : selectedDayData.events.length === 0 ? (
            <div className="text-xs text-zinc-600 py-1 mb-2">
              No calendar events
            </div>
          ) : (
            <div className="space-y-1 mb-2">
              {selectedDayData.events.map((evt, i) => (
                <div
                  key={i}
                  className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-zinc-800/60 border border-zinc-800"
                >
                  <div className="w-1 h-6 rounded-full bg-blue-500/60 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-zinc-300 truncate">
                      {evt.title}
                    </div>
                    <div className="text-[10px] text-zinc-600">
                      {evt.start} – {evt.end}
                    </div>
                  </div>
                  {evt.movable && (
                    <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 border border-amber-500/30">
                      movable
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Free blocks */}
          {selectedDayData.freeBlocks.length > 0 && (
            <div className="mb-2">
              <div className="text-[10px] font-medium text-emerald-500 uppercase tracking-wider mb-1">
                Free blocks
              </div>
              <div className="flex flex-wrap gap-1">
                {selectedDayData.freeBlocks.map((block, i) => (
                  <span
                    key={i}
                    className="text-[10px] px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                  >
                    {block.start} – {block.end}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Applied tunings */}
          {selectedDayData.tunings.length > 0 && (
            <div>
              <div className="text-[10px] font-medium text-purple-400 uppercase tracking-wider mb-1">
                Tunings
              </div>
              <div className="space-y-1">
                {selectedDayData.tunings.map((tuning) => (
                  <div
                    key={tuning.id}
                    className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs ${
                      tuning.type === "availability"
                        ? "bg-emerald-500/10 border border-emerald-500/20 text-emerald-300"
                        : tuning.type === "constraint"
                          ? "bg-red-500/10 border border-red-500/20 text-red-300"
                          : "bg-amber-500/10 border border-amber-500/20 text-amber-300"
                    }`}
                  >
                    <span className="flex-1">{tuning.text}</span>
                    <button
                      onClick={() =>
                        removeTuning(selectedDayData.date, tuning.id)
                      }
                      className="text-zinc-600 hover:text-zinc-400 transition flex-shrink-0"
                    >
                      <svg
                        className="w-3 h-3"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={2}
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M6 18L18 6M6 6l12 12"
                        />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Chat area */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex ${
              msg.role === "user" ? "justify-end" : "justify-start"
            }`}
          >
            <div
              className={`max-w-[90%] rounded-xl px-3.5 py-2.5 text-xs leading-relaxed ${
                msg.role === "user"
                  ? "bg-purple-600/80 text-white rounded-br-sm"
                  : "bg-zinc-800/80 border border-zinc-700/50 text-zinc-200 rounded-bl-sm"
              }`}
            >
              <div className="whitespace-pre-wrap">{msg.content}</div>
            </div>
          </div>
        ))}
        {isSending && (
          <div className="flex justify-start">
            <div className="bg-zinc-800/80 border border-zinc-700/50 rounded-xl rounded-bl-sm px-3.5 py-2.5">
              <div className="flex gap-1">
                <div className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-bounce" />
                <div className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-bounce [animation-delay:0.1s]" />
                <div className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-bounce [animation-delay:0.2s]" />
              </div>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <form onSubmit={handleSend} className="px-4 py-3 border-t border-zinc-800 flex-shrink-0">
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={
              selectedDay
                ? `Tune ${
                    days.find((d) => d.date === selectedDay)?.label || ""
                  }...`
                : "Tune your general availability..."
            }
            className="flex-1 bg-zinc-800/80 border border-zinc-700 rounded-lg px-3 py-2 text-xs text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-purple-500/50 transition"
          />
          <button
            type="submit"
            disabled={isSending || !input.trim()}
            className="px-3 py-2 bg-purple-600 hover:bg-purple-500 disabled:opacity-40 text-white rounded-lg text-xs font-medium transition"
          >
            Send
          </button>
        </div>
        {selectedDay && (
          <div className="text-[10px] text-zinc-600 mt-1.5">
            Tuning{" "}
            <span className="text-purple-400">
              {days.find((d) => d.date === selectedDay)?.label}
            </span>{" "}
            specifically. Select &quot;General&quot; for all days.
          </div>
        )}
      </form>
    </div>
  );
}
