"use client";

import { useState, useRef, useEffect } from "react";
import { LogoFull } from "./logo";
import { AvailabilityCalendar } from "./availability-calendar";
import Link from "next/link";

interface Message {
  id: string;
  role: string;
  content: string;
  createdAt?: string;
}

interface DealRoomProps {
  slug: string;
  code?: string;
}

// --- Icons (inline SVG) ---

function ChatIcon({ className = "" }: { className?: string }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function ClockIcon({ className = "" }: { className?: string }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

export function DealRoom({ slug, code }: DealRoomProps) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSending, setIsSending] = useState(false);
  const [hostName, setHostName] = useState("");
  const [isHost, setIsHost] = useState(false);
  const [topic, setTopic] = useState("");
  const [linkFormat, setLinkFormat] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [archivedData, setArchivedData] = useState<{ hostEmail: string | null; hostName: string | null } | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [confirmData, setConfirmData] = useState<Record<string, unknown> | null>(null);
  const [isConfirming, setIsConfirming] = useState(false);
  const [calendarConnected, setCalendarConnected] = useState(false);
  const [showAgentInfo, setShowAgentInfo] = useState(false);
  // Feedback state reserved for future use
  // const [feedbackText, setFeedbackText] = useState("");
  // const [feedbackSent, setFeedbackSent] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Slots state for calendar widget
  const [slotsByDay, setSlotsByDay] = useState<Record<string, Array<{ start: string; end: string }>> | null>(null);
  const [slotTimezone, setSlotTimezone] = useState("America/New_York");

  // Mobile tab state
  const [mobileTab, setMobileTab] = useState<"chat" | "details">("chat");

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Fetch slots when session is ready
  useEffect(() => {
    if (!sessionId) return;
    fetch(`/api/negotiate/slots?sessionId=${sessionId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data) {
          setSlotsByDay(data.slotsByDay);
          setSlotTimezone(data.timezone);
        }
      })
      .catch(() => {});
  }, [sessionId]);

  function parseConfirmationProposal(content: string): {
    text: string;
    proposal: { dateTime: string; duration: number; format: string; location: string | null; timezone?: string } | null;
  } {
    const match = content.match(
      /\[CONFIRMATION_PROPOSAL\]([^\[]*)\[\/CONFIRMATION_PROPOSAL\]/
    );
    if (!match) return { text: content, proposal: null };
    try {
      const proposal = JSON.parse(match[1]);
      const text = content.replace(
        /\[CONFIRMATION_PROPOSAL\][^\[]*\[\/CONFIRMATION_PROPOSAL\]/,
        ""
      ).trim();
      return { text, proposal };
    } catch {
      return { text: content, proposal: null };
    }
  }

  async function handleConfirm(proposal: {
    dateTime: string;
    duration: number;
    format: string;
    location: string | null;
    timezone?: string;
  }) {
    if (!sessionId || isConfirming) return;
    setIsConfirming(true);
    try {
      const res = await fetch("/api/negotiate/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          dateTime: proposal.dateTime,
          duration: proposal.duration,
          format: proposal.format,
          location: proposal.location,
          timezone: proposal.timezone,
        }),
      });
      if (!res.ok) throw new Error("Failed to confirm");
      const data = await res.json();
      setConfirmData(data);
      setConfirmed(true);
    } catch (error) {
      console.error("Confirm error:", error);
    } finally {
      setIsConfirming(false);
    }
  }

  function handleConnectCalendar() {
    const returnUrl = code ? `/meet/${slug}/${code}` : `/meet/${slug}`;
    window.location.href = `/api/auth/guest-calendar?sessionId=${sessionId}&returnUrl=${encodeURIComponent(returnUrl)}`;
  }

  function handleConnectAgent() {
    setShowAgentInfo((prev) => !prev);
  }

  // Detect guest calendar connect via URL param
  const calendarCheckDone = useRef(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("calendarConnected") === "true" && sessionId && !calendarConnected && !calendarCheckDone.current) {
      calendarCheckDone.current = true;
      setCalendarConnected(true);
      const url = new URL(window.location.href);
      url.searchParams.delete("calendarConnected");
      window.history.replaceState({}, "", url.pathname);
      fetch("/api/negotiate/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          content: "[SYSTEM: The guest connected their Google Calendar (read-only). Their availability has been added to the session. Cross-reference both calendars to propose optimal mutual times.]",
        }),
      }).then(async (res) => {
        if (!res.ok) return;
        const reader = res.body?.getReader();
        if (!reader) return;
        const decoder = new TextDecoder();
        let fullText = "";
        const assistantId = (Date.now() + 1).toString();
        setMessages((prev) => [
          ...prev,
          { id: assistantId, role: "administrator", content: "" },
        ]);
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          const lines = chunk.split("\n");
          for (const line of lines) {
            if (line.startsWith("0:")) {
              try {
                const text = JSON.parse(line.slice(2));
                fullText += text;
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === assistantId ? { ...m, content: fullText } : m
                  )
                );
              } catch {}
            }
          }
        }
      }).catch(() => {});
    }
  }, [sessionId, calendarConnected, slug, code]);

  // Initialize session on mount
  useEffect(() => {
    async function initSession() {
      try {
        const res = await fetch("/api/negotiate/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slug, code }),
        });

        if (!res.ok) {
          const data = await res.json();
          if (data.error === "archived") {
            setArchivedData({ hostEmail: data.hostEmail, hostName: data.hostName });
            setIsLoading(false);
            return;
          }
          setError(data.error || "Failed to start session");
          setIsLoading(false);
          return;
        }

        const data = await res.json();
        setSessionId(data.sessionId);
        setHostName(data.host?.name || data.hostName || "");
        setIsHost(data.isHost || false);
        setTopic(data.link?.topic || "");
        setLinkFormat(data.link?.format || "");

        // Already confirmed — load messages AND set confirmed state
        if (data.confirmed) {
          setConfirmData({
            dateTime: data.agreedTime,
            duration: data.duration || 30,
            format: data.agreedFormat || "phone",
            meetLink: data.meetLink,
          });
          setConfirmed(true);
          // Load message history so chat is visible below the event card
          if (data.messages?.length > 0) {
            setMessages(
              data.messages.map((m: { id: string; role: string; content: string; createdAt?: string }) => ({
                id: m.id,
                role: m.role,
                content: m.content,
                createdAt: m.createdAt,
              }))
            );
          }
          return;
        }

        // If resuming an existing session, load full message history
        if (data.resumed && data.messages?.length > 0) {
          setMessages(
            data.messages.map((m: { id: string; role: string; content: string; createdAt?: string }) => ({
              id: m.id,
              role: m.role,
              content: m.content,
              createdAt: m.createdAt,
            }))
          );
        } else {
          setMessages([
            {
              id: "greeting",
              role: "administrator",
              content: data.greeting,
            },
          ]);
        }
      } catch {
        setError("Failed to connect. Please try again.");
      } finally {
        setIsLoading(false);
      }
    }

    initSession();
  }, [slug, code]);

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim() || isSending || !sessionId) return;

    const text = input.trim();

    // Host directive: :: prefix (host only)
    if (isHost && text.startsWith("::")) {
      const directive = text.slice(2).trim();
      if (!directive) return;
      setInput("");
      try {
        await fetch("/api/negotiate/directive", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: directive, sessionId }),
        });
        const directiveMsg: Message = {
          id: `directive-${Date.now()}`,
          role: "host_note",
          content: directive,
        };
        setMessages((prev) => [...prev, directiveMsg]);
      } catch {}
      return;
    }

    const messageRole = isHost ? "host" : "guest";
    const userMsg: Message = {
      id: Date.now().toString(),
      role: messageRole,
      content: text,
    };

    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setIsSending(true);

    try {
      const res = await fetch("/api/negotiate/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          content: userMsg.content,
        }),
      });

      if (!res.ok) throw new Error("Failed to send");

      const contentType = res.headers.get("content-type") || "";

      // Host messages return JSON (no agent response)
      if (contentType.includes("application/json")) {
        // No agent response for host messages — message already displayed optimistically
        setIsSending(false);
        return;
      }

      // Guest messages get a streaming agent response
      const reader = res.body?.getReader();
      if (!reader) throw new Error("No reader");

      const assistantId = (Date.now() + 1).toString();
      setMessages((prev) => [
        ...prev,
        { id: assistantId, role: "administrator", content: "" },
      ]);

      const decoder = new TextDecoder();
      let fullText = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split("\n");

        for (const line of lines) {
          if (line.startsWith("0:")) {
            try {
              const text = JSON.parse(line.slice(2));
              fullText += text;
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId ? { ...m, content: fullText } : m
                )
              );
            } catch {}
          }
        }
      }
    } catch (error) {
      console.error("Send error:", error);
    } finally {
      setIsSending(false);
    }
  }

  // --- Contextual event title ---
  function getEventTitle() {
    if (topic && hostName) return `${topic} with ${hostName}`;
    if (linkFormat === "phone" && hostName) return `Call with ${hostName}`;
    if (hostName) return `Meet with ${hostName}`;
    return "Meeting";
  }

  // --- Archived state ---
  if (archivedData) {
    return (
      <div className="min-h-screen bg-[#0a0a0f] flex items-center justify-center">
        <div className="text-center max-w-md">
          <div className="w-16 h-16 mx-auto mb-5 rounded-full bg-zinc-800 border border-zinc-700 flex items-center justify-center">
            <svg className="w-7 h-7 text-zinc-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5m8.25 3v6.75m0 0l-3-3m3 3l3-3M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z" />
            </svg>
          </div>
          <h1 className="text-xl font-bold text-zinc-100 mb-2">Meeting Archived</h1>
          <p className="text-sm text-zinc-500 mb-4">
            This meeting has been archived by {archivedData.hostName || "the host"}.
          </p>
          {archivedData.hostEmail && (
            <p className="text-sm text-zinc-400">
              Contact{" "}
              <a href={`mailto:${archivedData.hostEmail}`} className="text-indigo-400 hover:text-indigo-300">
                {archivedData.hostEmail}
              </a>{" "}
              if you need to reconnect.
            </p>
          )}
        </div>
      </div>
    );
  }

  // --- Error state ---
  if (error) {
    return (
      <div className="min-h-screen bg-[#0a0a0f] flex items-center justify-center">
        <div className="text-center">
          <div className="text-4xl mb-4">&#128533;</div>
          <h1 className="text-xl font-bold text-zinc-100 mb-2">Link not found</h1>
          <p className="text-zinc-500">{error}</p>
        </div>
      </div>
    );
  }

  // --- ICS download helper ---
  function downloadIcs() {
    if (!confirmData) return;
    const dt = new Date(confirmData.dateTime as string);
    const end = new Date(dt.getTime() + (Number(confirmData.duration) || 30) * 60000);
    const fmt = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      `DTSTART:${fmt(dt)}`,
      `DTEND:${fmt(end)}`,
      `SUMMARY:${getEventTitle()}`,
      confirmData.meetLink ? `URL:${confirmData.meetLink}` : "",
      confirmData.location ? `LOCATION:${confirmData.location}` : "",
      "END:VEVENT",
      "END:VCALENDAR",
    ].filter(Boolean).join("\r\n");
    const blob = new Blob([ics], { type: "text/calendar" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "meeting.ics";
    a.click();
    URL.revokeObjectURL(url);
  }

  // --- Confirmed event banner (renders inside chat, not as separate page) ---
  const confirmedBanner = confirmed && confirmData ? (
    <div className="mx-3 sm:mx-4 mt-3 mb-1 p-3 sm:p-4 bg-gradient-to-br from-emerald-500/8 to-emerald-500/3 border border-emerald-500/25 rounded-xl flex-shrink-0">
      {/* Row 1: Status + Title */}
      <div className="flex items-center gap-2 mb-2">
        <div className="w-6 h-6 rounded-full bg-gradient-to-br from-emerald-400 to-emerald-500 flex items-center justify-center text-xs text-white flex-shrink-0">&#10003;</div>
        <span className="text-sm font-semibold text-emerald-400">Confirmed</span>
      </div>
      {/* Row 2: Meeting title + format */}
      <div className="mb-2">
        <div className="text-sm font-medium text-zinc-100">{getEventTitle()}</div>
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1 text-xs text-zinc-400">
          <span>&#128197; {new Date(confirmData.dateTime as string).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}</span>
          <span>&#128336; {new Date(confirmData.dateTime as string).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZoneName: "short" })}</span>
          <span>{String(confirmData.format) === "phone" ? "&#128222;" : String(confirmData.format) === "video" ? "&#127909;" : "&#128205;"} {String(confirmData.format).charAt(0).toUpperCase() + String(confirmData.format).slice(1)} &middot; {String(confirmData.duration)} min</span>
        </div>
      </div>
      {/* Sub-info: meet link, location */}
      {typeof confirmData.meetLink === "string" && (
        <a href={confirmData.meetLink as string} className="text-xs text-indigo-400 hover:text-indigo-300 block mb-2" target="_blank" rel="noopener noreferrer">
          {(confirmData.meetLink as string).replace("https://", "")} &rarr;
        </a>
      )}
      {typeof confirmData.location === "string" && confirmData.location && (
        <div className="text-xs text-zinc-500 mb-2">&#128205; {confirmData.location as string}</div>
      )}
      {/* Actions */}
      <div className="flex flex-wrap gap-2">
        {typeof confirmData.eventLink === "string" && (
          <a href={confirmData.eventLink as string} target="_blank" rel="noopener noreferrer" className="px-2.5 py-1 text-[10px] font-medium rounded-lg bg-emerald-900/40 text-emerald-300 border border-emerald-500/20 hover:border-emerald-500/40 transition">
            &#128197; Add to Google
          </a>
        )}
        <button onClick={downloadIcs} className="px-2.5 py-1 text-[10px] font-medium rounded-lg bg-zinc-800 text-zinc-400 border border-zinc-700 hover:border-zinc-600 transition">
          &#128229; Download .ics
        </button>
        <button
          onClick={() => {
            setInput("I need to change this meeting — ");
            document.querySelector<HTMLTextAreaElement>("textarea")?.focus();
          }}
          className="px-2.5 py-1 text-[10px] font-medium rounded-lg bg-zinc-800 text-zinc-400 border border-zinc-700 hover:border-zinc-600 transition"
        >
          Change event
        </button>
      </div>
    </div>
  ) : null;

  // --- Sidebar content (shared between desktop sidebar and mobile Details tab) ---
  const sidebarContent = (
    <div className="space-y-5">
      {/* Event title */}
      <div>
        <h2 className="text-base font-semibold text-zinc-100">{getEventTitle()}</h2>
        <p className="text-xs text-zinc-500 mt-0.5">
          {linkFormat === "phone" ? "Phone call" : linkFormat === "video" ? "Video call" : linkFormat === "in-person" ? "In person" : "Meeting"}
          {" \u00B7 30 min"}
        </p>
      </div>

      {/* Connections — only show for guests */}
      {!isHost && (
        <div>
          <h4 className="text-[10px] font-bold uppercase tracking-widest text-zinc-500 mb-2">
            Connections
          </h4>
          <div className="space-y-2">
            <button
              onClick={handleConnectAgent}
              className="w-full text-left bg-zinc-900 border border-zinc-800 rounded-xl p-3 hover:border-indigo-500/50 transition group"
            >
              <div className="text-sm font-medium text-zinc-300 group-hover:text-indigo-300 transition">
                Connect your agent
              </div>
              <p className="text-xs text-zinc-600 mt-0.5">Details coming soon!</p>
            </button>

            {showAgentInfo && (
              <div className="bg-zinc-900 border border-zinc-700 rounded-xl p-3 text-xs text-zinc-400 space-y-2">
                <p className="font-medium text-zinc-200">Agent API</p>
                <p>Your agent can negotiate on your behalf via the AgentEnvoy API.</p>
                <code className="block bg-zinc-800 rounded p-2 text-emerald-400 text-[11px] break-all">
                  POST /api/negotiate/message
                </code>
                <a href="https://agentenvoy.ai" className="text-indigo-400 hover:text-indigo-300 text-xs">
                  Sign up for API access
                </a>
              </div>
            )}

            {calendarConnected ? (
              <div className="w-full bg-emerald-900/20 border border-emerald-700/50 rounded-xl p-3">
                <div className="text-sm font-medium text-emerald-300">Calendar connected</div>
                <p className="text-xs text-zinc-500 mt-1">Your availability is being shared</p>
              </div>
            ) : (
              <button
                onClick={handleConnectCalendar}
                disabled={!sessionId}
                className="w-full text-left bg-zinc-900 border border-zinc-800 rounded-xl p-3 hover:border-indigo-500/50 transition group disabled:opacity-50"
              >
                <div className="text-sm font-medium text-indigo-400 group-hover:text-indigo-300 transition">
                  Connect Calendar
                </div>
                <p className="text-xs text-zinc-600 mt-0.5">Let AgentEnvoy find the best match!</p>
              </button>
            )}
          </div>
        </div>
      )}

      {/* Availability calendar */}
      <div>
        <h4 className="text-[10px] font-bold uppercase tracking-widest text-zinc-500 mb-2">
          Availability
        </h4>
        <AvailabilityCalendar
          slotsByDay={slotsByDay || {}}
          timezone={slotTimezone}
        />
      </div>
    </div>
  );

  // --- Chat content (shared between desktop and mobile Chat tab) ---
  const chatContent = (
    <>
      {confirmedBanner}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {isLoading ? (
          <div className="flex justify-center py-12">
            <div className="flex gap-1">
              <div className="w-2 h-2 rounded-full bg-zinc-500 animate-bounce" />
              <div className="w-2 h-2 rounded-full bg-zinc-500 animate-bounce [animation-delay:0.1s]" />
              <div className="w-2 h-2 rounded-full bg-zinc-500 animate-bounce [animation-delay:0.2s]" />
            </div>
          </div>
        ) : (
          messages.map((msg) => {
            // Host notes — only visible to host
            if (msg.role === "host_note") {
              if (!isHost) return null;
              return (
                <div key={msg.id} className="flex justify-end">
                  <div className="max-w-[70%] rounded-lg px-3 py-1.5 text-xs bg-amber-900/30 border border-amber-700/40 text-amber-300">
                    <span className="font-semibold uppercase tracking-wider text-[9px] text-amber-500 mr-1.5">Note</span>
                    {msg.content}
                  </div>
                </div>
              );
            }

            const { text, proposal } =
              msg.role === "administrator"
                ? parseConfirmationProposal(msg.content)
                : { text: msg.content, proposal: null };

            // Determine alignment and styling
            const isOwnMessage =
              (isHost && msg.role === "host") ||
              (!isHost && msg.role === "guest");

            const messageStyle =
              msg.role === "host"
                ? "bg-purple-600 text-white rounded-br-sm"
                : msg.role === "guest"
                  ? "bg-indigo-600 text-white rounded-br-sm"
                  : msg.role === "system"
                    ? "bg-emerald-900/30 border border-emerald-800 text-emerald-200 rounded-lg"
                    : "bg-zinc-800 border border-zinc-700 text-zinc-100 rounded-bl-sm";

            const senderLabel =
              msg.role === "host"
                ? hostName || "Host"
                : msg.role === "guest"
                  ? "Guest"
                  : msg.role === "administrator"
                    ? "Envoy"
                    : null;

            const labelColor =
              msg.role === "host"
                ? "text-white/60"
                : msg.role === "guest"
                  ? "text-white/60"
                  : "text-emerald-400";

            return (
              <div key={msg.id}>
                <div className={`flex ${isOwnMessage ? "justify-end" : "justify-start"}`}>
                  <div className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${messageStyle}`}>
                    {senderLabel && (
                      <div className={`text-[10px] font-bold uppercase tracking-wider mb-1 ${labelColor}`}>
                        {senderLabel}
                      </div>
                    )}
                    <div className="whitespace-pre-wrap">{text}</div>
                  </div>
                </div>

                {proposal && !confirmed && (
                  <div className="flex justify-start mt-2">
                    <div className="max-w-[85%] bg-emerald-900/20 border border-emerald-700/50 rounded-xl p-4 space-y-3">
                      <div className="text-[10px] font-bold uppercase tracking-wider text-emerald-400">Proposed meeting</div>
                      <div className="space-y-1 text-sm text-zinc-300">
                        <p>&#128197; {new Date(proposal.dateTime).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}</p>
                        <p>&#128336; {new Date(proposal.dateTime).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })} ({proposal.duration} min)</p>
                        <p>&#128241; {proposal.format.charAt(0).toUpperCase() + proposal.format.slice(1)}</p>
                        {proposal.location && <p>&#128205; {proposal.location}</p>}
                      </div>
                      <button
                        onClick={() => handleConfirm(proposal)}
                        disabled={isConfirming}
                        className="w-full mt-2 px-4 py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition"
                      >
                        {isConfirming ? "Confirming..." : "Confirm this time"}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
        {isSending && (
          <div className="flex justify-start">
            <div className="bg-zinc-800 border border-zinc-700 rounded-2xl rounded-bl-sm px-4 py-3">
              <div className="text-[10px] font-bold uppercase tracking-wider text-emerald-400 mb-1">Envoy</div>
              <div className="flex gap-1">
                <div className="w-2 h-2 rounded-full bg-zinc-500 animate-bounce" />
                <div className="w-2 h-2 rounded-full bg-zinc-500 animate-bounce [animation-delay:0.1s]" />
                <div className="w-2 h-2 rounded-full bg-zinc-500 animate-bounce [animation-delay:0.2s]" />
              </div>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <form onSubmit={handleSend} className="p-4 border-t border-zinc-800">
        <div className="flex gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSend(e);
              }
            }}
            placeholder={isHost ? `Message as ${hostName || "Host"}...` : "Type your message..."}
            rows={1}
            disabled={isLoading}
            className="flex-1 resize-none bg-zinc-800 border border-zinc-700 rounded-xl px-4 py-3 text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-indigo-500 transition disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={isSending || !input.trim() || isLoading}
            className="px-4 py-3 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-xl text-sm font-medium transition"
          >
            Send
          </button>
        </div>
        {isHost && (
          <p className="text-[10px] text-zinc-600 mt-1.5">
            Prefix with <code className="text-zinc-500">::</code> for private notes to Envoy
          </p>
        )}
      </form>
    </>
  );

  return (
    <div className="min-h-screen bg-[#0a0a0f] text-zinc-100 flex flex-col">
      {/* Prototype banner */}
      <div className="bg-amber-900/30 border-b border-amber-700/40 px-4 py-1.5 text-center">
        <span className="text-xs text-amber-300">
          Prototype — email and other features still in development
        </span>
      </div>

      {/* Header */}
      <header className="border-b border-zinc-800 px-6 py-3 flex items-center justify-between">
        <a href="/">
          <LogoFull height={24} className="text-zinc-100" />
        </a>
        {isHost ? (
          <Link href="/dashboard" className="text-xs text-zinc-500 hover:text-zinc-300 transition">
            &larr; Dashboard
          </Link>
        ) : (
          <a href="/" className="text-xs text-zinc-500 hover:text-zinc-300 transition">
            Sign in
          </a>
        )}
      </header>

      {/* Mobile tab bar — visible only on small screens */}
      <div className="flex md:hidden border-b border-zinc-800">
        <button
          onClick={() => setMobileTab("chat")}
          className={`flex-1 py-2.5 flex items-center justify-center gap-1.5 text-sm font-medium transition ${
            mobileTab === "chat"
              ? "text-indigo-400 border-b-2 border-indigo-400"
              : "text-zinc-500"
          }`}
        >
          <ChatIcon className={mobileTab === "chat" ? "text-indigo-400" : "text-zinc-500"} />
          Chat
        </button>
        <button
          onClick={() => setMobileTab("details")}
          className={`flex-1 py-2.5 flex items-center justify-center gap-1.5 text-sm font-medium transition ${
            mobileTab === "details"
              ? "text-indigo-400 border-b-2 border-indigo-400"
              : "text-zinc-500"
          }`}
        >
          <ClockIcon className={mobileTab === "details" ? "text-indigo-400" : "text-zinc-500"} />
          Details
        </button>
      </div>

      {/* Desktop layout */}
      <div className="hidden md:flex flex-1 overflow-hidden">
        {/* Chat panel */}
        <div className="flex-1 flex flex-col">{chatContent}</div>

        {/* Right sidebar */}
        <div className="w-80 border-l border-zinc-800 p-4 overflow-y-auto">
          {sidebarContent}
        </div>
      </div>

      {/* Mobile layout */}
      <div className="flex md:hidden flex-1 overflow-hidden">
        {mobileTab === "chat" ? (
          <div className="flex-1 flex flex-col">{chatContent}</div>
        ) : (
          <div className="flex-1 overflow-y-auto p-4">{sidebarContent}</div>
        )}
      </div>
    </div>
  );
}
