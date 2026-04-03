"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import ThreadCard from "./thread-card";
import { computeThreadStatus } from "@/lib/thread-status";

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
    link: {
      inviteeName?: string;
      inviteeEmail?: string;
      topic?: string;
      code?: string;
      slug: string;
    };
    _count: { messages: number };
  } | null;
}

interface FeedProps {
  onThreadSelect: (sessionId: string) => void;
  selectedThreadId?: string | null;
}

export default function Feed({ onThreadSelect, selectedThreadId }: FeedProps) {
  const [messages, setMessages] = useState<ChannelMsg[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Load channel history
  useEffect(() => {
    async function loadMessages() {
      try {
        const res = await fetch("/api/channel/messages");
        if (res.ok) {
          const data = await res.json();
          setMessages(data.messages || []);
        }
      } catch (e) {
        console.error("Failed to load channel messages:", e);
      } finally {
        setInitialLoading(false);
      }
    }
    loadMessages();
  }, []);

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Auto-resize textarea
  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    const el = e.target;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 120) + "px";
  }, []);

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
          body: JSON.stringify({
            content: directive,
            sessionId: selectedThreadId || undefined,
          }),
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

      if (!res.ok) throw new Error("Failed to send");

      const contentType = res.headers.get("content-type") || "";

      if (contentType.includes("application/json")) {
        // Thread creation response — server returns JSON with thread data
        const data = await res.json();

        // Add envoy message with share note
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
        // Regular text response — parse AI SDK format: 0:"text"\n
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
        } catch {
          // Use raw text if parsing fails
        }

        // Strip any action blocks that leaked through (safety net)
        const displayContent = content
          .replace(/```agentenvoy-action\s*\n?[\s\S]*?\n?```/g, "")
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
      // Add error message
      setMessages((prev) => [
        ...prev,
        {
          id: `error-${Date.now()}`,
          role: "system",
          content: "Failed to send message. Please try again.",
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
            <div className="w-1.5 h-1.5 rounded-full bg-gray-600 animate-bounce" style={{ animationDelay: "0ms" }} />
            <div className="w-1.5 h-1.5 rounded-full bg-gray-600 animate-bounce" style={{ animationDelay: "150ms" }} />
            <div className="w-1.5 h-1.5 rounded-full bg-gray-600 animate-bounce" style={{ animationDelay: "300ms" }} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-6 py-5 flex flex-col gap-1.5">
        {messages.length === 0 && !loading && (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-sm text-gray-500">Start a conversation with Envoy</p>
          </div>
        )}

        {messages.map((msg) => {
          // Thread card
          if (msg.threadId && msg.thread) {
            const status = computeThreadStatus({
              status: msg.thread.status,
              inviteeName: msg.thread.link.inviteeName,
              guestEmail: msg.thread.link.inviteeEmail,
            });

            return (
              <ThreadCard
                key={msg.id}
                title={msg.thread.title || "Thread"}
                statusLabel={msg.thread.statusLabel || status.label}
                statusColor={status.color}
                subtitle={[
                  msg.thread.format === "phone" ? "Phone call" : msg.thread.format === "video" ? "Video" : msg.thread.format,
                  msg.thread.duration ? `${msg.thread.duration} min` : null,
                ].filter(Boolean).join(" · ") || undefined}
                inviteeName={msg.thread.link.inviteeName || undefined}
                inviteeEmail={msg.thread.link.inviteeEmail || undefined}
                messageCount={msg.thread._count.messages}
                selected={selectedThreadId === msg.thread.id}
                onClick={() => onThreadSelect(msg.thread!.id)}
              />
            );
          }

          // System message
          if (msg.role === "system") {
            return (
              <div key={msg.id} className="text-center text-xs text-gray-500 py-2">
                {msg.content}
              </div>
            );
          }

          // Chat bubble
          const isUser = msg.role === "user";
          return (
            <div
              key={msg.id}
              className={`max-w-[72%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                isUser
                  ? "self-end bg-purple-600 text-white rounded-br-sm"
                  : "self-start bg-white/7 rounded-bl-sm"
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
            </div>
          );
        })}

        {/* Typing indicator */}
        {loading && (
          <div className="self-start bg-white/7 rounded-2xl rounded-bl-sm px-4 py-3 flex items-center gap-1">
            <div className="w-1.5 h-1.5 rounded-full bg-gray-500 animate-bounce" style={{ animationDelay: "0ms" }} />
            <div className="w-1.5 h-1.5 rounded-full bg-gray-500 animate-bounce" style={{ animationDelay: "150ms" }} />
            <div className="w-1.5 h-1.5 rounded-full bg-gray-500 animate-bounce" style={{ animationDelay: "300ms" }} />
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="px-6 py-4 border-t border-white/5 flex-shrink-0">
        <div className="flex gap-2 items-end">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder="Tell Envoy what to schedule..."
            rows={1}
            className="flex-1 bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-sm text-gray-100 placeholder-gray-600 resize-none outline-none focus:border-purple-500/50 min-h-[44px] max-h-[120px]"
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || loading}
            className="w-11 h-11 rounded-xl bg-purple-600 text-white flex items-center justify-center flex-shrink-0 hover:bg-purple-700 transition-colors disabled:opacity-30 disabled:cursor-default text-lg"
          >
            &uarr;
          </button>
        </div>
      </div>
    </div>
  );
}
