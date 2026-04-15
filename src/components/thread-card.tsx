"use client";

import { useState } from "react";

interface Participant {
  name: string | null;
  status: string;
  role: string;
}

interface ThreadCardProps {
  title: string;
  statusLabel: string;
  statusColor: string;
  subtitle?: string;
  inviteeName?: string;
  inviteeEmail?: string;
  messageCount?: number;
  lastActivity?: string;
  linkSlug?: string;
  linkCode?: string;
  canArchive?: boolean;
  onArchive?: () => void;
  selected?: boolean;
  onClick?: () => void;
  isGroupEvent?: boolean;
  participants?: Participant[];
  /** Link priority — shows a badge on the card when "high" or "vip". */
  priority?: "normal" | "high" | "vip";
  /** Short TZ label (e.g. "CEST", "JST") detected from the guest's browser on
   *  first visit. When set, shows as a small "guest in X" chip so the host can
   *  see the timezone context at a glance. */
  guestTimezoneLabel?: string | null;
}

const STATUS_STYLES: Record<string, { bg: string; text: string }> = {
  amber: { bg: "bg-yellow-500/10", text: "text-yellow-400" },
  purple: { bg: "bg-purple-500/10", text: "text-purple-400" },
  green: { bg: "bg-green-500/10", text: "text-green-400" },
  orange: { bg: "bg-orange-500/10", text: "text-orange-400" },
  red: { bg: "bg-red-500/10", text: "text-red-400" },
  gray: { bg: "bg-gray-500/10", text: "text-gray-400" },
};

const PARTICIPANT_DOT: Record<string, string> = {
  agreed: "bg-green-400",
  active: "bg-amber-400",
  pending: "bg-gray-400",
  declined: "bg-red-400",
};

