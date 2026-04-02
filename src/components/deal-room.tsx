"use client";

import { useState, useRef, useEffect } from "react";

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
  const [hostName, setInitiatorName] = useState("");
  const [topic, setTopic] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [confirmData, setConfirmData] = useState<Record<string, unknown> | null>(null);
  const [isConfirming, setIsConfirming] = useState(false);
  const [calendarConnected, setCalendarConnected] = useState(false);
  const [showAgentInfo, setShowAgentInfo] = useState(false);
  const [feedbackText, setFeedbackText] = useState("");
  const [feedbackSent, setFeedbackSent] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);


  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  function parseConfirmationProposal(content: string): {
    text: string;
    proposal: { dateTime: string; duration: number; format: string; location: string | null } | null;
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
    // Guest-specific OAuth with read-only calendar scope
    const returnUrl = code ? `/meet/${slug}/${code}` : `/meet/${slug}`;
    window.location.href = `/api/auth/guest-calendar?sessionId=${sessionId}&returnUrl=${encodeURIComponent(returnUrl)}`;
  }

  function handleConnectAgent() {
    setShowAgentInfo((prev) => !prev);
  }

  // Detect guest calendar connect via URL param (returned from guest OAuth flow)
  const calendarCheckDone = useRef(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("calendarConnected") === "true" && sessionId && !calendarConnected && !calendarCheckDone.current) {
      calendarCheckDone.current = true;
      setCalendarConnected(true);
      // Clean up URL param
      const url = new URL(window.location.href);
      url.searchParams.delete("calendarConnected");
      window.history.replaceState({}, "", url.pathname);
      // Ask the agent to re-evaluate with guest availability now injected
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
  }, [sessionId, calendarConnected]);

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
          setError(data.error || "Failed to start session");
          setIsLoading(false);
          return;
        }

        const data = await res.json();
        setSessionId(data.sessionId);
        setInitiatorName(data.host?.name || "");
        setTopic(data.link?.topic || "");
        setMessages([
          {
            id: "greeting",
            role: "administrator",
            content: data.greeting,
          },
        ]);
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

    const userMsg: Message = {
      id: Date.now().toString(),
      role: "guest",
      content: input.trim(),
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

  if (error) {
    return (
      <div className="min-h-screen bg-[#0a0a0f] flex items-center justify-center">
        <div className="text-center">
          <div className="text-4xl mb-4">😕</div>
          <h1 className="text-xl font-bold text-zinc-100 mb-2">
            Link not found
          </h1>
          <p className="text-zinc-500">{error}</p>
        </div>
      </div>
    );
  }

  if (confirmed && confirmData) {
    return (
      <div className="min-h-screen bg-[#0a0a0f] flex items-center justify-center">
        <div className="text-center max-w-md">
          <div className="w-20 h-20 mx-auto mb-6 rounded-full bg-gradient-to-br from-emerald-400 to-emerald-500 flex items-center justify-center text-4xl shadow-lg shadow-emerald-500/20">
            ✓
          </div>
          <h1 className="text-2xl font-bold text-zinc-100 mb-4">
            Meeting Confirmed
          </h1>
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 text-left space-y-3">
            {topic && (
              <p className="text-sm font-semibold text-zinc-100">{topic}</p>
            )}
            <p className="text-sm text-zinc-400">
              📅{" "}
              {new Date(confirmData.dateTime as string).toLocaleDateString(
                "en-US",
                {
                  weekday: "long",
                  month: "long",
                  day: "numeric",
                }
              )}
            </p>
            <p className="text-sm text-zinc-400">
              🕐{" "}
              {new Date(confirmData.dateTime as string).toLocaleTimeString(
                "en-US",
                { hour: "numeric", minute: "2-digit" }
              )}{" "}
              ({String(confirmData.duration)} min)
            </p>
            <p className="text-sm text-zinc-400">
              📱 {String(confirmData.format).charAt(0).toUpperCase() + String(confirmData.format).slice(1)}
            </p>
            {typeof confirmData.meetLink === "string" && (
              <a
                href={confirmData.meetLink as string}
                className="inline-block text-sm text-indigo-400 hover:text-indigo-300 font-medium"
                target="_blank"
                rel="noopener noreferrer"
              >
                Join Google Meet →
              </a>
            )}
          </div>
          {/* Feedback */}
          <div className="mt-6 p-4 border border-zinc-700 bg-zinc-900 rounded-xl text-left">
            {feedbackSent ? (
              <p className="text-sm text-zinc-400">Thanks for your feedback!</p>
            ) : (
              <>
                <label className="text-sm font-medium text-zinc-300 block mb-2">
                  Anything you'd like to share? Your feedback helps us improve.
                </label>
                <textarea
                  value={feedbackText}
                  onChange={(e) => setFeedbackText(e.target.value)}
                  placeholder="Optional — tell us how this went..."
                  rows={2}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 resize-none outline-none focus:border-indigo-500 transition"
                />
                {feedbackText.trim() && (
                  <button
                    onClick={async () => {
                      if (!sessionId || !feedbackText.trim()) return;
                      try {
                        await fetch("/api/negotiate/confirm", {
                          method: "PATCH",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ sessionId, feedback: feedbackText.trim() }),
                        });
                        setFeedbackSent(true);
                      } catch {}
                    }}
                    className="mt-2 px-3 py-1.5 bg-zinc-700 hover:bg-zinc-600 text-zinc-200 text-xs rounded-lg font-medium transition"
                  >
                    Send feedback
                  </button>
                )}
              </>
            )}
          </div>

          <div className="mt-4 p-4 border border-indigo-500/20 bg-indigo-500/5 rounded-xl">
            <p className="text-sm font-semibold text-indigo-300">
              Want your own AI negotiator?
            </p>
            <p className="text-xs text-zinc-500 mt-1">
              Create your AgentEnvoy link and let AI handle your scheduling.
            </p>
            <a
              href="/"
              className="inline-block mt-3 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm rounded-lg font-medium transition"
            >
              Sign up for AgentEnvoy
            </a>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0a0a0f] text-zinc-100 flex flex-col">
      {/* Header */}
      <header className="border-b border-zinc-800 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-bold bg-gradient-to-r from-indigo-400 to-purple-400 bg-clip-text text-transparent">
            AgentEnvoy
          </h1>
          {topic && (
            <>
              <span className="text-zinc-700">·</span>
              <span className="text-sm text-zinc-400">{topic}</span>
            </>
          )}
        </div>
        {hostName && (
          <span className="text-xs text-zinc-500">
            Meeting with {hostName}
          </span>
        )}
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Chat panel */}
        <div className="flex-1 flex flex-col">
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
                const { text, proposal } =
                  msg.role === "administrator"
                    ? parseConfirmationProposal(msg.content)
                    : { text: msg.content, proposal: null };

                return (
                  <div key={msg.id}>
                    <div
                      className={`flex ${
                        msg.role === "guest"
                          ? "justify-end"
                          : "justify-start"
                      }`}
                    >
                      <div
                        className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                          msg.role === "guest"
                            ? "bg-indigo-600 text-white rounded-br-sm"
                            : msg.role === "system"
                              ? "bg-emerald-900/30 border border-emerald-800 text-emerald-200 rounded-lg"
                              : "bg-zinc-800 border border-zinc-700 text-zinc-100 rounded-bl-sm"
                        }`}
                      >
                        {msg.role === "administrator" && (
                          <div className="text-[10px] font-bold uppercase tracking-wider text-emerald-400 mb-1">
                            Envoy
                          </div>
                        )}
                        <div className="whitespace-pre-wrap">{text}</div>
                      </div>
                    </div>

                    {proposal && !confirmed && (
                      <div className="flex justify-start mt-2">
                        <div className="max-w-[85%] bg-emerald-900/20 border border-emerald-700/50 rounded-xl p-4 space-y-3">
                          <div className="text-[10px] font-bold uppercase tracking-wider text-emerald-400">
                            Proposed meeting
                          </div>
                          <div className="space-y-1 text-sm text-zinc-300">
                            <p>
                              📅{" "}
                              {new Date(proposal.dateTime).toLocaleDateString(
                                "en-US",
                                {
                                  weekday: "long",
                                  month: "long",
                                  day: "numeric",
                                }
                              )}
                            </p>
                            <p>
                              🕐{" "}
                              {new Date(proposal.dateTime).toLocaleTimeString(
                                "en-US",
                                { hour: "numeric", minute: "2-digit" }
                              )}{" "}
                              ({proposal.duration} min)
                            </p>
                            <p>
                              📱{" "}
                              {proposal.format.charAt(0).toUpperCase() +
                                proposal.format.slice(1)}
                            </p>
                            {proposal.location && (
                              <p>📍 {proposal.location}</p>
                            )}
                          </div>
                          <button
                            onClick={() => handleConfirm(proposal)}
                            disabled={isConfirming}
                            className="w-full mt-2 px-4 py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition"
                          >
                            {isConfirming
                              ? "Confirming..."
                              : "Confirm this time"}
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
            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <form
            onSubmit={handleSend}
            className="p-4 border-t border-zinc-800"
          >
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
                placeholder="Type your message..."
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
          </form>
        </div>

        {/* Right sidebar — connect options */}
        <div className="w-72 border-l border-zinc-800 p-4 space-y-4 overflow-y-auto hidden md:block">
          <h4 className="text-[10px] font-bold uppercase tracking-widest text-zinc-500">
            Quick actions
          </h4>

          {calendarConnected ? (
            <div className="w-full bg-emerald-900/20 border border-emerald-700/50 rounded-xl p-3">
              <div className="text-sm font-medium text-emerald-300">
                Calendar connected
              </div>
              <p className="text-xs text-zinc-500 mt-1">
                Your availability is being shared
              </p>
            </div>
          ) : (
            <button
              onClick={handleConnectCalendar}
              disabled={!sessionId}
              className="w-full text-left bg-zinc-900 border border-zinc-800 rounded-xl p-3 hover:border-indigo-500/50 transition group disabled:opacity-50"
            >
              <div className="text-sm font-medium text-indigo-400 group-hover:text-indigo-300 transition underline underline-offset-2">
                Connect your calendar for automatic availability
              </div>
              <p className="text-xs text-zinc-500 mt-1">
                One-time read-only access via Google — we only check your free/busy times
              </p>
            </button>
          )}

          <button
            onClick={handleConnectAgent}
            className="w-full text-left bg-zinc-900 border border-zinc-800 rounded-xl p-3 hover:border-indigo-500/50 transition group"
          >
            <div className="text-sm font-medium text-zinc-200 group-hover:text-indigo-300 transition">
              Connect your agent
            </div>
            <p className="text-xs text-zinc-500 mt-1">
              Let your AI handle this negotiation
            </p>
          </button>

          {showAgentInfo && (
            <div className="bg-zinc-900 border border-zinc-700 rounded-xl p-3 text-xs text-zinc-400 space-y-2">
              <p className="font-medium text-zinc-200">Agent API</p>
              <p>Your agent can negotiate on your behalf via the AgentEnvoy API.</p>
              <p>Send messages to this session at:</p>
              <code className="block bg-zinc-800 rounded p-2 text-emerald-400 text-[11px] break-all">
                POST /api/negotiate/message
              </code>
              <p className="mt-1">
                <a href="https://agentenvoy.ai" className="text-indigo-400 hover:text-indigo-300">
                  Sign up for API access
                </a>
              </p>
            </div>
          )}

          {hostName && (
            <div className="mt-6">
              <h4 className="text-[10px] font-bold uppercase tracking-widest text-zinc-500 mb-2">
                Meeting with
              </h4>
              <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-3">
                <p className="text-sm font-medium">{hostName}</p>
                {topic && (
                  <p className="text-xs text-zinc-400 mt-1">{topic}</p>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
