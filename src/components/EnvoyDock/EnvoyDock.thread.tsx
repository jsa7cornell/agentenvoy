"use client";

/**
 * EnvoyDockThread — the expanded chat panel inside EnvoyDock.
 *
 * Rendered when dock `state === 'thread'`.
 * Height: flexible on mobile (min-h / max-h-based) so the iOS keyboard
 * doesn't push the panel off-screen. Fixed h-[400px] replaced with
 * min-h-[260px] max-h-[80vh] per Bug 3 fix (2026-05-11).
 *
 * Layout (top → bottom):
 *  - Thread header: 30px avatar (no animation) + name/status + collapse chevron
 *  - Scrollable message list: agent left / guest right
 *  - Input row: real <textarea> + send button, wired to onSendMessage
 *
 * Message bubble styles:
 *  - agent: surface-2 bg (#faf8f3) + border (#e7e2d5), left-aligned
 *  - guest: indigo-soft bg (#eef2ff) + indigo-line border (#c7d2fe), right-aligned
 *
 * Avatar colors:
 *  - agent: indigo→violet gradient (#6366f1 → #a855f7)
 *  - guest:  amber→rose gradient  (#fbbf24 → #f43f5e)
 *
 * Composer behaviour (Bug 3 fix 2026-05-11):
 *  - Real <textarea> (not a styled <div>) — iOS Safari focuses reliably.
 *  - Enter (no shift) → send and clear; Shift+Enter → newline.
 *  - onFocus → scrollIntoView({ block: "end" }) so the keyboard doesn't
 *    obscure the input on iOS Safari.
 *  - Send button (↑) triggers the same send path.
 *  - Draft text lives in local useState — not lifted to deal-room.tsx.
 *    This means draft survives incoming message polls (Bug 4 / (B) defensive fix).
 */

import { useEffect, useRef, useState } from "react";
import { Bot, User } from "lucide-react";
import type { Message } from "@/components/MeetingCard/types";
import { ThumbsDownFeedback } from "@/components/thumbs-down-feedback";
import { TurnCostOverlay } from "@/components/turn-cost-overlay";

export interface EnvoyDockThreadProps {
  messages: Message[];
  contextHostFirstName?: string;
  onCollapse?: () => void;
  onSendMessage?: (text: string) => void;
  /** First initial for host-sent bubbles. "·" → silhouette. */
  hostInitial?: string;
  /** First initial for guest-sent bubbles. "·" → silhouette. */
  guestInitial?: string;
  /**
   * Admin telemetry toggle. When true, agent (administrator-role) bubbles
   * render TurnCostOverlay + ThumbsDownFeedback below them. Mirrors the
   * dashboard chat (feed.tsx) admin surfaces. Default false.
   */
  isAdmin?: boolean;
  /**
   * NegotiationSession id — required for ThumbsDownFeedback to file reports
   * against the right thread. When null, the feedback button is suppressed.
   */
  sessionId?: string | null;
}