export default function ThreadCard({
  title,
  statusLabel,
  statusColor,
  subtitle,
  inviteeName,
  inviteeEmail,
  messageCount,
  lastActivity,
  linkSlug,
  linkCode,
  canArchive,
  onArchive,
  selected,
  onClick,
  isGroupEvent,
  participants,
  priority = "normal",
  guestTimezoneLabel,
}: ThreadCardProps) {
  const style = STATUS_STYLES[statusColor] || STATUS_STYLES.gray;
  const [linkCopied, setLinkCopied] = useState(false);

  const meetPath = linkCode ? `/meet/${linkSlug}/${linkCode}` : linkSlug ? `/meet/${linkSlug}` : null;

  function copyLink(e: React.MouseEvent) {
    e.stopPropagation();
    if (!meetPath) return;
    const fullUrl = `${window.location.origin}${meetPath}`;
    navigator.clipboard.writeText(fullUrl);
    setLinkCopied(true);
    setTimeout(() => setLinkCopied(false), 2000);
  }

  function handleArchive(e: React.MouseEvent) {
    e.stopPropagation();
    onArchive?.();
  }

  return (
    <div
      onClick={onClick}
      className={`
        w-full max-w-[440px] rounded-2xl border cursor-pointer transition-all duration-200
        ${selected
          ? "border-purple-500/60 bg-purple-500/5"
          : "border-black/8 dark:border-white/8 bg-black/[0.02] dark:bg-white/[0.03] hover:border-purple-500/30 hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"
        }
      `}
    >
      {/* Header */}
      <div className="flex items-start gap-3 px-4 pt-3.5 pb-2">
        <div className="w-8 h-8 rounded-lg bg-purple-500/12 flex items-center justify-center text-sm flex-shrink-0">
          <span role="img" aria-label="calendar">&#128197;</span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0">
            <div className="text-sm font-semibold text-primary truncate flex-1">{title}</div>
            {/* Priority badge — only rendered for high/vip so the default
                "normal" case stays visually quiet. Colors track the tier:
                amber for "making room" (high), purple for "cleared space" (vip). */}
            {priority === "high" && (
              <span
                className="flex-shrink-0 px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide bg-amber-500/15 text-amber-400"
                title="High priority — host has opened weekend daytime and just-outside-biz hours for this guest"
              >
                High
              </span>
            )}
            {priority === "vip" && (
              <span
                className="flex-shrink-0 px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide bg-purple-500/15 text-purple-400"
                title="VIP — host has cleared early-morning, late-evening, and weekend off-hours for this guest"
              >
                VIP
              </span>
            )}
          </div>
          {subtitle && (
            <div className="text-xs text-muted mt-0.5 truncate">{subtitle}</div>
          )}
        </div>
      </div>

      {/* Participants (group events) */}
      {isGroupEvent && participants && participants.length > 0 && (
        <div className="flex flex-wrap gap-2 px-4 pb-2">
          {participants.filter((p) => p.role === "guest").map((p, i) => (
            <span key={i} className="flex items-center gap-1 text-xs text-secondary">
              <span className={`w-1.5 h-1.5 rounded-full ${PARTICIPANT_DOT[p.status] || PARTICIPANT_DOT.pending}`} />
              {p.name || "Unknown"}
            </span>
          ))}
        </div>
      )}

      {/* Meta */}
      <div className="flex gap-3 px-4 pb-2 text-xs text-muted items-center">
        {!isGroupEvent && inviteeEmail && <span>{inviteeEmail}</span>}
        {messageCount !== undefined && messageCount > 0 && (
          <span>{messageCount} messages</span>
        )}
        {guestTimezoneLabel && (
          <span
            className="inline-flex items-center gap-1 text-[11px]"
            title={`Guest opened this deal room from ${guestTimezoneLabel}`}
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 2a10 10 0 100 20 10 10 0 000-20zm0 0v20m-10-10h20" />
            </svg>
            {guestTimezoneLabel}
          </span>
        )}
      </div>

      {/* Invite link */}
      {meetPath && (
        <div className="px-4 pb-2">
          <button
            onClick={copyLink}
            className="flex items-center gap-1.5 text-[11px] text-muted hover:text-purple-400 transition group"
          >
            <svg className="w-3 h-3 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m9.86-2.776a4.5 4.5 0 00-1.242-7.244l-4.5-4.5a4.5 4.5 0 00-6.364 6.364L4.25 8.016" />
            </svg>
            <code className="font-mono truncate">{meetPath}</code>
            {linkCopied && (
              <span className="text-emerald-400 flex-shrink-0">Copied!</span>
            )}
          </button>
        </div>
      )}

      {/* Last activity preview */}
      {lastActivity && (
        <div className="flex items-center gap-2 px-4 py-2 border-t border-black/5 dark:border-white/5 text-xs text-secondary">
          {inviteeName && (
            <div className="w-5 h-5 rounded-full bg-green-500/15 flex items-center justify-center text-[10px] font-semibold text-green-400 flex-shrink-0">
              {inviteeName.charAt(0).toUpperCase()}
            </div>
          )}
          <span className="truncate">{lastActivity}</span>
        </div>
      )}

      {/* Footer */}
      <div className="flex items-center justify-between px-4 py-2.5 border-t border-black/5 dark:border-white/5">
        <div className="flex items-center gap-2">
          <span
            className={`px-2.5 py-0.5 rounded-full text-[11px] font-semibold uppercase tracking-wide ${style.bg} ${style.text}`}
          >
            {statusLabel}
          </span>
          {canArchive && onArchive && (
            <button
              onClick={handleArchive}
              className="p-1 rounded-lg text-muted hover:text-secondary hover:bg-surface-secondary/60 transition"
              title="Archive"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5m8.25 3v6.75m0 0l-3-3m3 3l3-3M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z" />
              </svg>
            </button>
          )}
        </div>
        <span className="text-xs text-purple-400 font-medium">
          View conversation &rarr;
        </span>
      </div>
    </div>
  );
}
