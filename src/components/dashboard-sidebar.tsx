"use client";

import { useState, useEffect } from "react";
import { signIn } from "next-auth/react";

interface ConnectionStatus {
  google: {
    connected: boolean;
    calendar: boolean;
    scopes: string[];
  };
}

interface DashboardSidebarProps {
  meetSlug?: string | null;
  userName?: string | null;
}

export function DashboardSidebar({
  meetSlug,
  userName,
}: DashboardSidebarProps) {
  const [connStatus, setConnStatus] = useState<ConnectionStatus | null>(null);
  const [copied, setCopied] = useState(false);

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

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {/* Meet Link Section */}
      <div className="px-4 pt-4 pb-3">
        <h4 className="text-[10px] font-bold uppercase tracking-widest text-zinc-500 mb-3">
          Your invite link
        </h4>
        {meetUrl ? (
          <div className="space-y-2">
            <button
              onClick={copyLink}
              className="w-full text-left bg-zinc-800/60 border border-zinc-700/50 rounded-xl px-3.5 py-3 hover:border-purple-500/40 transition group"
            >
              <div className="flex items-center justify-between">
                <code className="text-purple-400 font-mono text-xs">
                  /meet/{meetSlug}
                </code>
                <span className="text-[10px] text-zinc-600 group-hover:text-zinc-400 transition">
                  {copied ? (
                    <span className="text-emerald-400">Copied!</span>
                  ) : (
                    "Copy"
                  )}
                </span>
              </div>
              <p className="text-[10px] text-zinc-600 mt-1.5">
                Anyone with this link can schedule with you
              </p>
            </button>

          </div>
        ) : (
          <div className="text-xs text-zinc-600 bg-zinc-800/40 rounded-xl px-3.5 py-3 border border-zinc-800">
            No meet link configured
          </div>
        )}
      </div>

      {/* Divider */}
      <div className="mx-4 border-t border-zinc-800/60" />

      {/* Connections Section */}
      <div className="px-4 pt-3 pb-3">
        <h4 className="text-[10px] font-bold uppercase tracking-widest text-zinc-500 mb-3">
          Connections
        </h4>
        <div className="space-y-1.5">
          {/* Google Calendar */}
          <div
            className={`flex items-center gap-3 px-3 py-2.5 rounded-xl ${
              calendarConnected
                ? "bg-emerald-900/10 border border-emerald-700/30"
                : "bg-zinc-800/40 border border-zinc-800 hover:border-zinc-700"
            } transition`}
          >
            <div className="w-7 h-7 rounded-lg bg-white flex items-center justify-center flex-shrink-0">
              <svg viewBox="0 0 24 24" className="w-4 h-4">
                <path
                  d="M18.316 5.684H24v12.632h-5.684V5.684z"
                  fill="#1967D2"
                />
                <path
                  d="M5.684 18.316V5.684L0 5.684v12.632l5.684 0z"
                  fill="#188038"
                />
                <path
                  d="M18.316 24V18.316H5.684V24h12.632z"
                  fill="#1967D2"
                />
                <path
                  d="M18.316 5.684V0H5.684v5.684h12.632z"
                  fill="#EA4335"
                />
                <path
                  d="M18.316 18.316H5.684V5.684h12.632v12.632z"
                  fill="#fff"
                />
                <path
                  d="M9.2 15.7V9.1h1.5v2.4h2.6V9.1h1.5v6.6h-1.5v-2.8h-2.6v2.8H9.2z"
                  fill="#1967D2"
                />
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium text-zinc-200">
                Google Calendar
              </div>
              <div
                className={`text-[10px] mt-0.5 ${
                  calendarConnected ? "text-emerald-400" : "text-zinc-600"
                }`}
              >
                {calendarConnected ? "Connected" : "Not connected"}
              </div>
            </div>
            {calendarConnected ? (
              <div className="w-4 h-4 rounded-full bg-emerald-500/20 flex items-center justify-center flex-shrink-0">
                <svg
                  className="w-2.5 h-2.5 text-emerald-400"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={3}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M5 13l4 4L19 7"
                  />
                </svg>
              </div>
            ) : (
              <button
                onClick={() => signIn("google", { callbackUrl: "/dashboard" })}
                className="px-2.5 py-1 text-[10px] font-medium rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white transition flex-shrink-0"
              >
                Connect
              </button>
            )}
          </div>

          {/* AI Agent — coming soon */}
          <div className="flex items-center gap-3 px-3 py-2.5 rounded-xl bg-zinc-800/40 border border-zinc-800 opacity-50">
            <div className="w-7 h-7 rounded-lg bg-zinc-700 flex items-center justify-center flex-shrink-0">
              <svg
                className="w-3.5 h-3.5 text-zinc-400"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0112 15a9.065 9.065 0 00-6.23.693L5 14.5m14.8.8l1.402 1.402c1.232 1.232.65 3.318-1.067 3.611l-.772.13a18.142 18.142 0 01-15.126-3.617"
                />
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium text-zinc-400">AI Agent</div>
              <div className="text-[10px] text-zinc-600 mt-0.5">
                Coming soon
              </div>
            </div>
          </div>

          {/* Outlook / iCal — coming soon */}
          <div className="flex items-center gap-3 px-3 py-2.5 rounded-xl bg-zinc-800/40 border border-zinc-800 opacity-50">
            <div className="w-7 h-7 rounded-lg bg-zinc-700 flex items-center justify-center flex-shrink-0">
              <svg
                className="w-3.5 h-3.5 text-zinc-400"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5"
                />
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium text-zinc-400">
                Outlook / iCal
              </div>
              <div className="text-[10px] text-zinc-600 mt-0.5">
                Coming soon
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Divider */}
      <div className="mx-4 border-t border-zinc-800/60" />

      {/* Agent Info */}
      <div className="px-4 pt-3 pb-4">
        <h4 className="text-[10px] font-bold uppercase tracking-widest text-zinc-500 mb-3">
          Your agent
        </h4>
        <div className="bg-zinc-800/40 border border-zinc-800 rounded-xl px-3.5 py-3">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-5 h-5 rounded-full bg-gradient-to-br from-indigo-500 to-purple-500 flex items-center justify-center">
              <span className="text-[9px] font-bold text-white">
                {userName?.charAt(0)?.toUpperCase() || "?"}
              </span>
            </div>
            <span className="text-xs font-medium text-zinc-200">
              {userName ? `${userName}'s Envoy` : "Your Envoy"}
            </span>
          </div>
          <p className="text-[10px] text-zinc-600 leading-relaxed">
            Your AgentEnvoy administrator handles all scheduling negotiations.
            Configure preferences by chatting in the feed.
          </p>
        </div>
      </div>

      {/* Footer disclaimer */}
      <div className="mt-auto px-4 py-3 border-t border-zinc-800/40">
        <p className="text-[9px] text-zinc-700 leading-relaxed">
          AgentEnvoy reads your calendar availability and creates events on your
          behalf. Your data is never shared with other users.
        </p>
      </div>
    </div>
  );
}