export function EnvoyDockThread({
  messages,
  contextHostFirstName,
  onCollapse,
  onSendMessage,
  hostInitial = "·",
  guestInitial = "·",
  isAdmin = false,
  sessionId = null,
}: EnvoyDockThreadProps) {
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const messageListRef = useRef<HTMLDivElement>(null);

  const subLine = contextHostFirstName
    ? `Online · scheduling for ${contextHostFirstName}`
    : "Online";

  // 2026-05-11 — keep the auto-scroll-to-latest CONTAINED to the inner
  // message list. The previous `scrollIntoView` walked every ancestor
  // scrollable, so every poll tick yanked the whole deal-room page to
  // the bottom (reported as "constantly snaps and jumps to bottom").
  // Setting scrollTop directly on the list element scrolls only that
  // element; the page stays where the user left it.
  useEffect(() => {
    const list = messageListRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [messages]);

  function handleSend() {
    const text = draft.trim();
    if (!text || !onSendMessage) return;
    onSendMessage(text);
    setDraft("");
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function handleFocus() {
    // Give the keyboard a tick to settle before scrolling — needed on iOS Safari.
    setTimeout(() => {
      inputRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
    }, 100);
  }

  return (
    <div
      className="relative rounded-2xl border border-[#dbd5c4] bg-white flex flex-col overflow-hidden min-h-[200px] max-h-[50vh]"
    >
      {/* Thread header */}
      <div
        className="flex items-center gap-[10px] px-4 py-2 border-b border-[#e7e2d5] flex-shrink-0"
        style={{ background: "linear-gradient(180deg,#eef2ff 0%,#ffffff 100%)" }}
      >
        {/* Smaller 30px avatar, no animation */}
        <div
          className="w-[30px] h-[30px] rounded-full flex items-center justify-center text-white flex-shrink-0"
          style={{
            background: "linear-gradient(135deg,#6366f1,#a855f7)",
            boxShadow: "0 2px 6px rgba(99,102,241,.3)",
          }}
        >
          <Bot size={15} strokeWidth={2} />
        </div>

        {/* Name + status */}
        <div className="flex-1">
          <div className="flex items-center gap-[6px] text-[13px] font-semibold text-[#1a1a2e]">
            <span className="w-[5px] h-[5px] rounded-full bg-[#10b981] flex-shrink-0" />
            AgentEnvoy
          </div>
          <div className="text-[11px] text-[#9b9480] mt-[1px]">{subLine}</div>
        </div>

        {/* Collapse chevron */}
        <button
          onClick={onCollapse}
          className="text-[18px] text-[#9b9480] cursor-pointer px-[6px] py-[2px] hover:text-[#1a1a2e] transition-colors"
          aria-label="Collapse chat"
        >
          ⌄
        </button>
      </div>

      {/* Message list */}
      <div ref={messageListRef} className="flex-1 overflow-y-auto px-4 py-2 flex flex-col gap-[8px]">
        {messages.length === 0 ? (
          <div className="text-[12px] text-[#9b9480] text-center mt-4">
            No messages yet.
          </div>
        ) : (
          messages.map((msg) => (
            <MessageBubble
              key={msg.id}
              msg={msg}
              hostInitial={hostInitial}
              guestInitial={guestInitial}
              isAdmin={isAdmin}
              sessionId={sessionId}
            />
          ))
        )}
      </div>

      {/* Input row — real <textarea> wired to onSendMessage (Bug 3 fix 2026-05-11).
          Previously a styled <div> placeholder that was never interactive. */}
      <div className="flex-shrink-0 border-t border-[#e7e2d5] px-[14px] py-2 flex items-end gap-2">
        <textarea
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={handleFocus}
          placeholder="Reply…"
          rows={1}
          className="flex-1 bg-[#faf8f3] border border-[#e7e2d5] rounded-[18px] px-[13px] py-[9px] text-[12.5px] text-[#1a1a2e] placeholder-[#9b9480] resize-none leading-snug outline-none focus:border-indigo-300 focus:ring-1 focus:ring-indigo-200 transition-colors"
          style={{ minHeight: "36px", maxHeight: "120px" }}
          aria-label="Reply to AgentEnvoy"
        />
        <button
          type="button"
          onClick={handleSend}
          disabled={!draft.trim() || !onSendMessage}
          aria-label="Send message"
          className="w-[32px] h-[32px] rounded-full flex items-center justify-center text-white text-[13px] flex-shrink-0 transition-opacity disabled:opacity-40"
          style={{ background: "linear-gradient(180deg,#6366f1,#4f46e5)" }}
        >
          ↑
        </button>
      </div>
    </div>
  );
}

function MessageBubble({
  msg,
  hostInitial,
  guestInitial,
  isAdmin,
  sessionId,
}: {
  msg: Message;
  hostInitial: string;
  guestInitial: string;
  isAdmin: boolean;
  sessionId: string | null;
}) {
  const isViewerSide = msg.role === "guest";

  const avatarStyle = isViewerSide
    ? { background: "linear-gradient(135deg,#fbbf24,#f43f5e)" }
    : { background: "linear-gradient(135deg,#6366f1,#a855f7)" };

  const bubbleClass = isViewerSide
    ? "bg-[#eef2ff] border border-[#c7d2fe] rounded-[13px] px-[11px] py-[8px] text-[12.5px] leading-[1.45] text-[#1a1a2e] max-w-[260px]"
    : "bg-[#faf8f3] border border-[#e7e2d5] rounded-[13px] px-[11px] py-[8px] text-[12.5px] leading-[1.45] text-[#1a1a2e] max-w-[260px]";

  // Bot icon for Envoy; for right-lane messages use senderRole to pick the
  // correct initial (host or guest). Fall back to silhouette when unknown.
  const rightInitial = msg.senderRole === "host" ? hostInitial : guestInitial;
  const avatarContent = !isViewerSide
    ? <Bot size={11} strokeWidth={2} />
    : rightInitial === "·"
      ? <User size={11} strokeWidth={2} />
      : <span className="text-[9.5px] font-bold">{rightInitial}</span>;

  return (
    <div className={`flex gap-2 items-start ${isViewerSide ? "flex-row-reverse" : ""}`}>
      <div
        className="w-[22px] h-[22px] rounded-full flex items-center justify-center text-white flex-shrink-0 mt-[2px]"
        style={avatarStyle}
      >
        {avatarContent}
      </div>
      <div>
        <div className={bubbleClass}>{msg.text}</div>
        <div
          className={`text-[10px] text-[#c9c2ae] mt-[2px] px-1 ${isViewerSide ? "text-right" : ""}`}
        >
          {msg.timestamp}
        </div>
        {/*
          Admin-only telemetry surfaces under agent bubbles. Mirrors the
          dashboard chat (feed.tsx) — TurnCostOverlay shows model tier +
          tool calls + cost + duration on demand; ThumbsDownFeedback files
          structured failure-mode reports against this turn's session id.
          Both render nothing when !isAdmin. The host-side viewer is the
          intended admin audience; guest-side viewers see no overlay even
          if they happen to be admins of a different session.
        */}
        {!isViewerSide && isAdmin && (
          <div className="flex items-center gap-1 mt-[2px]">
            <TurnCostOverlay metadata={msg.metadata ?? null} isAdmin={isAdmin} />
            <ThumbsDownFeedback sessionId={sessionId} messageContent={msg.text} />
          </div>
        )}
      </div>
    </div>
  );
}
