"use client";

import { useSession, signOut } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import Feed from "@/components/feed";
import ThreadPanel from "@/components/thread-panel";
import { DashboardSidebar } from "@/components/dashboard-sidebar";
import { LogoFull } from "@/components/logo";

export default function DashboardPage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);

  useEffect(() => {
    if (status === "unauthenticated") {
      router.push("/");
    }
  }, [status, router]);

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
      {/* Header — slimmed down, moved link + connections to sidebar */}
      <header className="border-b border-zinc-800 px-6 py-3 flex items-center justify-between flex-shrink-0">
        <a href="/" className="flex items-center">
          <LogoFull height={26} className="text-zinc-100" />
        </a>
        <div className="flex items-center gap-3">
          <span className="text-xs text-zinc-500">{session.user?.name}</span>
          {session.user?.image && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={session.user.image}
              alt=""
              className="w-6 h-6 rounded-full"
            />
          )}
          <button
            onClick={() => signOut({ callbackUrl: "/" })}
            className="text-[11px] text-zinc-600 hover:text-zinc-400 transition"
          >
            Sign out
          </button>
        </div>
      </header>

      {/* Main: Feed + Thread Panel + Sidebar */}
      <div className="flex flex-1 overflow-hidden">
        {/* Feed — main content */}
        <div className="flex-1 min-w-0">
          <Feed
            onThreadSelect={(id) => setSelectedThreadId(id)}
            selectedThreadId={selectedThreadId}
          />
        </div>

        {/* Thread panel — opens when a thread is selected */}
        {selectedThreadId && (
          <div className="w-[460px] flex-shrink-0 overflow-hidden border-l border-zinc-800">
            <ThreadPanel
              sessionId={selectedThreadId}
              onClose={() => setSelectedThreadId(null)}
            />
          </div>
        )}

        {/* Right sidebar — always visible, deal-room style */}
        <div className="w-[280px] flex-shrink-0 border-l border-zinc-800 hidden lg:flex flex-col">
          <DashboardSidebar
            meetSlug={session.user?.meetSlug}
            userName={session.user?.name}
          />
        </div>
      </div>
    </div>
  );
}
