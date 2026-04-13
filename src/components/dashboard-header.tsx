"use client";

import { useState, useEffect } from "react";
import { useSession } from "next-auth/react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { LogoFull } from "./logo";

interface ConnectionStatus {
  google: {
    connected: boolean;
    calendar: boolean;
    scopes: string[];
  };
}

export function DashboardHeader() {
  const { data: session } = useSession();
  const pathname = usePathname();
  const [copied, setCopied] = useState(false);
  const [connStatus, setConnStatus] = useState<ConnectionStatus | null>(null);

  const meetSlug = session?.user?.meetSlug;
  const meetUrl = meetSlug
    ? `${typeof window !== "undefined" ? window.location.origin : ""}/meet/${meetSlug}`
    : null;

  useEffect(() => {
    fetch("/api/connections/status")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data) setConnStatus(data);
      })
      .catch(() => {});
  }, []);

  function copyLink() {
    if (meetUrl) {
      navigator.clipboard.writeText(meetUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  const calendarConnected = connStatus?.google?.calendar ?? false;
  const hasPreferences =
    session?.user?.preferences &&
    Object.keys(session.user.preferences as Record<string, unknown>).length > 0;

  const showAction = (connStatus && !calendarConnected) || !hasPreferences;
  const actionLabel = connStatus && !calendarConnected ? "Connect calendar" : "Set preferences";

  const isAvailability = pathname.startsWith("/dashboard/availability");
  const isMeetings = pathname.startsWith("/dashboard/meetings");
  const isAccount = pathname.startsWith("/dashboard/account");
  const isDashboard = pathname === "/dashboard" || pathname === "/dashboard/";

  return (
    <header className="sticky top-0 z-50 bg-surface/95 backdrop-blur-sm border-b border-secondary flex-shrink-0">
      <div className="px-4 sm:px-6 py-2.5 flex items-center gap-3">
        {/* Logo → Dashboard */}
        <Link
          href="/dashboard"
          className={`flex-shrink-0 transition ${isDashboard ? "opacity-100" : "opacity-60 hover:opacity-100"}`}
          title="Dashboard"
        >
          <LogoFull height={22} className="text-primary" />
        </Link>

        {/* Meet link pill — desktop */}
        {meetUrl && (
          <button
            onClick={copyLink}
            className="hidden sm:flex items-center gap-2 bg-surface-secondary/60 border border-surface-tertiary/50 rounded-full px-3 py-1 hover:border-purple-500/40 transition group max-w-[240px]"
          >
            <code className="text-purple-400 font-mono text-xs truncate">
              /meet/{meetSlug}
            </code>
            <span className="text-[10px] text-muted group-hover:text-secondary transition flex-shrink-0">
              {copied ? (
                <span className="text-emerald-400">Copied!</span>
              ) : (
                "Copy"
              )}
            </span>
          </button>
        )}

        {/* Mobile: copy icon */}
        {meetUrl && (
          <button
            onClick={copyLink}
            className="flex sm:hidden items-center justify-center w-7 h-7 rounded-lg bg-surface-secondary/60 border border-surface-tertiary/50 hover:border-purple-500/40 transition"
            title="Copy invite link"
          >
            {copied ? (
              <svg className="w-3.5 h-3.5 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            ) : (
              <svg className="w-3.5 h-3.5 text-purple-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m9.86-2.776a4.5 4.5 0 00-1.242-7.244l-4.5-4.5a4.5 4.5 0 00-6.364 6.364L4.25 8.016" />
              </svg>
            )}
          </button>
        )}

        {/* Spacer */}
        <div className="flex-1" />

        {/* Action badge — compact */}
        {showAction && (
          <Link
            href="/dashboard/account"
            className="hidden sm:flex items-center gap-1.5 bg-amber-500/10 border border-amber-500/20 rounded-full px-2.5 py-1 hover:border-amber-500/40 transition"
          >
            <div className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
            <span className="text-[10px] font-medium text-amber-600 dark:text-amber-300">
              {actionLabel}
            </span>
          </Link>
        )}

        {/* Availability */}
        <Link
          href="/dashboard/availability"
          className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 transition ${
            isAvailability
              ? "bg-accent/15 text-accent"
              : "text-muted hover:text-secondary hover:bg-surface-secondary/60"
          }`}
          title="Availability"
        >
          <svg className="w-[16px] h-[16px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5" />
          </svg>
          <span className="text-xs font-medium hidden sm:inline">Availability</span>
        </Link>

        {/* Meetings */}
        <Link
          href="/dashboard/meetings"
          className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 transition ${
            isMeetings
              ? "bg-accent/15 text-accent"
              : "text-muted hover:text-secondary hover:bg-surface-secondary/60"
          }`}
          title="Meetings"
        >
          <svg className="w-[16px] h-[16px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M18 18.72a9.094 9.094 0 003.741-.479 3 3 0 00-4.682-2.72m.94 3.198l.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0112 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 016 18.719m12 0a5.971 5.971 0 00-.941-3.197m0 0A5.995 5.995 0 0012 12.75a5.995 5.995 0 00-5.058 2.772m0 0a3 3 0 00-4.681 2.72 8.986 8.986 0 003.74.477m.94-3.197a5.971 5.971 0 00-.94 3.197M15 6.75a3 3 0 11-6 0 3 3 0 016 0zm6 3a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0zm-13.5 0a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0z" />
          </svg>
          <span className="text-xs font-medium hidden sm:inline">Meetings</span>
        </Link>

        {/* Profile → Account */}
        <Link
          href="/dashboard/account"
          className={`flex items-center gap-2 rounded-lg px-2 py-1 transition ${
            isAccount
              ? "bg-accent/10"
              : "hover:bg-surface-secondary/60"
          }`}
          title="My Account"
        >
          {session?.user?.image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={session.user.image}
              alt=""
              className={`w-7 h-7 rounded-full ${isAccount ? "ring-2 ring-accent" : ""}`}
            />
          ) : (
            <div className={`w-7 h-7 rounded-full bg-gradient-to-br from-indigo-500 to-purple-500 flex items-center justify-center ${isAccount ? "ring-2 ring-accent" : ""}`}>
              <span className="text-[10px] font-bold text-white">
                {session?.user?.name?.charAt(0)?.toUpperCase() || "?"}
              </span>
            </div>
          )}
          <span className="text-xs text-muted hidden sm:inline">
            {session?.user?.name?.split(" ")[0]}
          </span>
        </Link>
      </div>
    </header>
  );
}
