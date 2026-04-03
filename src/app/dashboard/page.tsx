"use client";

import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import Feed from "@/components/feed";
import { DashboardHeader } from "@/components/dashboard-header";

export default function DashboardPage() {
  const { data: session, status } = useSession();
  const router = useRouter();

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
      <DashboardHeader />

      <div className="flex-1 overflow-hidden">
        <div className="max-w-3xl mx-auto h-full">
          <Feed />
        </div>
      </div>
    </div>
  );
}
