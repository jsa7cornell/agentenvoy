"use client";

import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import Feed from "@/components/feed";
import { DashboardHeader } from "@/components/dashboard-header";
import { AvailabilityCalendar } from "@/components/availability-calendar";
import Link from "next/link";

export default function DashboardPage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const [slotsByDay, setSlotsByDay] = useState<Record<string, Array<{ start: string; end: string; score?: number }>>>({});
  const [slotTimezone, setSlotTimezone] = useState("America/Los_Angeles");
  const [slotLocation, setSlotLocation] = useState<{ label: string; until?: string } | null>(null);

  useEffect(() => {
    if (status === "unauthenticated") {
      router.push("/");
    }
  }, [status, router]);

  // Fetch host's own availability
  useEffect(() => {
    if (status !== "authenticated") return;
    fetch("/api/negotiate/slots?self=true")
      .then((res) => res.json())
      .then((data) => {
        if (data.slotsByDay) setSlotsByDay(data.slotsByDay);
        if (data.timezone) setSlotTimezone(data.timezone);
        if (data.currentLocation) setSlotLocation(data.currentLocation);
      })
      .catch((e) => console.log("Failed to fetch availability:", e));
  }, [status]);

  if (status === "loading") {
    return (
      <div className="min-h-screen bg-surface flex items-center justify-center">
        <div className="text-muted">Loading...</div>
      </div>
    );
  }

  if (!session) return null;

  return (
    <div className="flex-1 min-h-0 bg-surface text-primary flex flex-col overflow-hidden">
      <DashboardHeader />

      <div className="flex-1 flex overflow-hidden">
        {/* Feed — main content */}
        <div className="flex-1 overflow-hidden min-h-0">
          <div className="max-w-3xl mx-auto h-full min-h-0">
            <Feed />
          </div>
        </div>

        {/* Availability sidebar — desktop only, matches deal room pattern */}
        <div className="hidden md:flex w-64 flex-shrink-0 border-l border-secondary p-4 overflow-y-auto flex-col">
          <h4 className="text-[10px] font-bold uppercase tracking-widest text-muted mb-2">
            Your availability
          </h4>
          <AvailabilityCalendar
            slotsByDay={slotsByDay}
            timezone={slotTimezone}
            currentLocation={slotLocation}
          />
          <Link href="/dashboard/tuner" className="text-xs text-muted hover:text-secondary underline mt-2 inline-block">
            Fine-tune availability
          </Link>
        </div>
      </div>
    </div>
  );
}
