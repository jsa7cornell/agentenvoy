"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { LogoFull } from "./logo";
import { AvailabilityCalendar } from "./availability-calendar";
import { DashboardHeader } from "./dashboard-header";
import { PublicHeader } from "./public-header";
import { TimeChipList, type TimeChipData } from "./time-chip-list";

interface DelegateSpeaker {
  kind: "human_assistant" | "ai_agent" | "unknown";
  name?: string;
}

interface Message {
  id: string;
  role: string;
  content: string;
  // Per-message metadata — used for proxy attribution (Slice 9) and other
  // per-message signals. Loose shape intentionally.
  metadata?: {
    delegateSpeaker?: DelegateSpeaker;
    [key: string]: unknown;
  } | null;
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
  // Bilateral: logged-in guest (authenticated User, not the host).
  // Anonymous guests leave this false.
  const [isGuest, setIsGuest] = useState(false);
  const [guestUser, setGuestUser] = useState<{
    id: string;
    name: string | null;
    email: string | null;
  } | null>(null);
  const [topic, setTopic] = useState("");
  const [linkFormat, setLinkFormat] = useState("");
  const [linkLocation, setLinkLocation] = useState<string | null>(null);
  const [inviteeName, setInviteeName] = useState("");
  const [guestEmail, setGuestEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [archivedData, setArchivedData] = useState<{ hostEmail: string | null; hostName: string | null; hostMeetSlug: string | null } | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [confirmData, setConfirmData] = useState<Record<string, unknown> | null>(null);
  const [isConfirming, setIsConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [emailWarning, setEmailWarning] = useState<string | null>(null);
  const [calendarConnected, setCalendarConnected] = useState(false);
  const [showDetailsModal, setShowDetailsModal] = useState(false);
  const [showCancelModal, setShowCancelModal] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [isArchiving, setIsArchiving] = useState(false);
  const [gcalStatus, setGcalStatus] = useState<{
    eventExists: boolean;
    guestOnInvite: boolean;
    guestResponseStatus: "accepted" | "declined" | "tentative" | "needsAction" | null;
  } | null>(null);
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
  const [isVip, setIsVip] = useState(false);
  // Bilateral chip data — populated only when the session has a logged-in
  // guest whose calendar is connected. When absent, no chips render and the
  // existing host-only availability widget carries the interaction load.
  const [bilateralByDay, setBilateralByDay] = useState<Record<string, TimeChipData[]> | null>(null);

  // TZ recovery banner state (Slice 7). When someone raced ahead of the human
  // guest — host, MCP agent, or a proxy — the session's guestTimezone ends up
  // set to a different TZ than the human guest's browser. Banner asks whether
  // to switch the thread to the guest's TZ. Silent otherwise.
  const [sessionTimezone, setSessionTimezone] = useState<string | null>(null);
  const [tzBannerDismissed, setTzBannerDismissed] = useState(false);
  const [isSwitchingTz, setIsSwitchingTz] = useState(false);

  // Anonymous calendar-link CTA state (Slice 8). Anonymous guests — no
  // AgentEnvoy account — can OAuth a read-only Google Calendar connect from
  // the deal room. After a successful round-trip the bilateral chips appear
  // just like they do for logged-in guests (same compute path, different
  // storage). Dismissal persists per-session in localStorage.
  const [anonCalCtaDismissed, setAnonCalCtaDismissed] = useState(false);
  // Post-confirm signup upsell dismissal (client-only state)
  const [signupUpsellDismissed, setSignupUpsellDismissed] = useState(false);
  // Mobile chip CTA expanded state
  const [chipCtaExpanded, setChipCtaExpanded] = useState(false);
  // Signup intro modal (shown when guest clicks "Create free account")
  const [showSignupModal, setShowSignupModal] = useState(false);

  // Direct-confirm flow (2026-04-17): when a guest clicks a slot chip we skip
  // the Envoy round-trip entirely and render a proposal card locally. Once
  // they click Confirm, the card expands to collect name / email / reminder
  // opt-in and posts straight to /api/negotiate/confirm.
  const [pendingProposal, setPendingProposal] = useState<{
    dateTime: string;
    duration: number;
    format: string;
    location: string | null;
  } | null>(null);
  const [confirmFormExpanded, setConfirmFormExpanded] = useState(false);
  const [formGuestName, setFormGuestName] = useState("");
  const [formGuestEmail, setFormGuestEmail] = useState("");
  const [formWantsReminder, setFormWantsReminder] = useState(true);
  // Triggers a longer celebratory glow on the top event card right after
  // confirm. Kept separate from statusAnimating (1.5s, existing status pulse).
  const [justConfirmedGlow, setJustConfirmedGlow] = useState(false);

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
          if (data.isVip) setIsVip(true);
          // Bilateral chips are optional — server omits the key when the
          // guest isn't logged-in or hasn't connected a calendar.
          if (data.bilateralByDay && typeof data.bilateralByDay === "object") {
            setBilateralByDay(data.bilateralByDay as Record<string, TimeChipData[]>);
          }
        }
      })
      .catch(() => {});
  }, [sessionId]);

  // Hydrate TZ-banner dismissal from localStorage once we know the sessionId.
  // Keyed per session so dismissing on one deal room doesn't silence others.
  useEffect(() => {
    if (!sessionId || typeof window === "undefined") return;
    try {
      const key = `tz-banner-dismissed:${sessionId}`;
      if (window.localStorage.getItem(key) === "1") {
        setTzBannerDismissed(true);
      }
    } catch {
      // localStorage blocked (private mode on some browsers) — just skip,
      // the banner will be shown and that's fine.
    }
  }, [sessionId]);

  // Same hydration for the anon-calendar CTA dismissal (Slice 8).
  useEffect(() => {
    if (!sessionId || typeof window === "undefined") return;
    try {
      const key = `anon-cal-cta-dismissed:${sessionId}`;
      if (window.localStorage.getItem(key) === "1") {
        setAnonCalCtaDismissed(true);
      }
    } catch {
      /* ignore */
    }
  }, [sessionId]);

  // After OAuth returns with ?calendarConnected=true, refetch slots so the
  // bilateral chips surface. Strip the query param so a later reload doesn't
  // re-trigger the refresh.
  useEffect(() => {
    if (!sessionId || typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("calendarConnected") !== "true") return;
    fetch(`/api/negotiate/slots?sessionId=${sessionId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.slotsByDay) setSlotsByDay(data.slotsByDay);
        if (data?.bilateralByDay && typeof data.bilateralByDay === "object") {
          setBilateralByDay(data.bilateralByDay as Record<string, TimeChipData[]>);
        }
      })
      .catch(() => {})
      .finally(() => {
        url.searchParams.delete("calendarConnected");
        window.history.replaceState({}, "", url.pathname + url.search);
      });
  }, [sessionId]);

  // Fetch Google Calendar event status for confirmed meetings (host only).
  useEffect(() => {
    if (!sessionId || !isHost || !confirmed) return;
    fetch(`/api/negotiate/gcal-status?sessionId=${sessionId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (data) setGcalStatus(data); })
      .catch(() => {});
  }, [sessionId, isHost, confirmed]);

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

  // Resolve a slot click into a local pendingProposal. Uses session-scoped
  // defaults (linkFormat, linkLocation, slotDuration) so a guest's chip click
  // goes straight to a proposal card instead of round-tripping through Envoy.
  function proposeFromSlot(slot: { start: string; end: string }) {
    const startMs = new Date(slot.start).getTime();
    const endMs = new Date(slot.end).getTime();
    const durationFromRange = Math.max(15, Math.round((endMs - startMs) / 60000));
    // Prefer host-set meeting duration from link.rules (slotDuration); fall
    // back to the chip's own range if the link didn't specify one.
    const duration = slotDuration && slotDuration > 0 ? slotDuration : durationFromRange;
    const format = linkFormat || "video";
    setPendingProposal({
      dateTime: slot.start,
      duration,
      format,
      location: linkLocation,
    });
    // Collapse the form initially — one click to expand into name/email.
    setConfirmFormExpanded(false);
    setConfirmError(null);
    // Seed form inputs from whatever we know already.
    if (!formGuestName && (guestUser?.name || inviteeName)) {
      setFormGuestName(guestUser?.name || inviteeName);
    }
    if (!formGuestEmail && (guestUser?.email || guestEmail)) {
      setFormGuestEmail(guestUser?.email || guestEmail);
    }
  }

  async function handleConfirm(proposal: {
    dateTime: string;
    duration: number;
    format: string;
    location: string | null;
    timezone?: string;
  }, opts?: { guestName?: string; guestEmail?: string; wantsReminder?: boolean }) {
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
          guestName: opts?.guestName ?? formGuestName ?? undefined,
          guestEmail: opts?.guestEmail ?? formGuestEmail ?? guestEmail ?? undefined,
          wantsReminder: opts?.wantsReminder ?? formWantsReminder,
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
      setPendingProposal(null);
      setConfirmFormExpanded(false);
      // Celebratory glow on the top event card — stronger than the existing
      // 1.5s status pulse, runs 3s so users can see where to look.
      setJustConfirmedGlow(true);
      setTimeout(() => setJustConfirmedGlow(false), 3000);
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
            setArchivedData({ hostEmail: data.hostEmail, hostName: data.hostName, hostMeetSlug: data.hostMeetSlug ?? null });
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
        setIsGuest(data.isGuest || false);
        setGuestUser(data.guestUser || null);
        // TZ recovery banner: capture the session's stored guestTimezone so
        // we can compare against the browser's detected TZ. Null when no
        // visitor has posted a TZ yet.
        if (typeof data.sessionTimezone === "string" || data.sessionTimezone === null) {
          setSessionTimezone(data.sessionTimezone);
        }
        setTopic(data.link?.topic || "");
        setLinkFormat(data.link?.format || "");
        setLinkLocation(typeof data.link?.location === "string" && data.link.location.trim() ? data.link.location.trim() : null);
        setInviteeName(data.link?.inviteeName || "");
        // Pre-fill the confirm-card form from any info we already have so the
        // guest doesn't have to retype their name/email if Envoy captured it.
        if (data.session?.guestName && !formGuestName) setFormGuestName(data.session.guestName);
        else if (data.link?.inviteeName && !formGuestName) setFormGuestName(data.link.inviteeName);
        if (data.session?.guestEmail && !formGuestEmail) setFormGuestEmail(data.session.guestEmail);
        else if (data.link?.inviteeEmail && !formGuestEmail) setFormGuestEmail(data.link.inviteeEmail);
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
              data.messages.map((m: { id: string; role: string; content: string; metadata?: unknown; createdAt?: string }) => ({
                id: m.id,
                role: m.role,
                content: m.content,
                metadata: (m.metadata as Message["metadata"]) ?? null,
                createdAt: m.createdAt,
              }))
            );
          }
          return;
        }

        // If resuming an existing session, load full message history
        if (data.resumed && data.messages?.length > 0) {
          setMessages(
            data.messages.map((m: { id: string; role: string; content: string; metadata?: unknown; createdAt?: string }) => ({
              id: m.id,
              role: m.role,
              content: m.content,
              metadata: (m.metadata as Message["metadata"]) ?? null,
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

  // --- Meeting emoji picker ---
  // Priority: venue keyword (from location) > format (video/phone/in-person) > fallback.
  // Keep the list short + additive — overly specific matches create noise.
  function getMeetingEmoji(format: string | null | undefined, location: string | null | undefined): string {
    const loc = (location ?? "").toLowerCase();
    if (loc) {
      if (/\b(cafe|café|coffee|starbucks|blue bottle|philz|peets|peet's)\b/.test(loc)) return "☕";
      if (/\b(restaurant|bistro|dinner|lunch|brunch|grill|kitchen|tavern)\b/.test(loc)) return "🍽️";
      if (/\b(bar|pub|cocktail|lounge|brewery)\b/.test(loc)) return "🍸";
      if (/\b(park|garden|outdoor|trail|hike|hiking|walk)\b/.test(loc)) return "🌳";
      if (/\b(gym|fitness|yoga|studio)\b/.test(loc)) return "🏋️";
      if (/\b(airport|terminal|flight)\b/.test(loc)) return "✈️";
      if (/\b(hotel|lobby|lobbies|inn|suite)\b/.test(loc)) return "🏨";
      if (/\b(office|hq|headquarters|workspace|coworking|wework)\b/.test(loc)) return "🏢";
      if (/\b(home|house|my place|apartment|apt)\b/.test(loc)) return "🏠";
      // Zoom / Meet / Teams URLs land here when location is the meet link
      if (/\b(zoom\.us|meet\.google|teams\.microsoft|webex)\b/.test(loc)) return "📹";
    }
    if (format === "phone") return "📞";
    if (format === "video") return "📹";
    if (format === "in-person") return "🤝";
    return "📅";
  }

  // --- Archived state ---
  if (archivedData) {
    const hostFirst = archivedData.hostName?.split(" ")[0] || "the host";
    const genericUrl = archivedData.hostMeetSlug
      ? `/meet/${archivedData.hostMeetSlug}`
      : null;
    return (
      <div className="min-h-screen bg-surface flex flex-col">
        <PublicHeader />
        <div className="flex-1 flex items-center justify-center px-6 py-12">
          <div className="text-center max-w-md">
            <div className="w-16 h-16 mx-auto mb-5 rounded-full bg-surface-secondary border border-DEFAULT flex items-center justify-center">
              <svg className="w-7 h-7 text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5m8.25 3v6.75m0 0l-3-3m3 3l3-3M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z" />
              </svg>
            </div>
            <h1 className="text-xl font-bold text-primary mb-2">Meeting Unavailable</h1>
            <p className="text-sm text-muted mb-6">
              This meeting isn&rsquo;t available right now.
            </p>
            {genericUrl && (
              <div className="mb-6 p-5 rounded-xl bg-surface-secondary border border-DEFAULT text-left">
                <div className="text-[10px] font-bold uppercase tracking-wider text-indigo-400 mb-2">
                  Book time with {hostFirst}
                </div>
                <p className="text-sm text-secondary mb-4">
                  You can still set up a meeting using {hostFirst}&rsquo;s booking link.
                </p>
                <a
                  href={genericUrl}
                  className="block w-full text-center px-4 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-lg transition"
                >
                  Book a time with {hostFirst}
                </a>
              </div>
            )}
            {archivedData.hostEmail && (
              <p className="text-xs text-muted">
                Or email{" "}
                <a href={`mailto:${archivedData.hostEmail}`} className="text-indigo-400 hover:text-indigo-300">
                  {archivedData.hostEmail}
                </a>
                .
              </p>
            )}
          </div>
        </div>
      </div>
    );
  }

  // --- Error state ---
  if (error) {
    return (
      <div className="min-h-screen bg-surface flex flex-col">
        <PublicHeader />
        <div className="flex-1 flex items-center justify-center px-6 py-12">
          <div className="text-center">
            <div className="text-4xl mb-4">&#128533;</div>
            <h1 className="text-xl font-bold text-primary mb-2">Link not found</h1>
            <p className="text-muted">{error}</p>
          </div>
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
  // Determine the latest proposal from messages (for "Proposed" state). Local
  // pendingProposal (from a chip click) takes precedence so the top card
  // updates instantly even when Envoy hasn't been round-tripped.
  const latestProposal = (() => {
    if (pendingProposal) return pendingProposal;
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
    : latestProposal?.location ?? linkLocation ?? null;
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
      <div className={`max-w-3xl rounded-xl border ${statusConfig.border} bg-black/[0.02] dark:bg-white/[0.03] px-4 py-3 transition-all duration-700 ${
        justConfirmedGlow
          ? "ring-2 ring-emerald-400/60 bg-emerald-500/10 shadow-[0_0_24px_rgba(16,185,129,0.35)] scale-[1.01]"
          : statusAnimating
            ? "ring-1 " + (eventStatus === "confirmed" ? "ring-emerald-500/40 bg-emerald-500/5" : eventStatus === "cancelled" ? "ring-red-500/40 bg-red-500/5" : "ring-amber-500/40 bg-amber-500/5")
            : ""
      }`}>
        {/* Row 1: Title + status */}
        <div className="flex items-center gap-2.5 mb-1.5">
          <div className={`w-2.5 h-2.5 rounded-full ${statusConfig.dot} flex-shrink-0 transition-colors duration-500 ${statusAnimating ? "scale-125" : ""}`} style={statusAnimating ? { animation: "pulse 1s ease-in-out" } : {}} />
          <span className="text-sm font-semibold text-primary truncate">{getEventTitle()}</span>
          {isVip && <span className="text-[10px] text-amber-500/60 dark:text-amber-400/50 flex-shrink-0 select-none" title="Priority meeting">★</span>}
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
          {eventFormat && (() => {
            const formatEmoji = getMeetingEmoji(eventFormat, null);
            const formatText = eventFormat === "phone" ? "Phone" : eventFormat === "video" ? "Video" : eventFormat === "in-person" ? "In person" : eventFormat;
            return <span>{formatEmoji} {formatText} &middot; {eventDuration} min</span>;
          })()}
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
          {confirmed && (formGuestName || formGuestEmail) && (
            <span className="text-muted" title="Guest">
              👤 {[formGuestName, formGuestEmail].filter(Boolean).join(" · ")}
            </span>
          )}
          {eventMeetLink && (
            <a href={eventMeetLink} className="text-indigo-400 hover:text-indigo-300 truncate max-w-[200px]" target="_blank" rel="noopener noreferrer">
              {eventMeetLink.replace("https://", "").split("/").slice(0, 2).join("/")}
            </a>
          )}
          {eventLocation && (
            <span className="truncate max-w-[200px]" title={eventLocation}>
              {getMeetingEmoji(null, eventLocation)} {eventLocation}
            </span>
          )}
        </div>

        {/* Row 3: Actions (confirmed / cancelled only) */}
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


        {/* Host management row — Add participant (non-confirmed) + GCal status (confirmed) + Archive/Cancel */}
        {isHost && eventStatus !== "cancelled" && (
          <div className="ml-5 mt-2.5 flex items-center gap-3 flex-wrap">
            {/* Add participant / group-link toggle — non-confirmed only */}
            {!confirmed && (
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
                className={`text-[11px] transition ${isGroupEvent ? "text-muted cursor-default" : "text-indigo-400 hover:text-indigo-300"}`}
                disabled={isGroupEvent}
              >
                {isGroupEvent ? "Group link active — share link to add people" : "+ Add participant (make group link)"}
              </button>
            )}
            {/* Google Calendar status badge — only when confirmed */}
            {confirmed && gcalStatus && gcalStatus.eventExists && (
              <span className="flex items-center gap-1.5 text-[11px] text-muted">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 flex-shrink-0" />
                On Google Calendar
                {gcalStatus.guestOnInvite && gcalStatus.guestResponseStatus && (
                  <>
                    <span className="text-zinc-600 dark:text-zinc-700 mx-0.5">·</span>
                    <span className={
                      gcalStatus.guestResponseStatus === "accepted" ? "text-emerald-500" :
                      gcalStatus.guestResponseStatus === "declined" ? "text-red-400" :
                      "text-zinc-400"
                    }>
                      Guest {gcalStatus.guestResponseStatus === "accepted" ? "accepted" :
                             gcalStatus.guestResponseStatus === "declined" ? "declined" :
                             gcalStatus.guestResponseStatus === "tentative" ? "maybe" : "awaiting"}
                    </span>
                  </>
                )}
                {gcalStatus.guestOnInvite === false && (
                  <>
                    <span className="text-zinc-600 dark:text-zinc-700 mx-0.5">·</span>
                    <span className="text-amber-400">Guest not on invite</span>
                  </>
                )}
              </span>
            )}
            {confirmed && gcalStatus && !gcalStatus.eventExists && (
              <span className="flex items-center gap-1.5 text-[11px] text-zinc-500">
                <span className="w-1.5 h-1.5 rounded-full bg-zinc-600 flex-shrink-0" />
                Not found on Google Calendar
              </span>
            )}

            {/* Spacer to push buttons to the right when badge is present */}
            <span className="flex-1" />

            {/* Archive button — all non-cancelled sessions */}
            <button
              onClick={async () => {
                if (!sessionId || isArchiving) return;
                setIsArchiving(true);
                try {
                  await fetch("/api/negotiate/archive", {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ sessionId, archived: true }),
                  });
                  window.location.href = "/dashboard";
                } catch {
                  setIsArchiving(false);
                }
              }}
              disabled={isArchiving}
              className="text-[11px] text-zinc-500 hover:text-zinc-300 transition disabled:opacity-50"
            >
              {isArchiving ? "Archiving…" : "Archive"}
            </button>

            {/* Cancel button — confirmed sessions only */}
            {confirmed && (
              <button
                onClick={() => setShowCancelModal(true)}
                className="text-[11px] text-red-500/70 hover:text-red-400 transition"
              >
                Cancel meeting
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

  // --- Cancel confirm modal ---
  const cancelModal = showCancelModal ? (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => !isCancelling && setShowCancelModal(false)}>
      <div className="bg-surface-inset border border-DEFAULT rounded-2xl p-6 w-full max-w-sm mx-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-semibold text-primary mb-2">Cancel this meeting?</h3>
        <p className="text-xs text-secondary mb-1">This will:</p>
        <ul className="text-xs text-secondary space-y-1 mb-4 ml-3 list-disc">
          <li>Delete the Google Calendar event and notify all attendees</li>
          <li>Release any holds blocking your calendar</li>
          <li>Archive this deal room</li>
        </ul>
        <p className="text-xs text-zinc-500 mb-5">This can&apos;t be undone.</p>
        <div className="flex gap-2">
          <button
            onClick={() => setShowCancelModal(false)}
            disabled={isCancelling}
            className="flex-1 px-3 py-2 text-xs text-secondary border border-secondary rounded-lg hover:border-DEFAULT transition disabled:opacity-50"
          >
            Keep it
          </button>
          <button
            onClick={async () => {
              if (!sessionId || isCancelling) return;
              setIsCancelling(true);
              try {
                const res = await fetch("/api/negotiate/cancel", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ sessionId }),
                });
                if (res.ok) {
                  window.location.href = "/dashboard";
                } else {
                  const data = await res.json();
                  alert(data.error || "Cancel failed — please try again.");
                  setIsCancelling(false);
                  setShowCancelModal(false);
                }
              } catch {
                setIsCancelling(false);
                setShowCancelModal(false);
              }
            }}
            disabled={isCancelling}
            className="flex-1 px-3 py-2 text-xs font-medium bg-red-900/40 text-red-300 border border-red-500/30 rounded-lg hover:bg-red-900/60 hover:border-red-500/50 transition disabled:opacity-50"
          >
            {isCancelling ? "Cancelling…" : "Yes, cancel"}
          </button>
        </div>
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

            // Legacy "Meeting confirmed:" system messages — hidden.
            if (msg.role === "system" && /^Meeting confirmed:/i.test(msg.content)) {
              return null;
            }

            // Internal LLM-context system messages — never user-visible.
            // guest_calendar_snapshot is created by the guest-calendar OAuth
            // callback and is for the slots endpoint's bilateral compute, not
            // for display. Filter here so the raw [SYSTEM: ...] text never
            // appears in the chat bubble.
            if (msg.role === "system" && (msg.metadata as Record<string, unknown> | null)?.kind === "guest_calendar_snapshot") {
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
            const { proposal } = parsed;
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

            // 3-party model + guest Envoy advocate:
            //   host / guest (human) → right-aligned, filled color
            //   administrator (host-side facilitator) → left, neutral
            //   guest_envoy (guest advocate) → left, viewer-relative tinted
            //   system → left, emerald
            const rightAligned = msg.role === "host" || msg.role === "guest";

            // guest_envoy color follows team affiliation, viewer-relative:
            //   logged-in guest viewer  → blue (your team)
            //   host viewer             → purple (counterparty)
            //   anonymous (shouldn't fire) → neutral fallback
            const guestEnvoyStyle = isGuest
              ? "bg-blue-900/30 border border-blue-800 text-blue-100 rounded-bl-sm"
              : isHost
                ? "bg-purple-900/30 border border-purple-800 text-purple-100 rounded-bl-sm"
                : "bg-surface-secondary border border-DEFAULT text-primary rounded-bl-sm";
            const guestEnvoyLabelColor = isGuest
              ? "text-blue-300"
              : isHost
                ? "text-purple-300"
                : "text-emerald-400";

            const messageStyle =
              msg.role === "host"
                ? "bg-purple-600 text-white rounded-br-sm"
                : msg.role === "guest"
                  ? "bg-indigo-600 text-white rounded-br-sm"
                  : msg.role === "system"
                    ? "bg-emerald-900/30 border border-emerald-800 text-emerald-200 rounded-lg"
                    : msg.role === "guest_envoy"
                      ? guestEnvoyStyle
                      : "bg-surface-secondary border border-DEFAULT text-primary rounded-bl-sm";

            const guestEnvoyLabel = isGuest
              ? "Your Envoy"
              : guestUser?.name
                ? `${guestUser.name.split(" ")[0]}'s Envoy`
                : "Guest's Envoy";

            const senderLabel =
              msg.role === "host"
                ? hostName || "Host"
                : msg.role === "guest"
                  ? "Guest"
                  : msg.role === "administrator"
                    ? "Envoy"
                    : msg.role === "guest_envoy"
                      ? guestEnvoyLabel
                      : null;

            const labelColor =
              msg.role === "host"
                ? "text-white/60"
                : msg.role === "guest"
                  ? "text-white/60"
                  : msg.role === "guest_envoy"
                    ? guestEnvoyLabelColor
                    : "text-emerald-400";

            // Bilateral time chips render inline below the guest_envoy's
            // message — the greeting names a top pick and the chips let the
            // guest (or host watching) tap an alternative. Only surfaces when
            // server returned bilateralByDay data (guest is logged in + has
            // calendar connected). Show on the guest_envoy message that
            // immediately follows the host's greeting — i.e. the one with no
            // earlier guest_envoy message in the thread.
            const isFirstGuestEnvoy =
              msg.role === "guest_envoy" &&
              !messages.slice(0, idx).some((m) => m.role === "guest_envoy");
            const showChipsHere =
              isFirstGuestEnvoy && bilateralByDay && Object.keys(bilateralByDay).length > 0;

            // Slice 9 — proxy attribution badge. Server writes
            // metadata.delegateSpeaker when Envoy detects a proxy
            // (ai_agent, human_assistant, or unknown). Render a small
            // "via {name}" footer below the bubble so the host can
            // tell at a glance that the message came through a proxy.
            const delegateSpeaker = msg.metadata?.delegateSpeaker;
            const delegateBadge = delegateSpeaker ? (
              <div
                className={`text-[10px] mt-1 italic ${rightAligned ? "text-right text-white/60" : "text-muted"}`}
                data-testid="delegate-speaker-badge"
              >
                via {delegateSpeaker.name || (
                  delegateSpeaker.kind === "ai_agent"
                    ? "AI agent"
                    : delegateSpeaker.kind === "human_assistant"
                    ? "assistant"
                    : "proxy"
                )}
              </div>
            ) : null;

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
                    {delegateBadge}
                    {showChipsHere && bilateralByDay && (
                      <TimeChipList
                        bilateralByDay={bilateralByDay}
                        primaryTimezone={slotTimezone}
                        counterpartyTimezone={slotTimezone === "America/Los_Angeles" ? undefined : "America/Los_Angeles"}
                        onSelectSlot={({ start, end, color }) => {
                          // "both" chips are available on both calendars →
                          // skip the Envoy round-trip and pop the confirm card.
                          // Other colors (guest-only, near-miss) still route
                          // through chat so Envoy can negotiate the gap.
                          if (color === "both" && !confirmed) {
                            proposeFromSlot({ start, end });
                            return;
                          }
                          const d = new Date(start);
                          const day = d.toLocaleDateString("en-US", {
                            weekday: "long",
                            month: "short",
                            day: "numeric",
                            timeZone: slotTimezone,
                          });
                          const time = d.toLocaleTimeString("en-US", {
                            hour: "numeric",
                            minute: "2-digit",
                            timeZone: slotTimezone,
                          });
                          const hostFirst = hostName ? hostName.split(" ")[0] : "you";
                          const template = `Any chance ${day} at ${time} could work for ${hostFirst}? It's close — let me know if we can make it happen.`;
                          setInput(template);
                          document.querySelector<HTMLTextAreaElement>("textarea")?.focus();
                        }}
                      />
                    )}
                  </div>
                </div>

                {/* Per-message proposal/confirmed cards removed 2026-04-17.
                    The proposal + confirm form lives in a standalone block
                    below the messages list so there's exactly one card and
                    it's anchored near the composer, not buried mid-scroll. */}
              </div>
            );
          })
        )}

        {/* Single proposal + confirm card (direct-confirm flow, 2026-04-17).
            Reads local pendingProposal first (set on chip click) then falls
            back to Envoy's most recent CONFIRMATION_PROPOSAL message. Shows
            only when there's something to confirm and the session isn't
            already agreed. */}
        {!confirmed && !isHost && latestProposal && (() => {
          const effective = latestProposal;
          const dt = new Date(effective.dateTime);
          const inPast = dt.getTime() <= Date.now();
          const nameOk = formGuestName.trim().length > 0;
          const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formGuestEmail.trim());
          const canSubmit = !inPast && nameOk && emailOk;
          const clickConfirmButton = () => {
            if (!confirmFormExpanded) {
              setConfirmFormExpanded(true);
              return;
            }
            if (!canSubmit) return;
            handleConfirm(
              { dateTime: effective.dateTime, duration: effective.duration, format: effective.format, location: effective.location },
              { guestName: formGuestName.trim(), guestEmail: formGuestEmail.trim(), wantsReminder: formWantsReminder }
            );
          };
          return (
            <div className="flex justify-start">
              <div className="max-w-[85%] bg-emerald-900/20 border border-emerald-700/50 rounded-xl p-4 space-y-3">
                <div className="text-[10px] font-bold uppercase tracking-wider text-emerald-400">
                  {pendingProposal ? "Your pick" : "Proposed meeting"}
                </div>
                <div className="space-y-1 text-sm text-primary">
                  <p>&#128197; {dt.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: slotTimezone })}</p>
                  <p>&#128336; {dt.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZoneName: "short", timeZone: slotTimezone })} ({effective.duration} min)</p>
                  <p>&#128241; {effective.format.charAt(0).toUpperCase() + effective.format.slice(1)}</p>
                  {effective.location && <p>&#128205; {effective.location}</p>}
                </div>
                {inPast && (
                  <p className="text-xs text-amber-400">This time is in the past. Pick another from the calendar.</p>
                )}
                {confirmFormExpanded && (
                  <div className="space-y-2 pt-2 border-t border-emerald-700/30">
                    <div>
                      <label className="block text-[10px] font-semibold uppercase tracking-wider text-emerald-400 mb-1">Your name</label>
                      <input
                        type="text"
                        value={formGuestName}
                        onChange={(e) => setFormGuestName(e.target.value)}
                        autoComplete="name"
                        className="w-full px-3 py-2 bg-surface border border-DEFAULT rounded-md text-sm text-primary placeholder:text-muted focus:outline-none focus:border-emerald-500"
                        placeholder="Jane Doe"
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] font-semibold uppercase tracking-wider text-emerald-400 mb-1">Your email</label>
                      <input
                        type="email"
                        value={formGuestEmail}
                        onChange={(e) => setFormGuestEmail(e.target.value)}
                        autoComplete="email"
                        className="w-full px-3 py-2 bg-surface border border-DEFAULT rounded-md text-sm text-primary placeholder:text-muted focus:outline-none focus:border-emerald-500"
                        placeholder="jane@example.com"
                      />
                    </div>
                    <label className="flex items-start gap-2 pt-1 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={formWantsReminder}
                        onChange={(e) => setFormWantsReminder(e.target.checked)}
                        className="mt-0.5 h-4 w-4 accent-emerald-500"
                      />
                      <span className="text-xs text-secondary">Send me a reminder email before the meeting</span>
                    </label>
                  </div>
                )}
                <button
                  onClick={clickConfirmButton}
                  disabled={isConfirming || inPast || (confirmFormExpanded && !canSubmit)}
                  className="w-full mt-2 px-4 py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition"
                >
                  {isConfirming ? "Confirming..." : confirmFormExpanded ? "Confirm" : "Confirm this time"}
                </button>
                <button
                  onClick={() => {
                    if (pendingProposal) {
                      setPendingProposal(null);
                      setConfirmFormExpanded(false);
                    } else {
                      setInput("That\u2019s close, but could we ");
                      document.querySelector<HTMLTextAreaElement>("textarea")?.focus();
                    }
                  }}
                  className="w-full text-center text-xs text-muted hover:text-secondary transition mt-1"
                >
                  {pendingProposal ? "Pick a different time" : "Suggest a change"}
                </button>
                {confirmError && (
                  <p className="mt-2 text-xs text-red-400">{confirmError}</p>
                )}
                {emailWarning && (
                  <p className="mt-2 text-xs text-amber-400">{emailWarning}</p>
                )}
              </div>
            </div>
          );
        })()}

        {/* Post-confirm signup upsell (client-only, not persisted) */}
        {confirmed && !isHost && !isGuest && !signupUpsellDismissed && (
          <div className="flex justify-start">
            <div className="max-w-[85%] bg-surface-secondary border border-DEFAULT text-primary rounded-bl-sm rounded-2xl px-4 py-3 space-y-3">
              <div>
                <div className="text-[10px] font-bold uppercase tracking-wider text-emerald-400 mb-1">Envoy</div>
                <div className="text-sm leading-relaxed">
                  Great news &mdash; we&rsquo;ve locked in a time! 🎉
                </div>
              </div>
              <div className="text-sm text-secondary">
                Want your own AI scheduling negotiator? Get instant meeting summaries, one-click rescheduling, and calendar sync — all automated for you.
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setShowSignupModal(true)}
                  className="flex-1 px-3 py-2 text-xs font-medium bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg transition text-center"
                >
                  Create free account
                </button>
              </div>
            </div>
          </div>
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
      {/* Header — three branches:
            host              → full dashboard chrome
            logged-in guest   → their name + link back to their dashboard
            anonymous guest   → minimal brand bar with "Sign in" that returns to this deal room */}
      {isHost ? (
        <DashboardHeader />
      ) : isGuest ? (
        <header className="border-b border-secondary px-6 py-3 flex items-center justify-between flex-shrink-0">
          <a href="/">
            <LogoFull height={24} className="text-primary" />
          </a>
          <div className="flex items-center gap-3">
            {guestUser?.name && (
              <span className="text-xs text-secondary" data-testid="guest-name">
                {guestUser.name}
              </span>
            )}
            <a
              href="/dashboard"
              className="text-xs text-muted hover:text-primary transition"
              data-testid="guest-dashboard-link"
            >
              My Dashboard
            </a>
          </div>
        </header>
      ) : (
        <header className="border-b border-secondary px-6 py-3 flex items-center justify-between flex-shrink-0">
          <a href="/">
            <LogoFull height={24} className="text-primary" />
          </a>
          <a
            href={`/api/auth/signin?callbackUrl=${encodeURIComponent(`/meet/${slug}${code ? `/${code}` : ""}`)}`}
            className="text-xs text-muted hover:text-primary transition"
            data-testid="anonymous-signin-link"
          >
            Sign in
          </a>
        </header>
      )}

      {/* Main area — chat + sidebar on desktop */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Chat column — event card + messages */}
        <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
          {/* Desktop centered wrapper for left-side content */}
          <div className="flex-1 min-h-0 overflow-hidden flex flex-col md:max-w-[640px] md:mx-auto md:w-full">
            {/* Event card — sticky inside chat column */}
            {eventCard}

          {/* TZ recovery banner — appears when someone raced ahead of this
              human guest and the session's primary TZ differs from their
              browser TZ. Silent when they match or the banner was dismissed.
              Hidden once the meeting is confirmed. */}
          {(() => {
            if (confirmed) return null;
            if (tzBannerDismissed) return null;
            if (!sessionId || !sessionTimezone) return null;
            if (typeof window === "undefined") return null;
            let browserTz = "";
            try {
              browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
            } catch {
              return null;
            }
            if (!browserTz || browserTz === sessionTimezone) return null;

            const prettyTz = (tz: string) =>
              tz.split("/").pop()?.replace(/_/g, " ") ?? tz;

            const dismiss = () => {
              setTzBannerDismissed(true);
              try {
                window.localStorage.setItem(`tz-banner-dismissed:${sessionId}`, "1");
              } catch {
                /* ignore — state already dismissed */
              }
            };

            const switchTz = async () => {
              setIsSwitchingTz(true);
              try {
                const res = await fetch("/api/negotiate/session/timezone", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ sessionId, timezone: browserTz }),
                });
                if (res.ok) {
                  const body = await res.json();
                  if (typeof body?.sessionTimezone === "string") {
                    setSessionTimezone(body.sessionTimezone);
                    setSlotTimezone(body.sessionTimezone);
                  }
                  // Re-fetch slots so bilateral chips render with the new TZ
                  // (ISO datetimes are TZ-agnostic; labels flip on re-render).
                  fetch(`/api/negotiate/slots?sessionId=${sessionId}`)
                    .then((r) => (r.ok ? r.json() : null))
                    .then((data) => {
                      if (data?.slotsByDay) setSlotsByDay(data.slotsByDay);
                      if (data?.bilateralByDay && typeof data.bilateralByDay === "object") {
                        setBilateralByDay(data.bilateralByDay as Record<string, TimeChipData[]>);
                      }
                    })
                    .catch(() => {});
                  dismiss();
                }
              } catch {
                /* soft fail — leave banner visible so user can retry */
              } finally {
                setIsSwitchingTz(false);
              }
            };

            return (
              <div
                className="border-b border-amber-800/40 bg-amber-900/10 px-4 py-2.5 flex items-center gap-3 text-sm flex-shrink-0"
                data-testid="tz-recovery-banner"
              >
                <span role="img" aria-label="clock">🕐</span>
                <span className="flex-1 text-amber-100/90">
                  Looks like you&apos;re in <strong>{prettyTz(browserTz)}</strong>.
                  This thread is currently in <strong>{prettyTz(sessionTimezone)}</strong>.
                </span>
                <button
                  type="button"
                  onClick={switchTz}
                  disabled={isSwitchingTz}
                  className="px-3 py-1 rounded-md text-xs font-medium bg-amber-500/80 hover:bg-amber-500 text-amber-950 transition disabled:opacity-50"
                >
                  {isSwitchingTz ? "Switching…" : `Switch to ${prettyTz(browserTz)}`}
                </button>
                <button
                  type="button"
                  onClick={dismiss}
                  className="px-3 py-1 rounded-md text-xs font-medium text-amber-200 hover:text-amber-100 hover:bg-amber-900/20 transition"
                  aria-label="Keep current timezone"
                >
                  Keep {prettyTz(sessionTimezone)}
                </button>
              </div>
            );
          })()}

          {/* Concept B: Mobile calendar hero with inline chip CTA */}
          {slotsByDay && Object.keys(slotsByDay).length > 0 && (
            <div className="md:hidden border-b border-secondary flex-shrink-0 px-4 py-3 max-h-[50vh] overflow-y-auto">
              <AvailabilityCalendar
                view="week"
                slotsByDay={slotsByDay || {}}
                timezone={slotTimezone}
                currentLocation={slotLocation}
                duration={slotDuration}
                minDuration={slotMinDuration}
                onSelectSlot={!isHost && !confirmed ? (_msg, slot) => {
                  if (slot) proposeFromSlot(slot);
                } : undefined}
                onTimezoneClick={() => {
                  setInput("I\u2019m actually in a different timezone \u2014 ");
                  document.querySelector<HTMLTextAreaElement>("textarea")?.focus();
                }}
                headerSlot={(() => {
                  if (isHost) return null;
                  if (isGuest) return null; // signed-in guests use their NextAuth calendar connection
                  if (confirmed) return null;
                  if (anonCalCtaDismissed) return null;
                  if (!sessionId) return null;
                  if (bilateralByDay && Object.keys(bilateralByDay).length > 0) return null;

                  const connect = () => {
                    const returnUrl = `/meet/${slug}${code ? `/${code}` : ""}`;
                    window.location.href = `/api/auth/guest-calendar?sessionId=${encodeURIComponent(sessionId)}&returnUrl=${encodeURIComponent(returnUrl)}`;
                  };

                  if (!chipCtaExpanded) {
                    return (
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setChipCtaExpanded(true)}
                          className="flex-1 px-2 py-1.5 rounded-md text-xs font-semibold bg-blue-500/90 hover:bg-blue-500 text-white transition"
                        >
                          🗓️ Auto-match calendars
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setAnonCalCtaDismissed(true);
                            try {
                              if (typeof window !== "undefined") {
                                window.localStorage.setItem(`anon-cal-cta-dismissed:${sessionId}`, "1");
                              }
                            } catch { /* ignore */ }
                          }}
                          className="text-muted hover:text-secondary transition text-xs"
                          title="Dismiss"
                        >
                          ✕
                        </button>
                      </div>
                    );
                  }

                  return (
                    <div className="mb-3 p-3 rounded-lg bg-blue-900/20 border border-blue-800/40 space-y-2">
                      <div className="text-xs font-medium text-blue-200">
                        Want me to find the best time automatically?
                      </div>
                      <p className="text-xs text-secondary leading-snug">
                        Connect your calendar (read-only, ~5 seconds). I&apos;ll show you times that work for both of you.
                      </p>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={connect}
                          className="flex-1 px-2 py-1.5 rounded-md text-xs font-semibold bg-blue-500 hover:bg-blue-600 text-white transition"
                        >
                          Connect
                        </button>
                        <button
                          type="button"
                          onClick={() => setChipCtaExpanded(false)}
                          className="flex-1 px-2 py-1.5 rounded-md text-xs font-medium text-secondary border border-secondary hover:border-DEFAULT transition"
                        >
                          Not now
                        </button>
                      </div>
                    </div>
                  );
                })()}
              />
            </div>
          )}
            {chatContent}
          </div>
        </div>

        {/* Availability sidebar — desktop only */}
        <div className="hidden md:flex w-80 flex-shrink-0 border-l border-secondary p-5 overflow-y-auto flex-col">
          <h4 className="text-[11px] font-bold uppercase tracking-widest text-muted mb-3">
            {hostName ? `${hostName.split(" ")[0]}'s Availability` : "Availability"}
            {slotTimezone && (() => {
              const abbr = new Intl.DateTimeFormat("en-US", { timeZone: slotTimezone, timeZoneName: "short" })
                .formatToParts(new Date())
                .find((p) => p.type === "timeZoneName")?.value;
              return abbr ? `, ${abbr}` : "";
            })()}
          </h4>
          <AvailabilityCalendar
            slotsByDay={slotsByDay || {}}
            timezone={slotTimezone}
            currentLocation={slotLocation}
            duration={slotDuration}
            minDuration={slotMinDuration}
            onSelectSlot={!isHost && !confirmed ? (_msg, slot) => {
              if (slot) proposeFromSlot(slot);
            } : undefined}
            onTimezoneClick={() => {
              setInput("I\u2019m actually in a different timezone \u2014 ");
              document.querySelector<HTMLTextAreaElement>("textarea")?.focus();
            }}
            headerSlot={(() => {
              if (isHost || isGuest || confirmed || anonCalCtaDismissed || !sessionId) return null;
              if (bilateralByDay && Object.keys(bilateralByDay).length > 0) return null;

              const connect = () => {
                if (typeof window === "undefined") return;
                const returnUrl = `/meet/${slug}${code ? `/${code}` : ""}`;
                window.location.href = `/api/auth/guest-calendar?sessionId=${encodeURIComponent(sessionId)}&returnUrl=${encodeURIComponent(returnUrl)}`;
              };

              if (!chipCtaExpanded) {
                return (
                  <div className="flex items-center gap-2 mb-1">
                    <button
                      type="button"
                      onClick={() => setChipCtaExpanded(true)}
                      className="flex-1 px-2 py-1.5 rounded-md text-xs font-semibold bg-blue-500/90 hover:bg-blue-500 text-white transition"
                    >
                      🗓️ Auto-match calendars
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setAnonCalCtaDismissed(true);
                        try { window.localStorage.setItem(`anon-cal-cta-dismissed:${sessionId}`, "1"); } catch { /* ignore */ }
                      }}
                      className="text-muted hover:text-secondary transition text-xs"
                      title="Dismiss"
                    >
                      ✕
                    </button>
                  </div>
                );
              }

              return (
                <div className="mb-3 p-3 rounded-lg bg-blue-900/20 border border-blue-800/40 space-y-2">
                  <div className="text-xs font-medium text-blue-200">Find the best time automatically?</div>
                  <p className="text-xs text-secondary leading-snug">
                    Connect your calendar (read-only, ~5 seconds) to see times that work for both of you.
                  </p>
                  <div className="flex gap-2">
                    <button type="button" onClick={connect} className="flex-1 px-2 py-1.5 rounded-md text-xs font-semibold bg-blue-500 hover:bg-blue-600 text-white transition">
                      Connect
                    </button>
                    <button type="button" onClick={() => setChipCtaExpanded(false)} className="flex-1 px-2 py-1.5 rounded-md text-xs font-medium text-secondary border border-secondary hover:border-DEFAULT transition">
                      Not now
                    </button>
                  </div>
                </div>
              );
            })()}
          />
        </div>
      </div>

      {/* Details modal */}
      {detailsModal}
      {/* Cancel modal */}
      {cancelModal}
      {/* Signup intro modal — opens from the post-confirm upsell's CTA.
          Plain-text walkthrough so guests know what "create free account"
          actually does before being bounced to Google. */}
      {showSignupModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
          onClick={() => setShowSignupModal(false)}
        >
          <div
            className="relative max-w-md w-full bg-surface border border-DEFAULT rounded-2xl p-6 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => setShowSignupModal(false)}
              aria-label="Close"
              className="absolute top-3 right-3 text-muted hover:text-primary transition"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
            <div className="text-[10px] font-bold uppercase tracking-wider text-indigo-400">
              Your own AI scheduler
            </div>
            <h2 className="text-xl font-semibold text-primary leading-tight">
              Let Envoy run point on your calendar, too.
            </h2>
            <ol className="space-y-2.5 text-sm text-secondary">
              <li className="flex gap-3">
                <span className="flex-shrink-0 w-6 h-6 rounded-full bg-indigo-500/15 text-indigo-400 text-xs font-semibold flex items-center justify-center">1</span>
                <span>Sign in with Google — we never see your password.</span>
              </li>
              <li className="flex gap-3">
                <span className="flex-shrink-0 w-6 h-6 rounded-full bg-indigo-500/15 text-indigo-400 text-xs font-semibold flex items-center justify-center">2</span>
                <span>Connect your calendar so Envoy knows when you&rsquo;re really free.</span>
              </li>
              <li className="flex gap-3">
                <span className="flex-shrink-0 w-6 h-6 rounded-full bg-indigo-500/15 text-indigo-400 text-xs font-semibold flex items-center justify-center">3</span>
                <span>Share your own link &mdash; Envoy handles the back-and-forth.</span>
              </li>
            </ol>
            <a
              href={`/api/auth/signin?callbackUrl=${encodeURIComponent(
                typeof window !== "undefined" ? window.location.pathname + window.location.search : "/"
              )}`}
              className="block w-full text-center px-4 py-3 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold rounded-lg transition"
            >
              Connect with Google to begin
            </a>
            <button
              type="button"
              onClick={() => {
                setSignupUpsellDismissed(true);
                setShowSignupModal(false);
              }}
              className="block w-full text-center text-xs text-muted hover:text-secondary transition"
            >
              Not now
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
