"use client";

import { useSession, signOut } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import Feed from "@/components/feed";
import ThreadPanel from "@/components/thread-panel";
import { ConnectionsMenu } from "@/components/connections-menu";

export default function DashboardPage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (status === "unauthenticated") {
      router.push("/");
    }
  }, [status, router]);

  const meetUrl = session?.user?.meetSlug
    ? `${typeof window !== "undefined" ? window.location.origin : ""}/meet/${session.user.meetSlug}`
    : null;

  function copyLink() {
    if (meetUrl) {
      navigator.clipboard.writeText(meetUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
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

  return (
    <div className="h-screen bg-[#0a0a0f] text-zinc-100 flex flex-col overflow-hidden">
      {/* Header */}
      <header className="border-b border-zinc-800 px-6 py-3.5 flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-gradient-to-br from-indigo-500 to-purple-500 rounded-lg flex items-center justify-center text-white font-bold text-sm">
            E
          </div>
          <h1 className="text-lg font-semibold">Envoy</h1>
        </div>
        <div className="flex items-center gap-4">
          {meetUrl && (
            <button
              onClick={copyLink}
              className="text-xs px-3 py-1.5 rounded-lg bg-zinc-800/80 border border-zinc-700 hover:border-purple-500/40 text-zinc-400 hover:text-zinc-200 transition flex items-center gap-2"
            >
              <code className="text-purple-400 font-mono text-[11px]">
                /meet/{session.user?.meetSlug}
              </code>
              <span>{copied ? "Copied!" : "Copy"}</span>
            </button>
          )}
          <ConnectionsMenu />
          <div className="w-px h-5 bg-zinc-800" />
          <span className="text-sm text-zinc-400">{session.user?.name}</span>
          {session.user?.image && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={session.user.image}
              alt=""
              className="w-7 h-7 rounded-full"
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

      {/* Main: Feed + Thread Panel */}
      <div className="flex flex-1 overflow-hidden">
        {/* Feed */}
        <div className="flex-1 min-w-0">
          <Feed
            onThreadSelect={(id) => setSelectedThreadId(id)}
            selectedThreadId={selectedThreadId}
          />
        </div>

        {/* Thread panel */}
        {selectedThreadId && (
          <div className="w-[460px] flex-shrink-0 overflow-hidden">
            <ThreadPanel
              sessionId={selectedThreadId}
              onClose={() => setSelectedThreadId(null)}
            />
          </div>
        )}
      </div>
    </div>
  );
}
