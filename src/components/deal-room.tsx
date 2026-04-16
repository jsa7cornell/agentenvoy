"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { LogoFull } from "./logo";
import { AvailabilityCalendar } from "./availability-calendar";
import { DashboardHeader } from "./dashboard-header";

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
  const router = useRouter();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSending, setIsSending] = useState(false);
  const [hostName, setHostName] = useState("");
  const [isHost, setIsHost] = useState(false);
  const [topic, setTopic] = useState("");
  const [linkFormat, setLinkFormat] = useState("");
  const [inviteeName, setInviteeName] = useState("");
  const [guestEmail, setGuestEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [archivedData, setArchivedData] = useState<{ hostEmail: string | null; hostName: string | null } | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [confirmData, setConfirmData] = useState<Record<string, unknown> | null>(null);
  const [isConfirming, setIsConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [emailWarning, setEmailWarning] = useState<string | null>(null);
  const [calendarConnected, setCalendarConnected] = useState(false);
  const [showDetailsModal, setShowDetailsModal] = useState(false);
  const [sessionStatus, setSessionStatus] = useState<string>("active");
  const [sessionStatusLabel, setSessionStatusLabel] = useState<string>("");
  const [statusAnimating, setStatusAnimating] = useState(false);
  const [isGroupEvent, setIsGroupEvent] = useState(false);
  const [participants, setParticipants] = useState<Array<{ name: string; status: string }>>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const prevStatusRef = useRef<string>("active");

  // Slots state for availability calendar sidebar
  const [slotsByDay, setSlotsByDay] = useState<Record<string, Array<{ start: string; end: string; score?: number; isShortSlot?: boolean; isStretch?: boolean }>> | null>(null);
  const [slotTimezone, setSlotTimezone] = useState("America/New_York");
  const [slotLocation, setSlotLocation] = useState<{ label: string; until?: string } | null>(null);
  const [slotDuration, setSlotDuration] = useState<number | undefined>(undefined);
  const [slotMinDuration, setSlotMinDuration] = useState<number | undefined>(undefined);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Detect [TIMEZONE_SWITCH] in messages and update widget timezone
  useEffect(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role !== "administrator") continue;
      const match = msg.content.match(/\[TIMEZONE_SWITCH\]\s*(\{[^}]+\})\s*\[\/TIMEZONE_SWITCH\]/);
      if (match) {
        try {
          const { timezone } = JSON.parse(match[1]);
          if (timezone && typeof timezone === "string") {
            setSlotTimezone(timezone);
          }
        } catch { /* ignore parse errors */ }
        break; // only apply the most recent switch
      }
    }
  }, [messages]);

  // Fetch slots for availability calendar
  useEffect(() => {
    if (!sessionId) return;
    fetch(`/api/negotiate/slots?sessionId=${sessionId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data) {
          setSlotsByDay(data.slotsByDay);
          // Show widget in the guest's local timezone when it differs from the
          // host's — the guest shouldn't have to mentally convert. The slot
          // start/end values are ISO strings (absolute instants) so they render
          // correctly in any timezone via toLocaleTimeString.
          const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
          setSlotTimezone(browserTz && browserTz !== data.timezone ? browserTz : data.timezone);
          if (data.currentLocation) setSlotLocation(data.currentLocation);
          if (data.duration) setSlotDuration(data.duration);
          if (data.minDuration) setSlotMinDuration(data.minDuration);
        }
      })
      .catch(() => {});
  }, [sessionId]);

  // Track event status changes for animation pulse
  useEffect(() => {
    const currentKey = confirmed ? "agreed" : sessionStatus;
    if (prevStatusRef.current !== currentKey && prevStatusRef.current !== "active") {
      setStatusAnimating(true);
      const timer = setTimeout(() => setStatusAnimating(false), 1500);
      prevStatusRef.current = currentKey;
      return () => clearTimeout(timer);
    }
    prevStatusRef.current = currentKey;
  }, [confirmed, sessionStatus]);

  function parseConfirmationProposal(content: string): {
    text: string;
    proposal: { dateTime: string; duration: number; format: string; location: string | null; timezone?: string } | null;
    proposalWarning?: string;
  } {
    // Strip STATUS_UPDATE, ACTION, and TIMEZONE_SWITCH blocks
    const cleaned = content
      .replace(/\s*\[STATUS_UPDATE\].*?\[\/STATUS_UPDATE\]\s*/g, "")
      .replace(/\s*\[ACTION\].*?\[\/ACTION\]\s*/g, "")
      .replace(/\s*\[TIMEZONE_SWITCH\].*?\[\/TIMEZONE_SWITCH\]\s*/g, "");
    const match = cleaned.match(
      /\[CONFIRMATION_PROPOSAL\]([^\[]*)\[\/CONFIRMATION_PROPOSAL\]/
    );
    if (!match) return { text: cleaned.trim(), proposal: null };
    try {
      const proposal = JSON.parse(match[1]);
      const text = cleaned.replace(
        /\[CONFIRMATION_PROPOSAL\][^\[]*\[\/CONFIRMATION_PROPOSAL\]/,
        ""
      ).trim();

      // Validate proposal fields
      const warnings: string[] = [];
      const dt = new Date(proposal.dateTime);
      if (isNaN(dt.getTime())) {
        return { text, proposal: null, proposalWarning: "Invalid date in proposal" };
      }
      if (dt.getTime() < Date.now()) {
        warnings.push("This time is in the past");
      }
      if (!proposal.duration || proposal.duration <= 0) {
        proposal.duration = 30; // safe default
      }
      const validFormats = ["phone", "video", "in-person"];
      if (!validFormats.includes(proposal.format)) {
        warnings.push(`Unknown format: ${proposal.format}`);
      }
      const hasOffset = /[+-]\d{2}:\d{2}$/.test(proposal.dateTime) || proposal.dateTime.endsWith("Z");
      if (!hasOffset) {
        warnings.push("Timezone offset missing \u2014 time may be inaccurate");
      }

      return { text, proposal, proposalWarning: warnings.length > 0 ? warnings.join(". ") : undefined };
    } catch {
      return { text: cleaned.trim(), proposal: null };
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
    setConfirmError(null);
    setEmailWarning(null);
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
          // Client-side fallback: if save_guest_info was called before this
          // turn, guestEmail is already in DB. If not, this ensures the
          // confirm route still has the email to add to the calendar invite.
          guestEmail: guestEmail || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (data.error === "Session already confirmed") {
          setConfirmed(true);
          setSessionStatus("agreed");
          setSessionStatusLabel("");
        } else {
          setConfirmError(data.error || "Failed to confirm meeting");
        }
        return;
      }
      setConfirmData(data);
      setConfirmed(true);
      setSessionStatus("agreed");
      setSessionStatusLabel("");
      if (data.emailSent === false) {
        setEmailWarning("Meeting confirmed, but the confirmation email failed to send.");
      }
    } catch (error) {
      console.error("Confirm error:", error);
      setConfirmError("Failed to confirm meeting. Please try again.");
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
          body: JSON.stringify({
            slug,
            code,
            guestTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          }),
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
        setInviteeName(data.link?.inviteeName || "");
        setSessionStatus(data.status || "active");
        setSessionStatusLabel(data.statusLabel || "");
        if (data.isGroupEvent) setIsGroupEvent(true);
        if (data.participants) setParticipants(data.participants);

        // Generic link → redirect to persistent contextual URL
        if (!code && data.code) {
          router.replace(`/meet/${slug}/${data.code}`);
        }

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
  // eslint-disable-next-line react-hooks/exhaustive-deps -- router is stable, slug/code are the real triggers
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

      // Error responses come as JSON
      if (contentType.includes("application/json")) {
        const body = await res.json();
        if (body.error) throw new Error(body.error);
        setIsSending(false);
        return;
      }

      // Both host and guest messages get a streaming agent response
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
        fullText += chunk;
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId ? { ...m, content: fullText } : m
          )
        );
      }

      // If stream ended with no text, remove the empty bubble and show error
      if (!fullText.trim()) {
        setMessages((prev) => prev.filter((m) => m.id !== assistantId));
        setMessages((prev) => [
          ...prev,
          { id: `error-${Date.now()}`, role: "system", content: "Something went wrong — please try again." },
        ]);
      }
      // Re-fetch session status + link info after AI response
      if (sessionId) {
        try {
          const sessionRes = await fetch(`/api/negotiate/session?id=${sessionId}`);
          if (sessionRes.ok) {
            const { session: sess } = await sessionRes.json();
            setSessionStatus(sess.status);
            setSessionStatusLabel(sess.statusLabel || "");
            // Update link info (guest name, topic, email) if changed by save_guest_info action
            if (sess.link?.inviteeName && !inviteeName) setInviteeName(sess.link.inviteeName);
            if (sess.link?.topic && !topic) setTopic(sess.link.topic);
            const freshEmail = sess.guestEmail || sess.link?.inviteeEmail;
            if (freshEmail && !guestEmail) setGuestEmail(freshEmail);
          }
        } catch {}
      }
    } catch (error) {
      console.error("Send error:", error);
      const errorContent = error instanceof Error ? error.message : "Failed to send message. Please try again.";
      setMessages((prev) => [
        ...prev,
        { id: `error-${Date.now()}`, role: "system", content: errorContent },
      ]);
    } finally {
      setIsSending(false);
    }
  }

  // --- Contextual event title ---
  function getEventTitle() {
    const hostFirst = hostName ? hostName.split(" ")[0] : "";
    const guestFirst = inviteeName ? inviteeName.split(" ")[0] : "";
    const effectiveFormat = confirmed && confirmData ? (confirmData.format as string) : linkFormat;

    if (topic && guestFirst) return `${topic} — ${guestFirst}`;
    if (topic && hostFirst) return `${topic} with ${hostFirst}`;
    if (effectiveFormat === "phone" && guestFirst && hostFirst) return `Phone call: ${guestFirst} & ${hostFirst}`;
    if (effectiveFormat === "phone" && hostName) return `Phone call with ${hostName}`;
    if ((effectiveFormat === "video") && guestFirst && hostFirst) return `Call — ${guestFirst} & ${hostFirst}`;
    if ((effectiveFormat === "video") && hostName) return `Call with ${hostName}`;
    if (guestFirst && hostFirst) return `${guestFirst} & ${hostFirst}`;
    if (hostName) return `Meet with ${hostName}`;
    return "Meeting";
  }

  // --- Archived state ---
  if (archivedData) {
    return (
      <div className="min-h-screen bg-surface flex items-center justify-center">
        <div className="text-center max-w-md">
          <div className="w-16 h-16 mx-auto mb-5 rounded-full bg-surface-secondary border border-DEFAULT flex items-center justify-center">
            <svg className="w-7 h-7 text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5m8.25 3v6.75m0 0l-3-3m3 3l3-3M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z" />
            </svg>
          </div>
          <h1 className="text-xl font-bold text-primary mb-2">Meeting Unavailable</h1>
          <p className="text-sm text-muted mb-4">
            This meeting isn&rsquo;t available right now.
          </p>
          {archivedData.hostEmail && (
            <p className="text-sm text-secondary">
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
      <div className="min-h-screen bg-surface flex items-center justify-center">
        <div className="text-center">
          <div className="text-4xl mb-4">&#128533;</div>
          <h1 className="text-xl font-bold text-primary mb-2">Link not found</h1>
          <p className="text-muted">{error}</p>
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
    const dealRoomUrl = `${window.location.origin}/meet/${slug}${code ? `/${code}` : ""}`;
    const descParts = [
      `Scheduled via AgentEnvoy`,
      ...(confirmData.meetLink ? [`Join: ${confirmData.meetLink}`] : []),
      "",
      `Need to change or cancel? ${dealRoomUrl}`,
    ];
    // ICS DESCRIPTION uses escaped newlines
    const icsDesc = descParts.join("\\n");
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      `DTSTART:${fmt(dt)}`,
      `DTEND:${fmt(end)}`,
      `SUMMARY:${getEventTitle()}`,
      `DESCRIPTION:${icsDesc}`,
      `URL:${dealRoomUrl}`,
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

  // Server-driven status — confirmed state overrides sessionStatus for backwards compat
  const eventStatus = confirmed ? "agreed" : sessionStatus;

  const statusConfigs: Record<string, { label: string; color: string; border: string; dot: string }> = {
    active: { label: "Scheduling", color: "text-zinc-400", border: "border-zinc-700", dot: "bg-zinc-500" },
    proposed: { label: "Proposed", color: "text-amber-400", border: "border-amber-500/25", dot: "bg-amber-400" },
    agreed: { label: "Confirmed", color: "text-emerald-400", border: "border-emerald-500/25", dot: "bg-emerald-400" },
    cancelled: { label: "Cancelled", color: "text-red-400", border: "border-red-500/25", dot: "bg-red-400" },
    escalated: { label: "Escalated", color: "text-orange-400", border: "border-orange-500/25", dot: "bg-orange-400" },
    expired: { label: "Expired", color: "text-zinc-500", border: "border-zinc-700", dot: "bg-zinc-600" },
  };

  const statusConfig = statusConfigs[eventStatus] || statusConfigs.active;

  // Event details come from confirmData (confirmed) or latestProposal (proposed) or just title (scheduling)
  const eventDateTime = confirmed && confirmData
    ? confirmData.dateTime as string
    : latestProposal?.dateTime ?? null;
  const eventFormat = confirmed && confirmData
    ? String(confirmData.format)
    : latestProposal?.format ?? linkFormat ?? null;
  const eventDuration = confirmed && confirmData
    ? String(confirmData.duration)
    : latestProposal ? String(latestProposal.duration) : String(slotDuration || 30);
  const eventLocation = confirmed && confirmData
    ? (confirmData.location as string | null)
    : latestProposal?.location ?? null;
  const eventMeetLink = confirmed && confirmData
    ? (confirmData.meetLink as string | undefined)
    : undefined;

  const hasExtraDetails = !!(eventMeetLink || eventLocation);

  // Generate Google Calendar "add event" URL from event details
  const googleCalUrl = (() => {
    if (!eventDateTime) return null;
    const dt = new Date(eventDateTime);
    const dur = Number(eventDuration) || 30;
    const end = new Date(dt.getTime() + dur * 60000);
    const fmt = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const drUrl = `${window.location.origin}/meet/${slug}${code ? `/${code}` : ""}`;
    const detailParts = [
      ...(eventMeetLink ? [`Join: ${eventMeetLink}`] : []),
      "",
      `Need to change or cancel? ${drUrl}`,
    ];
    const params = new URLSearchParams({
      action: "TEMPLATE",
      text: getEventTitle(),
      dates: `${fmt(dt)}/${fmt(end)}`,
      details: detailParts.join("\n"),
      ...(eventLocation ? { location: eventLocation } : {}),
    });
    return `https://calendar.google.com/calendar/render?${params.toString()}`;
  })();


  const eventCard = (
    <div className={`z-10 px-4 sm:px-5 pt-3 sm:pt-4 pb-2 bg-surface/95 backdrop-blur-sm flex-shrink-0 transition-all duration-500`}>
      <div className={`max-w-3xl rounded-xl border ${statusConfig.border} bg-black/[0.02] dark:bg-white/[0.03] px-4 py-3 transition-all duration-500 ${statusAnimating ? "ring-1 " + (eventStatus === "confirmed" ? "ring-emerald-500/40 bg-emerald-500/5" : eventStatus === "cancelled" ? "ring-red-500/40 bg-red-500/5" : "ring-amber-500/40 bg-amber-500/5") : ""}`}>
        {/* Row 1: Title + status */}
        <div className="flex items-center gap-2.5 mb-1.5">
          <div className={`w-2.5 h-2.5 rounded-full ${statusConfig.dot} flex-shrink-0 transition-colors duration-500 ${statusAnimating ? "scale-125" : ""}`} style={statusAnimating ? { animation: "pulse 1s ease-in-out" } : {}} />
          <span className="text-sm font-semibold text-primary truncate">{getEventTitle()}</span>
          <span className={`text-[10px] font-semibold uppercase tracking-wide ${statusConfig.color} flex-shrink-0`}>{statusConfig.label}</span>
          {sessionStatusLabel &&
            sessionStatusLabel.trim().toLowerCase() !== statusConfig.label.toLowerCase() && (
              <span className="text-[10px] text-muted ml-2">{sessionStatusLabel}</span>
            )}
        </div>

        {/* Participants row (group events) */}
        {isGroupEvent && participants.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 ml-5 mb-1">
            {participants.map((p, i) => (
              <span key={i} className="flex items-center gap-1 text-xs text-secondary">
                <span className={`w-1.5 h-1.5 rounded-full ${
                  p.status === "agreed" ? "bg-emerald-400" :
                  p.status === "active" ? "bg-amber-400" :
                  p.status === "declined" ? "bg-red-400" : "bg-zinc-500"
                }`} />
                {p.name}
              </span>
            ))}
          </div>
        )}

        {/* Row 2: Details */}
        <div className="flex flex-wrap gap-x-4 gap-y-0.5 ml-5 text-xs text-secondary">
          {eventFormat && (
            <span>{eventFormat === "phone" ? "Phone" : eventFormat === "video" ? "Video" : eventFormat === "in-person" ? "In person" : eventFormat} &middot; {eventDuration} min</span>
          )}
          {eventDateTime && (() => {
            const dt = new Date(eventDateTime);
            const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
            const hostTz = slotTimezone;
            const showDual = hostTz && hostTz !== localTz;
            const datePart = dt.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
            const localTime = dt.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZoneName: "short" });
            const hostTime = showDual ? dt.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZoneName: "short", timeZone: hostTz }) : null;
            return <span>{datePart} {localTime}{hostTime ? ` (${hostTime})` : ""}</span>;
          })()}
          {!eventDateTime && !eventFormat && <span>Meeting details pending</span>}
          {eventMeetLink && (
            <a href={eventMeetLink} className="text-indigo-400 hover:text-indigo-300 truncate max-w-[200px]" target="_blank" rel="noopener noreferrer">
              {eventMeetLink.replace("https://", "").split("/").slice(0, 2).join("/")}
            </a>
          )}
          {eventLocation && <span className="truncate max-w-[200px]">{eventLocation}</span>}
        </div>

        {/* Add participant button — host only, non-confirmed */}
        {isHost && !confirmed && eventStatus !== "cancelled" && (
          <div className="ml-5 mt-1.5">
            <button
              onClick={async () => {
                if (!sessionId) return;
                try {
                  const res = await fetch("/api/negotiate/upgrade", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ sessionId }),
                  });
                  if (res.ok) {
                    setIsGroupEvent(true);
                  }
                } catch {}
              }}
              className={`text-xs transition ${isGroupEvent ? "text-muted cursor-default" : "text-indigo-400 hover:text-indigo-300"}`}
              disabled={isGroupEvent}
            >
              {isGroupEvent ? "Group link active — share link to add people" : "+ Add participant (make group link)"}
            </button>
          </div>
        )}

        {/* Row 3: Actions */}
        {(confirmed || eventStatus === "cancelled") && (
          <div className="flex items-center gap-3 ml-5 mt-2.5">
            {eventStatus !== "cancelled" && (
              <>
                {/* Google Calendar */}
                {googleCalUrl && (
                  <a href={googleCalUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-surface-secondary/80 border border-DEFAULT hover:border-zinc-600 transition text-xs text-primary">
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
                <button onClick={downloadIcs} className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-surface-secondary/80 border border-DEFAULT hover:border-zinc-600 transition text-xs text-primary">
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
                className="text-xs text-muted hover:text-secondary transition"
              >
                Details
              </button>
            )}
          </div>
        )}

        {/* Signup CTA — guests only, after confirmation */}
        {confirmed && !isHost && (
          <div className="ml-5 mt-3 p-3 rounded-xl bg-purple-500/8 border border-purple-500/20">
            <p className="text-xs text-primary">
              Want your own AI negotiator?{" "}
              <a href="/api/auth/signin" className="text-purple-400 hover:text-purple-300 font-semibold transition">
                Create a free AgentEnvoy account
              </a>{" "}
              — Envoy handles scheduling so you don&apos;t have to.
            </p>
          </div>
        )}
      </div>
    </div>
  );

  // --- Details modal ---
  const detailsModal = showDetailsModal ? (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setShowDetailsModal(false)}>
      <div className="bg-surface-inset border border-DEFAULT rounded-2xl p-6 w-full max-w-sm mx-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-semibold text-primary mb-4">Meeting Details</h3>
        <div className="space-y-3 text-sm text-primary">
          <div><span className="text-muted">Title:</span> {getEventTitle()}</div>
          {eventDateTime && <div><span className="text-muted">When:</span> {new Date(eventDateTime).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })} at {new Date(eventDateTime).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZoneName: "short" })}</div>}
          {eventFormat && <div><span className="text-muted">Format:</span> {eventFormat.charAt(0).toUpperCase() + eventFormat.slice(1)} &middot; {eventDuration} min</div>}
          {eventLocation && <div><span className="text-muted">Location:</span> {eventLocation}</div>}
          {eventMeetLink && <div><span className="text-muted">Link:</span> <a href={eventMeetLink} className="text-indigo-400 hover:text-indigo-300" target="_blank" rel="noopener noreferrer">{eventMeetLink}</a></div>}
          {hostName && <div><span className="text-muted">Host:</span> {hostName}</div>}
        </div>
        {confirmed && (
          <div className="flex gap-2 mt-4">
            <button onClick={downloadIcs} className="flex-1 px-3 py-2 text-xs font-medium bg-surface-secondary text-primary border border-DEFAULT rounded-lg hover:border-zinc-600 transition">Download .ics</button>
            {googleCalUrl && (
              <a href={googleCalUrl} target="_blank" rel="noopener noreferrer" className="flex-1 px-3 py-2 text-xs font-medium bg-emerald-900/40 text-emerald-300 border border-emerald-500/20 rounded-lg hover:border-emerald-500/40 transition text-center">Add to Google</a>
            )}
          </div>
        )}
        <button onClick={() => setShowDetailsModal(false)} className="w-full mt-3 px-3 py-2 text-xs text-muted border border-secondary rounded-lg hover:border-DEFAULT transition">Close</button>
      </div>
    </div>
  ) : null;

  // --- Main content ---
  const chatContent = (
    <>
      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden p-4 space-y-4">
        {isLoading ? (
          <div className="flex justify-center py-12">
            <div className="flex gap-1">
              <div className="w-2 h-2 rounded-full bg-muted animate-bounce" />
              <div className="w-2 h-2 rounded-full bg-muted animate-bounce [animation-delay:0.1s]" />
              <div className="w-2 h-2 rounded-full bg-muted animate-bounce [animation-delay:0.2s]" />
            </div>
          </div>
        ) : (
          messages.map((msg, idx) => {
            // Date separator — show on first message of each new day
            let dateSeparator: React.ReactNode = null;
            if (msg.createdAt) {
              const msgDate = new Date(msg.createdAt).toLocaleDateString("en-US", {
                weekday: "short",
                month: "short",
                day: "numeric",
              });
              const prevDate = idx > 0 && messages[idx - 1]?.createdAt
                ? new Date(messages[idx - 1].createdAt!).toLocaleDateString("en-US", {
                    weekday: "short",
                    month: "short",
                    day: "numeric",
                  })
                : null;
              if (idx === 0 || msgDate !== prevDate) {
                dateSeparator = (
                  <div className="flex items-center gap-3 py-2">
                    <div className="flex-1 border-t border-secondary" />
                    <span className="text-[10px] font-medium uppercase tracking-wider text-muted">{msgDate}</span>
                    <div className="flex-1 border-t border-secondary" />
                  </div>
                );
              }
            }

            // Legacy "Meeting confirmed:" system messages — hidden. The
            // inline green card below the confirmed proposal already
            // conveys this. New sessions won't write this message; this
            // branch hides it for historical sessions.
            if (msg.role === "system" && /^Meeting confirmed:/i.test(msg.content)) {
              return null;
            }

            // Host notes — only visible to host
            if (msg.role === "host_note") {
              if (!isHost) return null;
              return (
                <div key={msg.id}>
                  {dateSeparator}
                  <div className="flex justify-end">
                    <div className="max-w-[70%] rounded-lg px-3 py-1.5 text-xs bg-amber-900/30 border border-amber-700/40 text-amber-300">
                      <span className="font-semibold uppercase tracking-wider text-[9px] text-amber-500 mr-1.5">Note</span>
                      {msg.content}
                    </div>
                  </div>
                </div>
              );
            }

            const parsed =
              msg.role === "administrator"
                ? parseConfirmationProposal(msg.content)
                : { text: msg.content, proposal: null, proposalWarning: undefined };
            const { proposal, proposalWarning } = parsed;
            // Once the meeting is confirmed, Envoy's original proposal
            // message still contains call-to-action text like "Click confirm
            // to lock it in!" — strip those trailing CTA lines so the history
            // reads cleanly in past tense. The green "Meeting confirmed!" card
            // renders below the message and is the new call-to-nothing.
            const text = (proposal && confirmed)
              ? parsed.text
                  .replace(/\s*(?:just\s+)?click (?:the )?confirm(?:\s+button)?[^\n.!]*[.!]*/gi, "")
                  .replace(/\s*(?:lock it in|locked in)[!.]?/gi, "")
                  .replace(/\s*let me know if[^\n]*/gi, "")
                  .replace(/\n{3,}/g, "\n\n")
                  .trim()
              : parsed.text;

            // 3-party model: Envoy (AI) + system notices always left;
            // humans (host + guest) always right. Color distinguishes which
            // human spoke — purple = host, indigo = guest.
            const rightAligned = msg.role === "host" || msg.role === "guest";

            const messageStyle =
              msg.role === "host"
                ? "bg-purple-600 text-white rounded-br-sm"
                : msg.role === "guest"
                  ? "bg-indigo-600 text-white rounded-br-sm"
                  : msg.role === "system"
                    ? "bg-emerald-900/30 border border-emerald-800 text-emerald-200 rounded-lg"
                    : "bg-surface-secondary border border-DEFAULT text-primary rounded-bl-sm";

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
                {dateSeparator}
                <div className={`flex min-w-0 ${rightAligned ? "justify-end" : "justify-start"}`}>
                  <div className={`max-w-[85%] min-w-0 rounded-2xl px-4 py-3 text-sm leading-relaxed ${messageStyle}`}>
                    {senderLabel && (
                      <div className={`text-[10px] font-bold uppercase tracking-wider mb-1 ${labelColor}`}>
                        {senderLabel}
                      </div>
                    )}
                    <div className="whitespace-pre-wrap break-words">{text}</div>
                  </div>
                </div>

                {proposal && confirmed && (
                  <div className="flex justify-start mt-2">
                    <div className="max-w-[85%] bg-emerald-900/20 border border-emerald-700/50 rounded-xl p-3">
                      <p className="text-sm text-emerald-400 font-medium">Meeting confirmed!</p>
                      <p className="text-xs text-muted mt-1">You can view and manage details at the top of this page.</p>
                    </div>
                  </div>
                )}

                {proposal && !confirmed && (
                  <div className="flex justify-start mt-2">
                    <div className="max-w-[85%] bg-emerald-900/20 border border-emerald-700/50 rounded-xl p-4 space-y-3">
                      <div className="text-[10px] font-bold uppercase tracking-wider text-emerald-400">Proposed meeting</div>
                      <div className="space-y-1 text-sm text-primary">
                        <p>&#128197; {new Date(proposal.dateTime).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}</p>
                        <p>&#128336; {new Date(proposal.dateTime).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })} ({proposal.duration} min)</p>
                        <p>&#128241; {proposal.format.charAt(0).toUpperCase() + proposal.format.slice(1)}</p>
                        {proposal.location && <p>&#128205; {proposal.location}</p>}
                      </div>
                      {proposalWarning && (
                        <p className="text-xs text-amber-400 mt-1">{proposalWarning}</p>
                      )}
                      <button
                        onClick={() => handleConfirm(proposal)}
                        disabled={isConfirming || (proposalWarning?.includes("in the past") ?? false)}
                        className="w-full mt-2 px-4 py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition"
                      >
                        {isConfirming ? "Confirming..." : "Confirm this time"}
                      </button>
                      <button
                        onClick={() => {
                          setInput("That\u2019s close, but could we ");
                          document.querySelector<HTMLTextAreaElement>("textarea")?.focus();
                        }}
                        className="w-full text-center text-xs text-muted hover:text-secondary transition mt-1"
                      >
                        Suggest a change
                      </button>
                      {confirmError && (
                        <p className="mt-2 text-xs text-red-400">{confirmError}</p>
                      )}
                      {emailWarning && (
                        <p className="mt-2 text-xs text-amber-400">{emailWarning}</p>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
        {isSending && (
          <div className="flex justify-start">
            <div className="bg-surface-secondary border border-DEFAULT rounded-2xl rounded-bl-sm px-4 py-3">
              <div className="text-[10px] font-bold uppercase tracking-wider text-emerald-400 mb-1">Envoy</div>
              <div className="flex gap-1">
                <div className="w-2 h-2 rounded-full bg-muted animate-bounce" />
                <div className="w-2 h-2 rounded-full bg-muted animate-bounce [animation-delay:0.1s]" />
                <div className="w-2 h-2 rounded-full bg-muted animate-bounce [animation-delay:0.2s]" />
              </div>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <form onSubmit={handleSend} className="p-4 border-t border-secondary">
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
            name="message"
            autoComplete="off"
            autoCorrect="on"
            autoCapitalize="sentences"
            spellCheck
            inputMode="text"
            enterKeyHint="send"
            data-lpignore="true"
            data-1p-ignore="true"
            data-form-type="other"
            className="flex-1 min-w-0 resize-none bg-surface-secondary border border-DEFAULT rounded-xl px-4 py-3 text-base md:text-sm text-primary placeholder:text-muted focus:outline-none focus:border-indigo-500 transition disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={isSending || !input.trim() || isLoading}
            className="px-4 py-3 bg-accent hover:bg-accent-hover disabled:opacity-50 text-white rounded-xl text-sm font-medium transition"
          >
            Send
          </button>
        </div>
        {isHost && (
          <p className="text-[10px] text-muted mt-1.5">
            Prefix with <code className="text-muted">::</code> for private notes to Envoy
          </p>
        )}
      </form>
    </>
  );

  return (
    <div className="fixed inset-0 bg-surface text-primary flex flex-col overflow-hidden z-20">
      {/* Header — full dashboard chrome for the host, minimal brand bar for guests */}
      {isHost ? (
        <DashboardHeader />
      ) : (
        <header className="border-b border-secondary px-6 py-3 flex items-center justify-between flex-shrink-0">
          <a href="/">
            <LogoFull height={24} className="text-primary" />
          </a>
          <a href="/" className="text-xs text-muted hover:text-primary transition">
            Sign in
          </a>
        </header>
      )}

      {/* Main area — chat + sidebar on desktop */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Chat column — event card + messages */}
        <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
          {/* Event card — sticky inside chat column */}
          {eventCard}
          {/* Mobile availability toggle — hidden on desktop where sidebar shows */}
          {slotsByDay && Object.keys(slotsByDay).length > 0 && (
            <details className="md:hidden border-b border-secondary flex-shrink-0">
              <summary className="px-4 py-2 text-[10px] font-bold uppercase tracking-widest text-muted cursor-pointer hover:text-secondary select-none">
                View availability
              </summary>
              <div className="px-4 pb-3 max-h-[40vh] overflow-y-auto">
                <AvailabilityCalendar
                  view="week"
                  slotsByDay={slotsByDay || {}}
                  timezone={slotTimezone}
                  currentLocation={slotLocation}
                  duration={slotDuration}
                  minDuration={slotMinDuration}
                  onSelectSlot={!isHost ? (msg) => {
                    setInput(msg);
                    document.querySelector<HTMLTextAreaElement>("textarea")?.focus();
                  } : undefined}
                  onTimezoneClick={() => {
                    setInput("I\u2019m actually in a different timezone \u2014 ");
                    document.querySelector<HTMLTextAreaElement>("textarea")?.focus();
                  }}
                />
              </div>
            </details>
          )}
          {chatContent}
        </div>

        {/* Availability sidebar — desktop only */}
        <div className="hidden md:flex w-80 flex-shrink-0 border-l border-secondary p-5 overflow-y-auto flex-col">
          <h4 className="text-[11px] font-bold uppercase tracking-widest text-muted mb-3">
            Availability
          </h4>
          <AvailabilityCalendar
            slotsByDay={slotsByDay || {}}
            timezone={slotTimezone}
            currentLocation={slotLocation}
            duration={slotDuration}
            minDuration={slotMinDuration}
            onSelectSlot={!isHost ? (msg) => {
              setInput(msg);
              document.querySelector<HTMLTextAreaElement>("textarea")?.focus();
            } : undefined}
            onTimezoneClick={() => {
              setInput("I\u2019m actually in a different timezone \u2014 ");
              document.querySelector<HTMLTextAreaElement>("textarea")?.focus();
            }}
          />
        </div>
      </div>

      {/* Details modal */}
      {detailsModal}
    </div>
  );
}
