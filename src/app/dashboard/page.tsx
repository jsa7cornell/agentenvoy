"use client";

import { useSession, signOut } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useEffect, useState, useCallback } from "react";
import { Chat } from "@/components/chat";

interface NegotiationSession {
  id: string;
  status: string;
  type: string;
  agreedTime?: string;
  agreedFormat?: string;
  meetLink?: string;
  updatedAt: string;
  link: {
    type: string;
    inviteeName?: string;
    inviteeEmail?: string;
    topic?: string;
  };
  _count: { messages: number };
}

export default function DashboardPage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const [sessions, setSessions] = useState<NegotiationSession[]>([]);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (status === "unauthenticated") {
      router.push("/");
    }
  }, [status, router]);

  const fetchSessions = useCallback(async () => {
    try {
      const res = await fetch("/api/negotiate/sessions?status=all");
      if (res.ok) {
        const data = await res.json();
        setSessions(data.sessions);
      }
    } catch {}
  }, []);

  useEffect(() => {
    if (status === "authenticated") {
      fetchSessions();
    }
  }, [status, fetchSessions]);

  const meetUrl = session?.user?.meetSlug
    ? `${window.location.origin}/meet/${session.user.meetSlug}`
    : null;

  function copyLink() {
    if (meetUrl) {
      navigator.clipboard.writeText(meetUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  async function handleAction(action: Record<string, unknown>) {
    if (action.action === "create_link") {
      try {
        const res = await fetch("/api/negotiate/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            inviteeEmail: action.inviteeEmail,
            inviteeName: action.inviteeName,
            topic: action.topic,
            rules: action.rules,
          }),
        });
        if (res.ok) {
          fetchSessions();
        }
      } catch {}
    } else if (action.action === "update_preferences") {
      try {
        await fetch("/api/agent/configure", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: JSON.stringify(action.preferences) }),
        });
      } catch {}
    }
  }

  if (status === "loading") {
    return (
      <div className="min-h-screen bg-[#0a0a0f] flex items-center justify-center">
        <div className="text-zinc-500">Loading...</div>
      </div>
    );
  }

  if (!session) return null;

  const activeSessions = sessions.filter((s) => s.status === "active");
  const completedSessions = sessions.filter((s) => s.status === "agreed");

  return (
    <div className="min-h-screen bg-[#0a0a0f] text-zinc-100">
      {/* Header */}
      <header className="border-b border-zinc-800 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-bold bg-gradient-to-r from-indigo-400 to-purple-400 bg-clip-text text-transparent">
            AgentEnvoy
          </h1>
          <span className="text-xs text-zinc-500">Dashboard</span>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-sm text-zinc-400">{session.user?.name}</span>
          {session.user?.image && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={session.user.image}
              alt=""
              className="w-8 h-8 rounded-full"
            />
          )}
          <button
            onClick={() => signOut({ callbackUrl: "/" })}
            className="text-xs text-zinc-500 hover:text-zinc-300 transition"
          >
            Sign out
          </button>
        </div>
      </header>

      <div className="flex h-[calc(100vh-65px)]">
        {/* Left side — Chat */}
        <div className="flex-1 flex flex-col border-r border-zinc-800">
          {/* Meet link bar */}
          {meetUrl && (
            <div className="px-6 py-3 border-b border-zinc-800 flex items-center gap-3 bg-zinc-900/50">
              <span className="text-xs text-zinc-500 font-medium">
                Your meet link:
              </span>
              <code className="text-sm text-emerald-400 font-mono">
                {meetUrl}
              </code>
              <button
                onClick={copyLink}
                className="text-xs px-3 py-1 rounded-lg bg-zinc-800 border border-zinc-700 hover:border-indigo-500 text-zinc-300 transition"
              >
                {copied ? "Copied!" : "Copy"}
              </button>
            </div>
          )}

          <Chat
            endpoint="/api/dashboard/chat"
            placeholder="Tell me about a meeting you want to set up..."
            initialMessages={[
              {
                id: "welcome",
                role: "assistant",
                content: `Hi ${session.user?.name?.split(" ")[0] || "there"}! I'm your AgentEnvoy assistant. Tell me about a meeting you'd like to set up, and I'll create a link for you.\n\nFor example: "I need to meet with Sarah Chen this week about the Q2 roadmap. Tuesday works best, phone only."`,
              },
            ]}
            onAction={handleAction}
          />
        </div>

        {/* Right side — Sessions */}
        <div className="w-80 overflow-y-auto p-4 space-y-6">
          {/* Active negotiations */}
          <div>
            <h3 className="text-xs font-bold uppercase tracking-widest text-zinc-500 mb-3">
              Active ({activeSessions.length})
            </h3>
            {activeSessions.length === 0 ? (
              <p className="text-xs text-zinc-600">No active negotiations</p>
            ) : (
              <div className="space-y-2">
                {activeSessions.map((s) => (
                  <SessionCard key={s.id} session={s} />
                ))}
              </div>
            )}
          </div>

          {/* Completed */}
          <div>
            <h3 className="text-xs font-bold uppercase tracking-widest text-zinc-500 mb-3">
              Completed ({completedSessions.length})
            </h3>
            {completedSessions.length === 0 ? (
              <p className="text-xs text-zinc-600">No completed negotiations</p>
            ) : (
              <div className="space-y-2">
                {completedSessions.map((s) => (
                  <SessionCard key={s.id} session={s} />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function SessionCard({ session: s }: { session: NegotiationSession }) {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-3 hover:border-zinc-700 transition cursor-pointer">
      <div className="flex items-center justify-between mb-1">
        <span className="text-sm font-medium truncate">
          {s.link.inviteeName || s.link.inviteeEmail || "Unknown"}
        </span>
        <span
          className={`text-[10px] font-bold uppercase tracking-wider ${
            s.status === "active"
              ? "text-amber-400"
              : s.status === "agreed"
                ? "text-emerald-400"
                : "text-zinc-500"
          }`}
        >
          {s.status}
        </span>
      </div>
      {s.link.topic && (
        <p className="text-xs text-zinc-400 truncate">{s.link.topic}</p>
      )}
      <div className="flex items-center gap-2 mt-2 text-[10px] text-zinc-500">
        <span>{s._count.messages} messages</span>
        <span className="text-zinc-700">&middot;</span>
        <span>{s.link.type}</span>
      </div>
    </div>
  );
}
