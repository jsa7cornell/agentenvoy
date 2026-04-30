"use client";

import { useEffect, useState } from "react";
import { canNativeShare, shareInvite } from "@/lib/share-invite";

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
  /** Optional deferral status line ("🤔 Gathering John's suggestions on the
   *  location"). Rendered below the subtitle when host has deferred fields
   *  to the guest via guestPicks. Caller suppresses post-confirm. */
  deferralLine?: string;
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
  /** True when the link has been flagged as a VIP meeting. Renders a single
   *  purple VIP badge in the title row. No tier ladder — VIP is binary. */
  isVip?: boolean;
  /** Activity icon emoji (e.g. "🚴", "🏄") from link.parameters.activityIcon. When
   *  provided, prefixes the card header. Canonical set (per CODEBASE-CLEANUP
   *  §22): 🚴 bike · 🏄 surf · ☕ coffee · 🍽️ dinner · 💻 video · 📱 phone ·
   *  📍 in-person · 👤 1:1. Fallback when unset is 🕐 (clock). */
  activityIcon?: string;
  /** Short TZ label (e.g. "CEST", "JST") detected from the guest's browser on
   *  first visit. When set, shows as a small "guest in X" chip so the host can
   *  see the timezone context at a glance. */
  guestTimezoneLabel?: string | null;
  /** Named invitees on the link. When length > 1, a 👥 count chip renders in
   *  the title row so multi-person invites are visually distinct from 1:1s. */
  inviteeCount?: number;
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
  deferralLine,
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
  isVip = false,
  activityIcon,
  guestTimezoneLabel,
  inviteeCount,
}: ThreadCardProps) {
  const style = STATUS_STYLES[statusColor] || STATUS_STYLES.gray;
  const [linkCopied, setLinkCopied] = useState(false);
  const [shareSupported, setShareSupported] = useState(false);
  useEffect(() => {
    setShareSupported(canNativeShare());
  }, []);

  // Display shaping for the status chip:
  //   - Confirmed meetings get a green check badge up top (in the header row)
  //     instead of the footer pill — John felt a bottom-corner "CONFIRMED"
  //     was easy to miss.
  //   - Freshly-created links with no guest engagement yet (no messages)
  //     hide the pill entirely. The prior "Waiting for <Name>" pill misled
  //     hosts into thinking Envoy had already emailed the guest.
  const isConfirmed = statusLabel === "Confirmed" || (statusLabel === "Ready to confirm" && statusColor === "green");
  const isFreshPreEngagement =
    !isConfirmed && (messageCount === undefined || messageCount === 0);
  const showFooterStatusPill = !isConfirmed && !isFreshPreEngagement && !!statusLabel;

  const meetPath = linkCode ? `/meet/${linkSlug}/${linkCode}` : linkSlug ? `/meet/${linkSlug}` : null;

  function copyLink(e: React.MouseEvent) {
    e.stopPropagation();
    if (!meetPath) return;
    const fullUrl = `${window.location.origin}${meetPath}`;
    navigator.clipboard.writeText(fullUrl);
    setLinkCopied(true);
    setTimeout(() => setLinkCopied(false), 2000);
  }

  function shareLink(e: React.MouseEvent) {
    e.stopPropagation();
    if (!meetPath) return;
    const fullUrl = `${window.location.origin}${meetPath}`;
    void shareInvite({ url: fullUrl, topic: title });
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
          : "border-black/15 dark:border-white/15 bg-black/[0.02] dark:bg-white/[0.03] hover:border-purple-500/40 hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"
        }
      `}
    >
      {/* Header */}
      <div className="flex items-start gap-3 px-4 pt-3.5 pb-2">
        <div className="w-8 h-8 rounded-lg bg-purple-500/12 flex items-center justify-center text-sm flex-shrink-0">
          {activityIcon
            ? <span role="img">{activityIcon}</span>
            : <span role="img" aria-label="clock">&#128336;</span>
          }
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0">
            <div className="text-sm font-semibold text-primary truncate flex-1">{title}</div>
            {isConfirmed && (
              <span
                className="flex-shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide bg-green-500/15 text-green-400"
                title="Meeting confirmed"
              >
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                </svg>
                Confirmed
              </span>
            )}
            {/* VIP badge — only rendered when the link is flagged VIP.
                Binary flag; no tier ladder. Default non-VIP case stays
                visually quiet. */}
            {inviteeCount !== undefined && inviteeCount > 1 && (
              <span
                className="flex-shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-purple-500/12 text-purple-300"
                title={`${inviteeCount} invitees`}
              >
                <span role="img" aria-label="group">👥</span>
                {inviteeCount}
              </span>
            )}
            {isVip && (
              <span
                className="flex-shrink-0 px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide bg-purple-500/15 text-purple-400"
                title="VIP meeting — Envoy proactively asks about opening extra hours and can offer protected slots if the guest pushes back"
              >
                VIP
              </span>
            )}
          </div>
          {subtitle && (
            <div className="text-xs text-muted mt-0.5 truncate">{subtitle}</div>
          )}
          {deferralLine && (
            <div className="text-xs italic text-muted mt-0.5 truncate">{deferralLine}</div>
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
        <div className="px-4 pb-2 flex items-center gap-3">
          <button
            onClick={copyLink}
            className="flex items-center gap-1.5 text-[11px] text-muted hover:text-purple-400 transition group min-w-0"
          >
            <svg className="w-3 h-3 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m9.86-2.776a4.5 4.5 0 00-1.242-7.244l-4.5-4.5a4.5 4.5 0 00-6.364 6.364L4.25 8.016" />
            </svg>
            <code className="font-mono truncate">{meetPath}</code>
            {linkCopied && (
              <span className="text-emerald-400 flex-shrink-0">Copied!</span>
            )}
          </button>
          {shareSupported && (
            <button
              onClick={shareLink}
              className="sm:hidden text-[11px] font-semibold uppercase tracking-wide text-purple-400 hover:text-purple-300 transition flex-shrink-0"
              aria-label={`Share ${title}`}
            >
              Share
            </button>
          )}
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
          {showFooterStatusPill && (
            <span
              className={`px-2.5 py-0.5 rounded-full text-[11px] font-semibold uppercase tracking-wide ${style.bg} ${style.text}`}
            >
              {statusLabel}
            </span>
          )}
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
