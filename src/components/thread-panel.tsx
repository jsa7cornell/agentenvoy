"use client";

import { useState, useEffect, useRef } from "react";

interface ThreadMessage {
  id: string;
  role: string; // "administrator" | "guest" | "system"
  content: string;
  createdAt: string;
}

interface ThreadSession {
  id: string;
  title?: string;
  status: string;
  statusLabel?: string;
  type: string;
  meetingType?: string;
  duration?: number;
  format?: string;
  agreedTime?: string;
  meetLink?: string;
  link: {
    inviteeName?: string;
    inviteeEmail?: string;
    topic?: string;
    code?: string;
    slug: string;
  };
  messages: ThreadMessage[];
}

interface ThreadPanelProps {
  sessionId: string;
  onClose: () => void;
}

// Parse confirmation proposal from agent messages
function parseConfirmationProposal(content: string) {
  const match = content.match(
    /\[CONFIRMATION_PROPOSAL\]([\s\S]*?)\[\/CONFIRMATION_PROPOSAL\]/
  );
  if (!match) return null;
  try {
    const proposal = JSON.parse(match[1]);
    return proposal;
  } catch {
    return null;
  }
}

function stripProposalBlock(content: string): string {
  return content
    .replace(/\[CONFIRMATION_PROPOSAL\][\s\S]*?\[\/CONFIRMATION_PROPOSAL\]/, "")
    .trim();
}

