"use client";

import { useSession } from "next-auth/react";
import { useEffect, useState } from "react";
import Feed from "@/components/feed";
import { AvailabilityCalendar } from "@/components/availability-calendar";
import { TodayInsight } from "@/components/today-insight";
import { DidYouKnow } from "@/components/did-you-know";
import { AvailabilityPanel } from "@/components/availability-panel";
import Link from "next/link";

const PANEL_LS_KEY = "dashboard.availabilityPanel.open";

export default function DashboardPage() {
  const { status } = useSession();
  const [slotsByDay, setSlotsByDay] = useState<Record<string, Array<{ start: string; end: string; score?: number }>>>({});
  const [slotTimezone, setSlotTimezone] = useState("America/Los_Angeles");
  const [slotLocation, setSlotLocation] = useState<{ label: string; until?: string } | null>(null);

  // Desktop-only accordion: when open, replaces the mini-availability rail
  // with a full weekly calendar on the right. Persisted in localStorage so
  // the choice sticks across reloads.
  const [panelOpen, setPanelOpen] = useState(false);
  useEffect(() => {
    try {
      setPanelOpen(localStorage.getItem(PANEL_LS_KEY) === "1");
    } catch {
      // ignore
    }
  }, []);
  function togglePanel() {
    setPanelOpen((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(PANEL_LS_KEY, next ? "1" : "0");
      } catch {
        // ignore
      }
      return next;
    });
  }

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

  return (
    <div className="flex-1 flex overflow-hidden">
      {/* Feed — main content */}
      <div className="flex-1 overflow-hidden min-h-0 min-w-0 flex flex-col">
        {/* Desktop-only toolbar for panel toggle */}
        <div className="hidden md:flex items-center justify-end px-3 py-1.5 border-b border-secondary shrink-0">
          <button
            onClick={togglePanel}
            className="flex items-center gap-1.5 px-2.5 py-1 text-xs text-secondary hover:text-primary border border-secondary hover:border-DEFAULT rounded-lg transition"
            title={panelOpen ? "Hide weekly calendar" : "Show weekly calendar"}
          >
            <span aria-hidden>📅</span>
            <span>{panelOpen ? "Hide week" : "This week"}</span>
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-hidden">
          <Feed />
        </div>
      </div>

      {/* Right rail — desktop only. Swaps between mini-rail and full panel. */}
      {panelOpen ? (
        <div className="hidden md:flex w-[560px] flex-shrink-0 border-l border-secondary flex-col overflow-hidden">
          <AvailabilityPanel
            headerSlot={
              <button
                onClick={togglePanel}
                className="text-xs text-muted hover:text-primary px-1.5 py-0.5 transition"
                title="Close panel"
                aria-label="Close panel"
              >
                ✕
              </button>
            }
          />
        </div>
      ) : (
        <div className="hidden md:flex w-64 flex-shrink-0 border-l border-secondary p-4 overflow-y-auto flex-col">
          <h4 className="text-[10px] font-bold uppercase tracking-widest text-muted mb-2">
            Your availability
          </h4>
          <AvailabilityCalendar
            slotsByDay={slotsByDay}
            timezone={slotTimezone}
            currentLocation={slotLocation}
          />
          <Link href="/dashboard/availability" className="text-xs text-muted hover:text-secondary underline mt-2 inline-block">
            Fine-tune availability
          </Link>
          <TodayInsight />
          <DidYouKnow />
        </div>
      )}
    </div>
  );
}
