"use client";

interface ThreadCardProps {
  title: string;
  statusLabel: string;
  statusColor: string; // "amber" | "purple" | "green" | "orange" | "red" | "gray"
  subtitle?: string;
  inviteeName?: string;
  inviteeEmail?: string;
  messageCount?: number;
  lastActivity?: string;
  threadUrl?: string;
  selected?: boolean;
  onClick?: () => void;
}

const STATUS_STYLES: Record<string, { bg: string; text: string }> = {
  amber: { bg: "bg-yellow-500/10", text: "text-yellow-400" },
  purple: { bg: "bg-purple-500/10", text: "text-purple-400" },
  green: { bg: "bg-green-500/10", text: "text-green-400" },
  orange: { bg: "bg-orange-500/10", text: "text-orange-400" },
  red: { bg: "bg-red-500/10", text: "text-red-400" },
  gray: { bg: "bg-gray-500/10", text: "text-gray-400" },
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
  selected,
  onClick,
}: ThreadCardProps) {
  const style = STATUS_STYLES[statusColor] || STATUS_STYLES.gray;

  return (
    <div
      onClick={onClick}
      className={`
        w-full max-w-[440px] rounded-2xl border cursor-pointer transition-all duration-200
        ${selected
          ? "border-purple-500/60 bg-purple-500/5"
          : "border-white/8 bg-white/[0.03] hover:border-purple-500/30 hover:bg-white/[0.05]"
        }
      `}
    >
      {/* Header */}
      <div className="flex items-start gap-3 px-4 pt-3.5 pb-2">
        <div className="w-8 h-8 rounded-lg bg-purple-500/12 flex items-center justify-center text-sm flex-shrink-0">
          <span role="img" aria-label="calendar">&#128197;</span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-gray-100 truncate">{title}</div>
          {subtitle && (
            <div className="text-xs text-gray-500 mt-0.5 truncate">{subtitle}</div>
          )}
        </div>
      </div>

      {/* Meta */}
      <div className="flex gap-3 px-4 pb-2 text-xs text-gray-500">
        {inviteeEmail && <span>{inviteeEmail}</span>}
        {messageCount !== undefined && messageCount > 0 && (
          <span>{messageCount} messages</span>
        )}
      </div>

      {/* Last activity preview */}
      {lastActivity && (
        <div className="flex items-center gap-2 px-4 py-2 border-t border-white/5 text-xs text-gray-400">
          {inviteeName && (
            <div className="w-5 h-5 rounded-full bg-green-500/15 flex items-center justify-center text-[10px] font-semibold text-green-400 flex-shrink-0">
              {inviteeName.charAt(0).toUpperCase()}
            </div>
          )}
          <span className="truncate">{lastActivity}</span>
        </div>
      )}

      {/* Footer */}
      <div className="flex items-center justify-between px-4 py-2.5 border-t border-white/5">
        <span
          className={`px-2.5 py-0.5 rounded-full text-[11px] font-semibold uppercase tracking-wide ${style.bg} ${style.text}`}
        >
          {statusLabel}
        </span>
        <span className="text-xs text-purple-400 font-medium">
          Open thread &rarr;
        </span>
      </div>
    </div>
  );
}
