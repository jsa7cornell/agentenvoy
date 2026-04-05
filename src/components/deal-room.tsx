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
  const [showDetailsModal, setShowDetailsModal] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Slots state for availability calendar sidebar
  const [slotsByDay, setSlotsByDay] = useState<Record<string, Array<{ start: string; end: string }>> | null>(null);
  const [slotTimezone, setSlotTimezone] = useState("America/New_York");

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Fetch slots for availability calendar
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

  // --- Sticky event card (shows in all states) ---
  // Determine the latest proposal from messages (for "Proposed" state)
  const latestProposal = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "administrator") {
        const { proposal } = parseConfirmationProposal(messages[i].content);
        if (proposal) return proposal;
      }
    }
    return null;
  })();

  // Detect cancellation or change requests in recent messages
  const hasCancellation = (() => {
    const recent = messages.slice(-4);
    const cancelTerms = /cancel|cancelled|cancellation/i;
    return recent.some((m) => (m.role === "administrator" || m.role === "guest" || m.role === "host") && cancelTerms.test(m.content));
  })();

  const hasChangeRequest = (() => {
    if (hasCancellation) return false;
    const recent = messages.slice(-4);
    const changeTerms = /reschedul|change.*time|move.*meeting|push.*to|different.*time/i;
    return confirmed && recent.some((m) => (m.role === "guest" || m.role === "host") && changeTerms.test(m.content));
  })();

  const eventStatus: "confirmed" | "proposed" | "scheduling" | "cancelled" | "changing" =
    hasCancellation ? "cancelled"
    : hasChangeRequest ? "changing"
    : confirmed ? "confirmed"
    : latestProposal ? "proposed"
    : "scheduling";

  const statusConfig = {
    confirmed: { label: "Confirmed", color: "text-emerald-400", border: "border-emerald-500/25", dot: "bg-emerald-400" },
    proposed: { label: "Proposed", color: "text-amber-400", border: "border-amber-500/25", dot: "bg-amber-400" },
    scheduling: { label: "Scheduling", color: "text-zinc-400", border: "border-zinc-700", dot: "bg-zinc-500" },
    cancelled: { label: "Cancelled", color: "text-red-400", border: "border-red-500/25", dot: "bg-red-400" },
    changing: { label: "Changing", color: "text-amber-400", border: "border-amber-500/25", dot: "bg-amber-400" },
  }[eventStatus];

  // Event details come from confirmData (confirmed) or latestProposal (proposed) or just title (scheduling)
  const eventDateTime = confirmed && confirmData
    ? confirmData.dateTime as string
    : latestProposal?.dateTime ?? null;
  const eventFormat = confirmed && confirmData
    ? String(confirmData.format)
    : latestProposal?.format ?? linkFormat ?? null;
  const eventDuration = confirmed && confirmData
    ? String(confirmData.duration)
    : latestProposal ? String(latestProposal.duration) : "30";
  const eventLocation = confirmed && confirmData
    ? (confirmData.location as string | null)
    : latestProposal?.location ?? null;
  const eventMeetLink = confirmed && confirmData
    ? (confirmData.meetLink as string | undefined)
    : undefined;

  const hasExtraDetails = !!(eventMeetLink || eventLocation);

  const eventCard = (
    <div className={`z-10 mx-0 px-4 sm:px-5 py-3 sm:py-4 bg-[#0a0a0f]/95 backdrop-blur-sm border-b ${statusConfig.border} flex-shrink-0`}>
      <div className="max-w-3xl mx-auto">
        {/* Row 1: Title + status */}
        <div className="flex items-center gap-2.5 mb-1.5">
          <div className={`w-2.5 h-2.5 rounded-full ${statusConfig.dot} flex-shrink-0`} />
          <span className="text-sm font-semibold text-zinc-100 truncate">{getEventTitle()}</span>
          <span className={`text-[10px] font-semibold uppercase tracking-wide ${statusConfig.color} flex-shrink-0`}>{statusConfig.label}</span>
        </div>

        {/* Row 2: Details */}
        <div className="flex flex-wrap gap-x-4 gap-y-0.5 ml-5 text-xs text-zinc-400">
          {eventFormat && (
            <span>{eventFormat === "phone" ? "Phone" : eventFormat === "video" ? "Video" : eventFormat === "in-person" ? "In person" : eventFormat} &middot; {eventDuration} min</span>
          )}
          {eventDateTime && (
            <span>{new Date(eventDateTime).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })} {new Date(eventDateTime).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZoneName: "short" })}</span>
          )}
          {!eventDateTime && !eventFormat && <span>Meeting details pending</span>}
          {eventMeetLink && (
            <a href={eventMeetLink} className="text-indigo-400 hover:text-indigo-300 truncate max-w-[200px]" target="_blank" rel="noopener noreferrer">
              {eventMeetLink.replace("https://", "").split("/").slice(0, 2).join("/")}
            </a>
          )}
          {eventLocation && <span className="truncate max-w-[200px]">{eventLocation}</span>}
        </div>

        {/* Row 3: Actions */}
        {(confirmed || eventStatus === "cancelled") && (
          <div className="flex items-center gap-3 ml-5 mt-2.5">
            {eventStatus !== "cancelled" && (
              <>
                {/* Google Calendar */}
                {typeof confirmData?.eventLink === "string" && (
                  <a href={confirmData.eventLink as string} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-zinc-800/80 border border-zinc-700 hover:border-zinc-600 transition text-xs text-zinc-300">
                    <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 flex-shrink-0">
                      <path d="M18.316 5.684H24v12.632h-5.684V5.684z" fill="#1967D2" />
                      <path d="M5.684 18.316V5.684L0 5.684v12.632l5.684 0z" fill="#188038" />
                      <path d="M18.316 24V18.316H5.684V24h12.632z" fill="#1967D2" />
                      <path d="M18.316 5.684V0H5.684v5.684h12.632z" fill="#EA4335" />
                      <path d="M18.316 18.316H5.684V5.684h12.632v12.632z" fill="#fff" />
                      <path d="M9.2 15.7V9.1h1.5v2.4h2.6V9.1h1.5v6.6h-1.5v-2.8h-2.6v2.8H9.2z" fill="#1967D2" />
                    </svg>
                    Google
                  </a>
                )}
                {/* ICS download */}
                <button onClick={downloadIcs} className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-zinc-800/80 border border-zinc-700 hover:border-zinc-600 transition text-xs text-zinc-300">
                  <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5" />
                  </svg>
                  .ics
                </button>
              </>
            )}
            {/* Propose changes */}
            <button
              onClick={() => {
                setInput("I'd like to propose a change to this meeting — ");
                document.querySelector<HTMLTextAreaElement>("textarea")?.focus();
              }}
              className="text-xs text-indigo-400 hover:text-indigo-300 transition"
            >
              Propose changes
            </button>
            {/* More details */}
            {hasExtraDetails && (
              <button
                onClick={() => setShowDetailsModal(true)}
                className="text-xs text-zinc-500 hover:text-zinc-400 transition"
              >
                Details
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );

  // --- Details modal ---
  const detailsModal = showDetailsModal ? (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setShowDetailsModal(false)}>
      <div className="bg-zinc-900 border border-zinc-700 rounded-2xl p-6 w-full max-w-sm mx-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-semibold text-zinc-100 mb-4">Meeting Details</h3>
        <div className="space-y-3 text-sm text-zinc-300">
          <div><span className="text-zinc-500">Title:</span> {getEventTitle()}</div>
          {eventDateTime && <div><span className="text-zinc-500">When:</span> {new Date(eventDateTime).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })} at {new Date(eventDateTime).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZoneName: "short" })}</div>}
          {eventFormat && <div><span className="text-zinc-500">Format:</span> {eventFormat.charAt(0).toUpperCase() + eventFormat.slice(1)} &middot; {eventDuration} min</div>}
          {eventLocation && <div><span className="text-zinc-500">Location:</span> {eventLocation}</div>}
          {eventMeetLink && <div><span className="text-zinc-500">Link:</span> <a href={eventMeetLink} className="text-indigo-400 hover:text-indigo-300" target="_blank" rel="noopener noreferrer">{eventMeetLink}</a></div>}
          {hostName && <div><span className="text-zinc-500">Host:</span> {hostName}</div>}
        </div>
        {confirmed && (
          <div className="flex gap-2 mt-4">
            <button onClick={downloadIcs} className="flex-1 px-3 py-2 text-xs font-medium bg-zinc-800 text-zinc-300 border border-zinc-700 rounded-lg hover:border-zinc-600 transition">Download .ics</button>
            {typeof confirmData?.eventLink === "string" && (
              <a href={confirmData.eventLink as string} target="_blank" rel="noopener noreferrer" className="flex-1 px-3 py-2 text-xs font-medium bg-emerald-900/40 text-emerald-300 border border-emerald-500/20 rounded-lg hover:border-emerald-500/40 transition text-center">Add to Google</a>
            )}
          </div>
        )}
        <button onClick={() => setShowDetailsModal(false)} className="w-full mt-3 px-3 py-2 text-xs text-zinc-500 border border-zinc-800 rounded-lg hover:border-zinc-700 transition">Close</button>
      </div>
    </div>
  ) : null;

  // --- Main content ---
  const chatContent = (
    <>
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
    <div className="h-screen bg-[#0a0a0f] text-zinc-100 flex flex-col overflow-hidden">
      {/* Prototype banner */}
      <div className="bg-amber-900/30 border-b border-amber-700/40 px-4 py-1.5 text-center flex-shrink-0">
        <span className="text-xs text-amber-300">
          Prototype — email and other features still in development
        </span>
      </div>

      {/* Header */}
      <header className="border-b border-zinc-800 px-6 py-3 flex items-center justify-between flex-shrink-0">
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

      {/* Main area — chat + sidebar on desktop */}
      <div className="flex flex-1 overflow-hidden">
        {/* Chat column — event card + messages */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Event card — sticky inside chat column */}
          {eventCard}
          {chatContent}
        </div>

        {/* Availability sidebar — desktop only */}
        <div className="hidden md:flex w-64 flex-shrink-0 border-l border-zinc-800 p-4 overflow-y-auto flex-col">
          <h4 className="text-[10px] font-bold uppercase tracking-widest text-zinc-500 mb-2">
            Availability
          </h4>
          <AvailabilityCalendar
            slotsByDay={slotsByDay || {}}
            timezone={slotTimezone}
          />
        </div>
      </div>

      {/* Details modal */}
      {detailsModal}
    </div>
  );
}
