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
import type { Message } from "@/components/MeetingCard/types";

export interface EnvoyDockThreadProps {
  messages: Message[];
  contextHostFirstName?: string;
  onCollapse?: () => void;
  onSendMessage?: (text: string) => void;
}

export function EnvoyDockThread({
  messages,
  contextHostFirstName,
  onCollapse,
  onSendMessage,
}: EnvoyDockThreadProps) {
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const subLine = contextHostFirstName
    ? `Online · scheduling for ${contextHostFirstName}`
    : "Online";

  // Bug 4 fix (2026-05-11): scroll to the latest message whenever the messages
  // array changes (new message arrives on poll, or after the user sends).
  // Uses "auto" behavior so there's no animation lag; "smooth" can fight iOS's
  // own scroll inertia and look jittery on a fast poll cycle.
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: "end", behavior: "auto" });
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
      className="relative rounded-2xl border border-[#dbd5c4] bg-white flex flex-col overflow-hidden min-h-[260px] max-h-[80vh]"
    >
      {/* Thread header */}
      <div
        className="flex items-center gap-[10px] px-4 py-3 border-b border-[#e7e2d5] flex-shrink-0"
        style={{ background: "linear-gradient(180deg,#eef2ff 0%,#ffffff 100%)" }}
      >
        {/* Smaller 30px avatar, no animation */}
        <div
          className="w-[30px] h-[30px] rounded-full flex items-center justify-center text-white text-[12px] font-bold flex-shrink-0"
          style={{
            background: "linear-gradient(135deg,#6366f1,#a855f7)",
            boxShadow: "0 2px 6px rgba(99,102,241,.3)",
          }}
        >
          A
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
      <div className="flex-1 overflow-y-auto px-4 py-[14px] flex flex-col gap-[10px]">
        {messages.length === 0 ? (
          <div className="text-[12px] text-[#9b9480] text-center mt-4">
            No messages yet.
          </div>
        ) : (
          messages.map((msg) => (
            <MessageBubble key={msg.id} msg={msg} />
          ))
        )}
        {/* Scroll anchor — scrolled into view when new messages arrive */}
        <div ref={messagesEndRef} />
      </div>

      {/* Input row — real <textarea> wired to onSendMessage (Bug 3 fix 2026-05-11).
          Previously a styled <div> placeholder that was never interactive. */}
      <div className="flex-shrink-0 border-t border-[#e7e2d5] px-[14px] py-[10px] pb-3 flex items-end gap-2">
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

function MessageBubble({ msg }: { msg: Message }) {
  const isGuest = msg.role === "guest";

  const avatarStyle = isGuest
    ? { background: "linear-gradient(135deg,#fbbf24,#f43f5e)" }
    : { background: "linear-gradient(135deg,#6366f1,#a855f7)" };

  const bubbleClass = isGuest
    ? "bg-[#eef2ff] border border-[#c7d2fe] rounded-[13px] px-[11px] py-[8px] text-[12.5px] leading-[1.45] text-[#1a1a2e] max-w-[260px]"
    : "bg-[#faf8f3] border border-[#e7e2d5] rounded-[13px] px-[11px] py-[8px] text-[12.5px] leading-[1.45] text-[#1a1a2e] max-w-[260px]";

  const avatarLetter = isGuest ? "S" : "A";

  return (
    <div className={`flex gap-2 items-start ${isGuest ? "flex-row-reverse" : ""}`}>
      <div
        className="w-[22px] h-[22px] rounded-full flex items-center justify-center text-white text-[9.5px] font-bold flex-shrink-0 mt-[2px]"
        style={avatarStyle}
      >
        {avatarLetter}
      </div>
      <div>
        <div className={bubbleClass}>{msg.text}</div>
        <div
          className={`text-[10px] text-[#c9c2ae] mt-[2px] px-1 ${isGuest ? "text-right" : ""}`}
        >
          {msg.timestamp}
        </div>
      </div>
    </div>
  );
}
