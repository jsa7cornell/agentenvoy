"use client";

import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { DashboardHeader } from "@/components/dashboard-header";

interface ArchivedSession {
  id: string;
  title?: string;
  status: string;
  statusLabel?: string;
  format?: string;
  duration?: number;
  agreedTime?: string;
  guestEmail?: string;
  createdAt: string;
  link: {
    inviteeName?: string;
    inviteeEmail?: string;
    topic?: string;
  };
  _count: { messages: number };
}

export default function ArchivePage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const [sessions, setSessions] = useState<ArchivedSession[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (status === "unauthenticated") {
      router.push("/");
    }
  }, [status, router]);

  useEffect(() => {
    async function loadArchived() {
      try {
        const res = await fetch("/api/negotiate/sessions?archived=true");
        if (res.ok) {
          const data = await res.json();
          setSessions(data.sessions || []);
        }
      } catch (e) {
        console.error("Failed to load archived sessions:", e);
      } finally {
        setLoading(false);
      }
    }
    if (status === "authenticated") loadArchived();
  }, [status]);

  async function handleUnarchive(sessionId: string) {
    try {
      await fetch("/api/negotiate/archive", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, archived: false }),
      });
      setSessions((prev) => prev.filter((s) => s.id !== sessionId));
    } catch (e) {
      console.error("Unarchive error:", e);
    }
  }

  if (status === "loading" || !session) {
    return (
      <div className="min-h-screen bg-[#0a0a0f] flex items-center justify-center">
        <div className="text-zinc-500">Loading...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0a0a0f] text-zinc-100 flex flex-col">
      <DashboardHeader />

      <div className="max-w-2xl mx-auto w-full px-4 sm:px-6 py-8">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-lg font-semibold">Archived Meetings</h1>
            <p className="text-sm text-zinc-500 mt-0.5">
              Past and completed negotiations
            </p>
          </div>
          <button
            onClick={() => router.push("/dashboard")}
            className="text-xs text-zinc-500 hover:text-zinc-300 transition"
          >
            &larr; Back to dashboard
          </button>
        </div>

        {loading ? (
          <div className="text-center py-12">
            <div className="text-zinc-500 text-sm">Loading...</div>
          </div>
        ) : sessions.length === 0 ? (
          <div className="text-center py-12 bg-zinc-900/50 border border-zinc-800 rounded-xl">
            <p className="text-zinc-500 text-sm">No archived meetings yet</p>
            <p className="text-zinc-600 text-xs mt-1">
              Completed meetings can be archived from your dashboard
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {sessions.map((s) => (
              <div
                key={s.id}
                className="bg-zinc-900/50 border border-zinc-800 rounded-xl px-4 py-3.5 hover:border-zinc-700 transition"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-zinc-200 truncate">
                      {s.title || "Meeting"}
                    </div>
                    <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1 text-xs text-zinc-500">
                      {(s.link.inviteeEmail || s.guestEmail) && (
                        <span>{s.link.inviteeEmail || s.guestEmail}</span>
                      )}
                      {s.agreedTime && (
                        <span>
                          {new Date(s.agreedTime).toLocaleDateString("en-US", {
                            month: "short",
                            day: "numeric",
                          })}
                        </span>
                      )}
                      {s.format && (
                        <span>
                          {s.format === "phone" ? "Phone" : s.format === "video" ? "Video" : s.format}
                        </span>
                      )}
                      <span>{s._count.messages} messages</span>
                    </div>
                  </div>
                  <button
                    onClick={() => handleUnarchive(s.id)}
                    className="flex-shrink-0 px-2.5 py-1 text-[11px] font-medium text-zinc-500 hover:text-zinc-300 border border-zinc-800 hover:border-zinc-600 rounded-lg transition"
                  >
                    Unarchive
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
