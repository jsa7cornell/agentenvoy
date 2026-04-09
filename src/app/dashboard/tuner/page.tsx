"use client";

import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useEffect, useState, useRef, useCallback } from "react";
import { DashboardHeader } from "@/components/dashboard-header";
import { WeeklyCalendar, TunerEvent, TunerSlot } from "@/components/weekly-calendar";

interface ChatMsg {
  id: string;
  role: "user" | "envoy";
  content: string;
}

function getSunday(d: Date): string {
  const date = new Date(d);
  const day = date.getDay(); // 0=Sun, 1=Mon, ...
  date.setDate(date.getDate() - day);
  return date.toISOString().slice(0, 10);
}

function formatWeekRange(weekStart: string): string {
  const start = new Date(weekStart + "T12:00:00");
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  const fmt = (d: Date) =>
    d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${fmt(start)} \u2013 ${fmt(end)}, ${start.getFullYear()}`;
}

export default function TunerPage() {
  const { status } = useSession();
  const router = useRouter();

  const [weekStart, setWeekStart] = useState(() => getSunday(new Date()));
  const [events, setEvents] = useState<TunerEvent[]>([]);
  const [slots, setSlots] = useState<TunerSlot[]>([]);
  const [locationByDay, setLocationByDay] = useState<Record<string, string | null>>({});
  const [timezone, setTimezone] = useState("America/Los_Angeles");
  const [connected, setConnected] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Chat state
  const [chatMessages, setChatMessages] = useState<ChatMsg[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (status === "unauthenticated") router.push("/");
  }, [status, router]);

  // Fetch schedule data
  const fetchSchedule = useCallback(async () => {
    try {
      const res = await fetch(`/api/tuner/schedule?weekStart=${weekStart}`);
      if (!res.ok) return;
      const data = await res.json();
      setEvents(data.events || []);
      setSlots(data.slots || []);
      setLocationByDay(data.locationByDay || {});
      setTimezone(data.timezone || "America/Los_Angeles");
      setConnected(data.connected ?? false);
    } catch (e) {
      console.error("Failed to fetch tuner schedule:", e);
    } finally {
      setIsLoading(false);
    }
  }, [weekStart]);

  useEffect(() => {
    if (status !== "authenticated") return;
    setIsLoading(true);
    fetchSchedule();
  }, [status, fetchSchedule]);

  // Scroll chat on new messages
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatMessages]);

  // Week navigation — up to 4 weeks out
  const thisWeek = getSunday(new Date());
  const maxWeekStart = (() => {
    const d = new Date(thisWeek + "T12:00:00");
    d.setDate(d.getDate() + 21); // 3 weeks ahead (4 total including current)
    return d.toISOString().slice(0, 10);
  })();
  const canGoPrev = weekStart > thisWeek;
  const canGoNext = weekStart < maxWeekStart;

  function shiftWeek(dir: number) {
    const d = new Date(weekStart + "T12:00:00");
    d.setDate(d.getDate() + 7 * dir);
    const next = d.toISOString().slice(0, 10);
    if (dir < 0 && next < thisWeek) return;
    if (dir > 0 && next > maxWeekStart) return;
    setWeekStart(next);
  }

  // Force refresh
  async function handleRefresh() {
    setIsRefreshing(true);
    try {
      await fetch("/api/debug/force-resync", { method: "POST" });
      await fetchSchedule();
    } catch (e) {
      console.error("Refresh failed:", e);
    } finally {
      setIsRefreshing(false);
    }
  }

  // Chat send
  async function handleChatSend() {
    const text = chatInput.trim();
    if (!text || isSending) return;

    const userMsg: ChatMsg = {
      id: `u-${Date.now()}`,
      role: "user",
      content: text,
    };
    setChatMessages((prev) => [...prev, userMsg]);
    setChatInput("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    setIsSending(true);

    try {
      const res = await fetch("/api/tuner/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, weekStart }),
      });

      if (!res.ok) {
        let errorMsg = "Failed to send. Try again.";
        try {
          const errBody = await res.json();
          if (errBody.error) errorMsg = errBody.error;
        } catch {}
        throw new Error(errorMsg);
      }

      const data = await res.json();
      const envoyMsg: ChatMsg = {
        id: `e-${Date.now()}`,
        role: "envoy",
        content: data.message || "Done.",
      };
      setChatMessages((prev) => [...prev, envoyMsg]);

      // If Envoy executed an action (update_knowledge), refresh the calendar
      if (data.actionExecuted) {
        await fetchSchedule();
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : "Something went wrong.";
      setChatMessages((prev) => [
        ...prev,
        { id: `err-${Date.now()}`, role: "envoy", content: errMsg },
      ]);
    } finally {
      setIsSending(false);
    }
  }

  // Click-to-ask from calendar
  function handleSlotClick(label: string) {
    setChatInput(label);
    textareaRef.current?.focus();
  }

  // Auto-resize textarea
  function handleInputChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setChatInput(e.target.value);
    const el = e.target;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 120) + "px";
  }

  if (status === "loading" || isLoading) {
    return (
      <div className="min-h-screen bg-[#0a0a0f] flex items-center justify-center">
        <div className="text-zinc-500">Loading...</div>
      </div>
    );
  }

  return (
    <div className="h-screen bg-[#0a0a0f] flex flex-col overflow-hidden">
      <DashboardHeader />

      {/* Week navigation bar */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800 shrink-0">
        <div className="flex items-center gap-3">
          <h1 className="text-sm font-semibold text-zinc-200">Availability Tuner</h1>
          <div className="flex items-center gap-1">
            <button
              onClick={() => shiftWeek(-1)}
              disabled={!canGoPrev}
              className="px-2 py-1 text-xs text-zinc-400 hover:text-zinc-200 disabled:opacity-30 disabled:cursor-not-allowed transition"
            >
              &larr;
            </button>
            <span className="text-sm text-zinc-300 min-w-[160px] text-center">
              {formatWeekRange(weekStart)}
            </span>
            <button
              onClick={() => shiftWeek(1)}
              disabled={!canGoNext}
              className="px-2 py-1 text-xs text-zinc-400 hover:text-zinc-200 disabled:opacity-30 disabled:cursor-not-allowed transition"
            >
              &rarr;
            </button>
          </div>
          {weekStart !== thisWeek && (
            <button
              onClick={() => setWeekStart(thisWeek)}
              className="text-xs text-zinc-500 hover:text-zinc-300 underline transition"
            >
              This week
            </button>
          )}
        </div>
        <button
          onClick={handleRefresh}
          disabled={isRefreshing}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 border border-zinc-700 rounded-lg hover:border-zinc-600 disabled:opacity-50 transition"
        >
          <svg
            className={`w-3.5 h-3.5 ${isRefreshing ? "animate-spin" : ""}`}
            fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          {isRefreshing ? "Syncing..." : "Refresh"}
        </button>
      </div>

      {!connected ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center text-zinc-500">
            <p className="text-sm">Calendar not connected.</p>
            <p className="text-xs mt-1">Connect Google Calendar from your profile to use the tuner.</p>
          </div>
        </div>
      ) : (
        <div className="flex-1 flex overflow-hidden">
          {/* Chat panel — left side */}
          <div className="w-80 flex-shrink-0 border-r border-zinc-800 flex flex-col">
            {/* Chat messages */}
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {chatMessages.length === 0 && (
                <div className="text-center text-zinc-600 text-xs py-8">
                  Ask Envoy about your availability. Click any time slot to ask about it.
                </div>
              )}
              {chatMessages.map((msg) => (
                <div
                  key={msg.id}
                  className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
                >
                  <div
                    className={`max-w-[90%] rounded-2xl px-3 py-2.5 text-sm leading-relaxed ${
                      msg.role === "user"
                        ? "bg-indigo-600 text-white rounded-br-sm"
                        : "bg-zinc-800 border border-zinc-700 text-zinc-100 rounded-bl-sm"
                    }`}
                  >
                    {msg.role === "envoy" && (
                      <div className="text-[10px] font-bold uppercase tracking-wider text-emerald-400 mb-1">
                        Envoy
                      </div>
                    )}
                    <div className="whitespace-pre-wrap">{msg.content}</div>
                  </div>
                </div>
              ))}
              {isSending && chatMessages[chatMessages.length - 1]?.role === "user" && (
                <div className="flex justify-start">
                  <div className="bg-zinc-800 border border-zinc-700 rounded-2xl rounded-bl-sm px-3 py-2.5">
                    <div className="text-[10px] font-bold uppercase tracking-wider text-emerald-400 mb-1">
                      Envoy
                    </div>
                    <div className="flex gap-1">
                      <div className="w-2 h-2 rounded-full bg-zinc-500 animate-bounce" />
                      <div className="w-2 h-2 rounded-full bg-zinc-500 animate-bounce [animation-delay:0.1s]" />
                      <div className="w-2 h-2 rounded-full bg-zinc-500 animate-bounce [animation-delay:0.2s]" />
                    </div>
                  </div>
                </div>
              )}
              <div ref={chatEndRef} />
            </div>

            {/* Chat input */}
            <div className="p-3 border-t border-zinc-800 shrink-0">
              <div className="flex gap-2">
                <textarea
                  ref={textareaRef}
                  value={chatInput}
                  onChange={handleInputChange}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      handleChatSend();
                    }
                  }}
                  placeholder="Ask about your availability..."
                  rows={1}
                  className="flex-1 resize-none bg-zinc-800 border border-zinc-700 rounded-xl px-3 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-indigo-500 transition"
                />
                <button
                  onClick={handleChatSend}
                  disabled={isSending || !chatInput.trim()}
                  className="px-3 py-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:hover:bg-indigo-600 text-white rounded-xl text-sm font-medium transition"
                >
                  Send
                </button>
              </div>
            </div>
          </div>

          {/* Weekly calendar — right side, takes remaining space */}
          <div className="flex-1 min-w-0 overflow-hidden">
            <WeeklyCalendar
              events={events}
              slots={slots}
              locationByDay={locationByDay}
              timezone={timezone}
              weekStart={weekStart}
              onSlotClick={handleSlotClick}
            />
          </div>
        </div>
      )}
    </div>
  );
}
