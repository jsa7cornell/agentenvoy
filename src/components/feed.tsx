"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import ThreadCard from "./thread-card";
import { computeThreadStatus, computeGroupThreadStatus } from "@/lib/thread-status";

interface ChannelMsg {
  id: string;
  role: string; // "user" | "envoy" | "system"
  content: string;
  threadId?: string | null;
  createdAt: string;
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
    link: {
      inviteeName?: string;
      inviteeEmail?: string;
      topic?: string;
      code?: string;
      slug: string;
      mode?: string;
    };
    _count: { messages: number };
  } | null;
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
        className="px-3 py-1 bg-purple-600 hover:bg-purple-500 text-white text-xs font-medium rounded-md transition flex-shrink-0"
      >
        {copied ? "Copied!" : "Copy link"}
      </button>
    </div>
  );
}

export default function Feed() {
  const router = useRouter();
  const [messages, setMessages] = useState<ChannelMsg[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [calendarConnected, setCalendarConnected] = useState(true); // default true to avoid flash
  const [isCalibrated, setIsCalibrated] = useState(true); // default true to avoid flash
  const [welcomeDismissed, setWelcomeDismissed] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const hasLoadedRef = useRef(false);

  // Load channel history
  useEffect(() => {
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
        hasLoadedRef.current = true;
      }
    }
    loadMessages();
  }, []);

  // Scroll feed container to bottom (without affecting page scroll)
  const prevMessageCount = useRef(0);
  useEffect(() => {
    if (messages.length === 0) return;
    const container = scrollContainerRef.current;
    if (!container) return;
    if (prevMessageCount.current === 0) {
      // Initial load — jump to bottom instantly
      container.scrollTop = container.scrollHeight;
    } else if (messages.length > prevMessageCount.current) {
      // New message — smooth scroll
      container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
    }
    prevMessageCount.current = messages.length;
  }, [messages]);

  // Auto-resize textarea
  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    const el = e.target;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 120) + "px";
  }, []);

  // Navigate to deal room
  function navigateToThread(thread: NonNullable<ChannelMsg["thread"]>) {
    const url = thread.link.code
      ? `/meet/${thread.link.slug}/${thread.link.code}`
      : `/meet/${thread.link.slug}`;
    router.push(url);
  }

  // Archive a thread
  async function handleArchive(sessionId: string) {
    try {
      await fetch("/api/negotiate/archive", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, archived: true }),
      });
      // Refresh messages to remove archived thread
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
  const handleSend = async () => {
    const text = input.trim();
    if (!text || loading) return;

    // Host directive: :: prefix — global, shapes all future negotiations
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
        body: JSON.stringify({ message: text }),
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
        const envoyContent = data.shareNote
          ? `${data.message}\n\n${data.shareNote}`
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
        const responseText = await res.text();
        let content = responseText;
        try {
          const lines = responseText.split("\n").filter(Boolean);
          const parsed = lines.map((line) => {
            if (line.startsWith("0:")) {
              return JSON.parse(line.slice(2));
            }
            return line;
          });
          content = parsed.join("");
        } catch {}

        const displayContent = content
          .replace(/```agentenvoy-action\s*\n?[\s\S]*?\n?```/g, "")
          .replace(/\s*\[ACTION\].*?\[\/ACTION\]\s*/g, "")
          .trim();

        const envoyMsg: ChannelMsg = {
          id: `temp-envoy-${Date.now()}`,
          role: "envoy",
          content: displayContent || content,
          createdAt: new Date().toISOString(),
        };
        setMessages((prev) => [...prev, envoyMsg]);
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
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

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
    <div className="flex flex-col h-full">
      {/* Messages */}
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto px-4 sm:px-6 py-5 flex flex-col gap-1.5">
        {/* Fallback banner for uncalibrated users who somehow bypassed onboarding */}
        {!isCalibrated && !welcomeDismissed && messages.length === 0 && (
          <div className="mx-auto max-w-md bg-purple-500/10 border border-purple-500/20 rounded-xl p-4 mb-4">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-sm font-medium text-primary">Finish setting up your Envoy</p>
                <p className="text-xs text-secondary mt-1">
                  Complete the quick setup to configure your availability and start scheduling.
                </p>
                <a
                  href="/onboarding"
                  className="inline-block mt-2 px-3 py-1.5 bg-purple-600 hover:bg-purple-500 text-white text-xs font-medium rounded-lg transition"
                >
                  Continue setup
                </a>
              </div>
              <button
                onClick={() => setWelcomeDismissed(true)}
                className="text-muted hover:text-primary text-lg leading-none flex-shrink-0"
              >
                &times;
              </button>
            </div>
          </div>
        )}

        {/* Empty state with example prompts */}
        {messages.length === 0 && !loading && (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center space-y-4 max-w-sm">
              <p className="text-sm text-muted">Envoy manages your scheduling. Tell it who to meet with.</p>
              <div className="flex flex-col gap-2">
                {[
                  "Schedule 30 min with Sarah next week",
                  "Set up a video call with Nathan about the project",
                  "I\u2019m never available before 9am",
                ].map((example) => (
                  <button
                    key={example}
                    onClick={() => {
                      setInput(example);
                      textareaRef.current?.focus();
                    }}
                    className="text-left text-xs text-purple-400 hover:text-purple-300 bg-purple-500/5 hover:bg-purple-500/10 border border-purple-500/10 rounded-lg px-3 py-2 transition"
                  >
                    &ldquo;{example}&rdquo;
                  </button>
                ))}
              </div>
            </div>
          </div>
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
              <ThreadCard
                key={msg.id}
                title={msg.thread.title || "Thread"}
                statusLabel={msg.thread.statusLabel || status.label}
                statusColor={status.color}
                subtitle={[
                  msg.thread.format === "phone" ? "Phone call" : msg.thread.format === "video" ? "Video" : msg.thread.format,
                  msg.thread.duration ? `${msg.thread.duration} min` : null,
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
              />
            );
          }

          // System message
          if (msg.role === "system") {
            return (
              <div key={msg.id} className="text-center text-xs text-muted py-2">
                {msg.content}
              </div>
            );
          }

          // Chat bubble
          const isUser = msg.role === "user";
          // Detect meet links in envoy messages for success card
          const meetLinkMatch = !isUser ? msg.content.match(/(https?:\/\/[^\s]+\/meet\/[^\s]+)/) : null;
          return (
            <div
              key={msg.id}
              className={`max-w-[72%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                isUser
                  ? "self-end bg-purple-600 text-white rounded-br-sm"
                  : "self-start bg-black/5 dark:bg-white/7 rounded-bl-sm"
              }`}
            >
              <div
                className={`text-[10px] font-semibold uppercase tracking-wide mb-1 ${
                  isUser ? "text-white/60" : "text-purple-400"
                }`}
              >
                {isUser ? "You" : "Envoy"}
              </div>
              <div className="whitespace-pre-wrap">{msg.content}</div>
              {meetLinkMatch && <MeetLinkCard url={meetLinkMatch[1]} />}
            </div>
          );
        })}

        {/* Typing indicator */}
        {loading && (
          <div className="self-start bg-black/5 dark:bg-white/7 rounded-2xl rounded-bl-sm px-4 py-3 flex items-center gap-1">
            <div className="w-1.5 h-1.5 rounded-full bg-muted animate-bounce" style={{ animationDelay: "0ms" }} />
            <div className="w-1.5 h-1.5 rounded-full bg-muted animate-bounce" style={{ animationDelay: "150ms" }} />
            <div className="w-1.5 h-1.5 rounded-full bg-muted animate-bounce" style={{ animationDelay: "300ms" }} />
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input — or calendar connection gate */}
      <div className="px-4 sm:px-6 py-4 border-t border-black/5 dark:border-white/5 flex-shrink-0">
        {!calendarConnected ? (
          <div className="flex items-center gap-3 bg-amber-500/10 border border-amber-500/20 rounded-xl px-4 py-3">
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
        ) : (
          <div className="flex gap-2 items-end">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              placeholder="Tell Envoy what to schedule..."
              rows={1}
              className="flex-1 bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 rounded-xl px-4 py-3 text-sm text-primary placeholder-muted resize-none outline-none focus:border-purple-500/50 min-h-[44px] max-h-[120px]"
            />
            <button
              onClick={handleSend}
              disabled={!input.trim() || loading}
              className="w-11 h-11 rounded-xl bg-purple-600 text-white flex items-center justify-center flex-shrink-0 hover:bg-purple-700 transition-colors disabled:opacity-30 disabled:cursor-default text-lg"
            >
              &uarr;
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