export default function ThreadPanel({ sessionId, onClose }: ThreadPanelProps) {
  const [session, setSession] = useState<ThreadSession | null>(null);
  const [loading, setLoading] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    async function loadThread() {
      setLoading(true);
      try {
        const res = await fetch(`/api/negotiate/session?id=${sessionId}`);
        if (res.ok) {
          const data = await res.json();
          setSession(data.session);
        }
      } catch (e) {
        console.error("Failed to load thread:", e);
      } finally {
        setLoading(false);
      }
    }
    loadThread();
  }, [sessionId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [session?.messages]);

  if (loading) {
    return (
      <div className="flex flex-col h-full bg-[#0c0c1e] border-l border-white/5">
        <div className="flex items-center gap-3 px-5 py-4 border-b border-white/5">
          <div className="w-7 h-7 rounded-lg bg-purple-500/12 flex items-center justify-center text-xs">
            <span role="img" aria-label="calendar">&#128197;</span>
          </div>
          <div className="h-4 w-40 bg-white/10 rounded animate-pulse" />
          <button onClick={onClose} className="ml-auto w-7 h-7 rounded-lg bg-white/5 flex items-center justify-center text-gray-500 hover:text-white hover:bg-white/10 transition-colors">
            &times;
          </button>
        </div>
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

  if (!session) {
    return (
      <div className="flex flex-col h-full bg-[#0c0c1e] border-l border-white/5">
        <div className="flex items-center gap-3 px-5 py-4 border-b border-white/5">
          <span className="text-sm text-gray-400">Thread not found</span>
          <button onClick={onClose} className="ml-auto w-7 h-7 rounded-lg bg-white/5 flex items-center justify-center text-gray-500 hover:text-white">
            &times;
          </button>
        </div>
      </div>
    );
  }

  const statusColor =
    session.status === "agreed" ? "bg-green-500/10 text-green-400" :
    session.status === "escalated" ? "bg-red-500/10 text-red-400" :
    session.status === "expired" ? "bg-gray-500/10 text-gray-400" :
    "bg-purple-500/10 text-purple-400";

  return (
    <div className="flex flex-col h-full bg-[#0c0c1e] border-l border-white/5">
      {/* Header */}
      <div className="flex items-center gap-3 px-5 py-3.5 border-b border-white/5 flex-shrink-0">
        <div className="w-7 h-7 rounded-lg bg-purple-500/12 flex items-center justify-center text-xs flex-shrink-0">
          <span role="img" aria-label="calendar">&#128197;</span>
        </div>
        <h2 className="text-sm font-semibold text-gray-100 truncate flex-1 min-w-0">
          {session.title || session.link.topic || "Thread"}
        </h2>
        <span className={`px-2.5 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide flex-shrink-0 ${statusColor}`}>
          {session.statusLabel || session.status}
        </span>
        <button
          onClick={onClose}
          className="w-7 h-7 rounded-lg bg-white/5 flex items-center justify-center text-gray-500 hover:text-white hover:bg-white/10 transition-colors flex-shrink-0"
        >
          &times;
        </button>
      </div>

      {/* Info bar */}
      <div className="flex gap-4 px-5 py-2.5 border-b border-white/[0.03] text-xs text-gray-500 flex-shrink-0">
        {session.format && <span>{session.format === "phone" ? "Phone" : session.format === "video" ? "Video" : "In-person"}</span>}
        {session.duration && <span>{session.duration} min</span>}
        {session.link.inviteeEmail && <span>{session.link.inviteeEmail}</span>}
        {session.link.code && (
          <button
            onClick={() => {
              const url = `${window.location.origin}/meet/${session.link.slug}/${session.link.code}`;
              navigator.clipboard.writeText(url);
            }}
            className="ml-auto text-purple-400 hover:text-purple-300 font-medium"
          >
            Copy link
          </button>
        )}
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-1.5">
        {session.messages.map((msg) => {
          const proposal = msg.role === "administrator" ? parseConfirmationProposal(msg.content) : null;
          const displayContent = msg.role === "administrator" ? stripProposalBlock(msg.content) : msg.content;

          if (msg.role === "host_note") {
            return (
              <div key={msg.id} className="self-end ml-auto max-w-[80%]">
                <div className="rounded-lg px-3 py-1.5 text-xs bg-amber-500/10 border border-amber-500/20 text-amber-300">
                  <span className="font-semibold uppercase tracking-wider text-[9px] text-amber-500 mr-1.5">Note</span>
                  {msg.content}
                </div>
              </div>
            );
          }

          if (msg.role === "system") {
            return (
              <div key={msg.id} className="text-center text-xs text-gray-500 py-2">
                {displayContent}
              </div>
            );
          }

          const isEnvoy = msg.role === "administrator";
          const isGuest = msg.role === "guest";

          return (
            <div key={msg.id}>
              <div
                className={`max-w-[88%] rounded-2xl px-3.5 py-2.5 text-[13px] leading-relaxed ${
                  isEnvoy
                    ? "self-start bg-white/7 rounded-bl-sm"
                    : isGuest
                    ? "self-end ml-auto bg-emerald-800 text-emerald-100 rounded-br-sm"
                    : "self-end ml-auto bg-purple-600 text-white rounded-br-sm"
                }`}
              >
                <div className={`text-[10px] font-semibold uppercase tracking-wide mb-1 ${
                  isEnvoy ? "text-purple-400" : isGuest ? "text-emerald-400" : "text-white/60"
                }`}>
                  {isEnvoy ? "Envoy" : isGuest ? (session.link.inviteeName || "Guest") : "You"}
                </div>
                <div className="whitespace-pre-wrap">{displayContent}</div>
              </div>

              {/* Confirmation proposal card */}
              {proposal && (
                <div className="mt-2 rounded-xl border border-green-500/20 bg-green-500/5 p-3.5">
                  <h4 className="text-xs font-semibold text-green-400 mb-2">
                    {session.status === "agreed" ? "Meeting Confirmed" : "Ready to confirm"}
                  </h4>
                  <div className="text-xs text-gray-400 space-y-1">
                    <div>{new Date(proposal.dateTime).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })} at {new Date(proposal.dateTime).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}</div>
                    <div>{proposal.duration} minutes</div>
                    <div>{proposal.format}</div>
                    {proposal.location && <div>{proposal.location}</div>}
                  </div>
                  {session.status === "agreed" && (
                    <div className="text-xs text-green-400 mt-2">Calendar invites sent</div>
                  )}
                </div>
              )}
            </div>
          );
        })}
        <div ref={messagesEndRef} />
      </div>

      {/* Thread URL */}
      {session.link.code && (
        <div className="px-5 py-2.5 border-t border-white/5 text-xs text-gray-500 flex-shrink-0">
          <span className="text-purple-400">{window.location.origin}/meet/{session.link.slug}/{session.link.code}</span>
        </div>
      )}
    </div>
  );
}
