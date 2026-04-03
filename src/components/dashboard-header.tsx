"use client";

import { useState, useEffect } from "react";
import { useSession } from "next-auth/react";
import Link from "next/link";
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

  // Determine actions needed
  const calendarConnected = connStatus?.google?.calendar ?? false;
  const hasPreferences =
    session?.user?.preferences &&
    Object.keys(session.user.preferences as Record<string, unknown>).length > 0;

  const actions: Array<{ label: string; href: string }> = [];
  if (connStatus && !calendarConnected) {
    actions.push({ label: "Connect your calendar", href: "/dashboard/profile" });
  }
  if (!hasPreferences) {
    actions.push({ label: "Set meeting preferences", href: "/dashboard/profile" });
  }

  return (
    <header className="sticky top-0 z-50 bg-[#0a0a0f]/95 backdrop-blur-sm border-b border-zinc-800 flex-shrink-0">
      <div className="px-4 sm:px-6 py-3 flex items-center justify-between gap-3">
        {/* Left: Logo */}
        <Link href="/" className="flex-shrink-0">
          <LogoFull height={24} className="text-zinc-100" />
        </Link>

        {/* Center: Meet link pill */}
        {meetUrl && (
          <button
            onClick={copyLink}
            className="hidden sm:flex items-center gap-2 bg-zinc-800/60 border border-zinc-700/50 rounded-full px-3.5 py-1.5 hover:border-purple-500/40 transition group max-w-[280px]"
          >
            <code className="text-purple-400 font-mono text-xs truncate">
              /meet/{meetSlug}
            </code>
            <span className="text-[10px] text-zinc-600 group-hover:text-zinc-400 transition flex-shrink-0">
              {copied ? (
                <span className="text-emerald-400">Copied!</span>
              ) : (
                "Copy"
              )}
            </span>
          </button>
        )}

        {/* Mobile: just a copy icon */}
        {meetUrl && (
          <button
            onClick={copyLink}
            className="flex sm:hidden items-center justify-center w-8 h-8 rounded-lg bg-zinc-800/60 border border-zinc-700/50 hover:border-purple-500/40 transition"
            title="Copy invite link"
          >
            {copied ? (
              <svg className="w-4 h-4 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            ) : (
              <svg className="w-4 h-4 text-purple-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m9.86-2.776a4.5 4.5 0 00-1.242-7.244l-4.5-4.5a4.5 4.5 0 00-6.364 6.364L4.25 8.016" />
              </svg>
            )}
          </button>
        )}

        {/* Right: Actions + Profile */}
        <div className="flex items-center gap-3">
          {/* Actions badge */}
          {actions.length > 0 && (
            <Link
              href={actions[0].href}
              className="hidden sm:flex items-center gap-1.5 bg-amber-500/10 border border-amber-500/20 rounded-full px-3 py-1 hover:border-amber-500/40 transition"
            >
              <div className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
              <span className="text-[11px] font-medium text-amber-300">
                {actions[0].label}
              </span>
            </Link>
          )}
          {/* Mobile: just a dot */}
          {actions.length > 0 && (
            <Link
              href={actions[0].href}
              className="flex sm:hidden items-center justify-center w-8 h-8 rounded-lg relative"
              title={actions[0].label}
            >
              <svg className="w-5 h-5 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
              </svg>
              <div className="absolute top-1 right-1 w-2 h-2 rounded-full bg-amber-400" />
            </Link>
          )}

          {/* Profile link */}
          <Link
            href="/dashboard/profile"
            className="flex items-center gap-2 hover:opacity-80 transition"
          >
            <span className="text-xs text-zinc-500 hidden sm:inline">
              {session?.user?.name}
            </span>
            {session?.user?.image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={session.user.image}
                alt=""
                className="w-7 h-7 rounded-full"
              />
            ) : (
              <div className="w-7 h-7 rounded-full bg-gradient-to-br from-indigo-500 to-purple-500 flex items-center justify-center">
                <span className="text-[10px] font-bold text-white">
                  {session?.user?.name?.charAt(0)?.toUpperCase() || "?"}
                </span>
              </div>
            )}
          </Link>
        </div>
      </div>
    </header>
  );
}
