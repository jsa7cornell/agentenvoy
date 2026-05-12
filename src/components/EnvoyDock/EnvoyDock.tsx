"use client";

/**
 * EnvoyDock — bottom-anchored agent surface.
 *
 * Two states driven by the `state` prop:
 *  - resting: avatar (42px) + name + nudge copy + typing affordance + throb/pulse
 *  - thread:  340px expanded panel with message history + reply input
 *
 * Animation spec (from R4 mockup, 2026-05-08):
 *  - throb-soft: 2.6s ease-in-out infinite box-shadow oscillation on dock
 *    0%/100% → 0 -8px 24px rgba(99,102,241,.10), 0 0 0 0 rgba(99,102,241,.18)
 *    50%      → 0 -8px 24px rgba(99,102,241,.16), 0 0 0 6px rgba(99,102,241,0)
 *  - pulse-mark: 2.6s ease-in-out infinite scale 1→1.06→1 on avatar
 *  Both animations disabled in thread state (dock is settled).
 *
 * State transitions: parent-owned. Dock calls onExpand/onCollapse and
 * does not track state internally.
 *
 * Nudge copy matrix (resting state):
 *  proposal   → "What time works best?" + "Pick a slot and I'll lock it in."
 *  matched    → "Great overlap found." + "I found a slot you both have open."
 *  confirming → "Locking it in…" + "Almost there — one moment."
 *  confirmed  → "You're all set." + "I'll be here if anything changes."
 *  skipped    → "Session skipped." + "Tap to undo or pick a new time."
 *
 * PR2: onSendMessage wired. PR3: this becomes the left-rail persistent panel.
 */

import { Bot, PanelBottom } from "lucide-react";
import type { EnvoyDockProps } from "@/components/MeetingCard/types";
import { EnvoyDockThread } from "./EnvoyDock.thread";

// ── Nudge copy ────────────────────────────────────────────────────────────────

const NUDGE_COPY: Record<
  string,
  { headline: string; sub: string }
> = {
  proposal:   { headline: "What time works best?",  sub: "Pick a slot and I'll lock it in." },
  matched:    { headline: "Great overlap found.",    sub: "I found a slot you both have open." },
  confirming: { headline: "Locking it in…",          sub: "Almost there — one moment." },
  confirmed:  { headline: "You're all set.",         sub: "I'll be here if anything changes." },
  skipped:    { headline: "Session skipped.",        sub: "Tap to undo or pick a new time." },
};

// ── Component ─────────────────────────────────────────────────────────────────

export function EnvoyDock({
  state,
  cardState,
  contextHostFirstName,
  messages = [],
  onExpand,
  onCollapse,
  onSendMessage,
  viewerInitial,
  isAdmin,
  sessionId,
}: EnvoyDockProps) {
  const nudge = NUDGE_COPY[cardState] ?? NUDGE_COPY.confirmed;
  const isThread = state === "thread";

  if (isThread) {
    return (
      <EnvoyDockThread
        messages={messages}
        contextHostFirstName={contextHostFirstName}
        onCollapse={onCollapse}
        onSendMessage={onSendMessage}
        viewerInitial={viewerInitial}
        isAdmin={isAdmin}
        sessionId={sessionId}
      />
    );
  }

  // ── Resting state ──────────────────────────────────────────────────────────
  return (
    <>
      {/* keyframes injected once via a style tag — avoids globals.css dependency */}
      <style>{`
        @keyframes ae-throb-soft {
          0%,100% { box-shadow: 0 -8px 24px rgba(99,102,241,.10), 0 0 0 0 rgba(99,102,241,.18); }
          50%      { box-shadow: 0 -8px 24px rgba(99,102,241,.16), 0 0 0 6px rgba(99,102,241,0); }
        }
        @keyframes ae-pulse-mark {
          0%,100% { transform: scale(1); }
          50%     { transform: scale(1.06); }
        }
        .ae-dock-throb { animation: ae-throb-soft 2.6s ease-in-out infinite; }
        .ae-mark-pulse { animation: ae-pulse-mark 2.6s ease-in-out infinite; }
      `}</style>

      <div
        className="ae-dock-throb relative rounded-2xl border border-[#dbd5c4] bg-white flex flex-col p-[14px] cursor-pointer"
        onClick={onExpand}
        role="button"
        aria-label="Open AgentEnvoy chat"
      >
        {/* Row 1: avatar + text + arrow chip */}
        <div className="flex items-center gap-3">
          {/* Avatar */}
          <div
            className="ae-mark-pulse w-[42px] h-[42px] rounded-full flex-shrink-0 flex items-center justify-center text-white"
            style={{
              background: "linear-gradient(135deg,#6366f1,#a855f7)",
              boxShadow: "0 4px 12px rgba(99,102,241,.35), 0 0 0 3px rgba(99,102,241,.14)",
            }}
          >
            <Bot size={20} strokeWidth={2} />
          </div>

          {/* Text block */}
          <div className="flex-1 min-w-0">
            {/* Name row with live dot */}
            <div className="flex items-center gap-[6px] mb-[1px]">
              <span
                className="w-[5px] h-[5px] rounded-full flex-shrink-0"
                style={{ background: "#10b981", boxShadow: "0 0 0 3px rgba(16,185,129,.18)" }}
              />
              <span className="text-[11px] font-bold tracking-[0.06em] text-indigo-500 uppercase">
                AgentEnvoy
              </span>
            </div>
            {/* Nudge message */}
            <div className="text-[13px] text-[#1a1a2e] font-medium leading-snug">
              <strong>{nudge.headline}</strong> {nudge.sub}
            </div>
          </div>

          {/* Expand-panel chip — vertical sibling of Claude's PanelLeft.
              Signals "open chat panel below" via the standard panel-bottom icon. */}
          <div
            className="w-[30px] h-[30px] rounded-lg bg-indigo-50 text-indigo-500 flex items-center justify-center flex-shrink-0"
            aria-hidden="true"
          >
            <PanelBottom size={16} strokeWidth={2} />
          </div>
        </div>

        {/* Row 2: typing affordance */}
        <div className="mt-[11px] bg-[#faf8f3] border border-[#e7e2d5] rounded-[14px] px-3 py-[9px] flex items-center gap-[9px] text-[12.5px] text-[#9b9480]">
          <span className="flex-1">Ask AgentEnvoy or change the meeting…</span>
          <div
            className="w-[28px] h-[28px] rounded-full flex items-center justify-center text-white text-[12px] flex-shrink-0"
            style={{ background: "linear-gradient(180deg,#6366f1,#4f46e5)" }}
          >
            ↑
          </div>
        </div>
      </div>
    </>
  );
}
