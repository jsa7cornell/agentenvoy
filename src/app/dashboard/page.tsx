"use client";

import Feed from "@/components/feed";
import { AvailabilityPanel } from "@/components/availability-panel";

export default function DashboardPage() {
  return (
    <div className="flex-1 flex overflow-hidden">
      {/* Chat column — fixed width on desktop so the availability panel
          can flex to fill the rest. At narrow viewports the calendar's
          internal responsive logic drops to 5 or 3 days; below md the
          panel hides entirely and chat takes the full viewport. */}
      <div className="hidden md:flex flex-col flex-shrink-0 min-w-[560px] max-w-[700px] md:w-[610px] overflow-hidden">
        <div className="flex-1 min-h-0 overflow-hidden">
          <Feed />
        </div>
      </div>

      {/* Mobile-only: chat always, panel hidden */}
      <div className="flex md:hidden flex-1 flex-col overflow-hidden min-w-0">
        <div className="flex-1 min-h-0 overflow-hidden">
          <Feed />
        </div>
      </div>

      {/* Right pane — desktop only, always open. */}
      <div className="hidden md:flex flex-1 flex-shrink border-l border-secondary flex-col overflow-hidden min-w-[520px]">
        <AvailabilityPanel />
      </div>
    </div>
  );
}
