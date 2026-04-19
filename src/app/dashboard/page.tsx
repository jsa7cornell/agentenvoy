"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Feed from "@/components/feed";
import { AvailabilityPanel } from "@/components/availability-panel";

const CHAT_MIN = 400;
const CHAT_MAX = 860;
const CHAT_DEFAULT = 610;

export default function DashboardPage() {
  const [chatWidth, setChatWidth] = useState(CHAT_DEFAULT);
  const dragging = useRef(false);
  const startX = useRef(0);
  const startW = useRef(0);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    dragging.current = true;
    startX.current = e.clientX;
    startW.current = chatWidth;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, [chatWidth]);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const delta = e.clientX - startX.current;
      const next = Math.min(CHAT_MAX, Math.max(CHAT_MIN, startW.current + delta));
      setChatWidth(next);
    };
    const onMouseUp = () => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    return () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  return (
    <div className="flex-1 flex overflow-hidden">
      {/* Chat column — desktop: user-resizable. Mobile: full width. */}
      <div
        className="hidden md:flex flex-col flex-shrink-0 overflow-hidden"
        style={{ width: chatWidth }}
      >
        <div className="flex-1 min-h-0 overflow-hidden">
          <Feed />
        </div>
      </div>

      {/* Mobile-only chat */}
      <div className="flex md:hidden flex-1 flex-col overflow-hidden min-w-0">
        <div className="flex-1 min-h-0 overflow-hidden">
          <Feed />
        </div>
      </div>

      {/* Drag handle — 6px hit target centered on the 1px border line */}
      <div
        className="hidden md:flex flex-col items-center justify-center flex-shrink-0 w-[5px] cursor-col-resize group z-10 relative"
        onMouseDown={onMouseDown}
      >
        <div className="absolute inset-y-0 left-[2px] w-px bg-secondary group-hover:bg-indigo-500/60 transition-colors" />
        {/* Grab pill — appears on hover so it's discoverable */}
        <div className="relative z-10 flex flex-col gap-[3px] opacity-0 group-hover:opacity-100 transition-opacity">
          <span className="w-[3px] h-[3px] rounded-full bg-indigo-400" />
          <span className="w-[3px] h-[3px] rounded-full bg-indigo-400" />
          <span className="w-[3px] h-[3px] rounded-full bg-indigo-400" />
        </div>
      </div>

      {/* Calendar panel — fills the rest */}
      <div className="hidden md:flex flex-1 flex-col overflow-hidden min-w-[420px]">
        <AvailabilityPanel />
      </div>
    </div>
  );
}
