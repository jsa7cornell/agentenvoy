"use client";

import { useState, useEffect, useRef } from "react";
import { signIn } from "next-auth/react";

interface ConnectionStatus {
  google: {
    connected: boolean;
    calendar: boolean;
    scopes: string[];
  };
}

export function ConnectionsMenu() {
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/api/connections/status")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data) setStatus(data);
      })
      .catch(() => {});
  }, []);

  // Close on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const calendarConnected = status?.google?.calendar ?? false;
  const connectionCount = calendarConnected ? 1 : 0;

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setOpen(!open)}
        className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs font-medium transition ${
          calendarConnected
            ? "border-emerald-700/50 bg-emerald-900/20 text-emerald-400 hover:border-emerald-600"
            : "border-amber-700/50 bg-amber-900/20 text-amber-400 hover:border-amber-600"
        }`}
      >
        <svg
          className="w-3.5 h-3.5"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"
          />
        </svg>
        {calendarConnected ? (
          <span>
            {connectionCount} Connected
          </span>
        ) : (
          <span>Connect Calendar</span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-80 bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl shadow-black/50 z-50 overflow-hidden">
          <div className="px-4 py-3 border-b border-zinc-800">
            <h3 className="text-sm font-semibold text-zinc-100">
              Connections
            </h3>
            <p className="text-xs text-zinc-500 mt-0.5">
              Connect services so AgentEnvoy can schedule smarter
            </p>
          </div>

          <div className="p-2 space-y-1">
            {/* Google Calendar */}
            <div
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg ${
                calendarConnected
                  ? "bg-emerald-900/10"
                  : "bg-zinc-800/50 hover:bg-zinc-800"
              }`}
            >
              <div className="w-8 h-8 rounded-lg bg-white flex items-center justify-center flex-shrink-0">
                <svg viewBox="0 0 24 24" className="w-5 h-5">
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
                <div className="text-sm font-medium text-zinc-200">
                  Google Calendar
                </div>
                <div
                  className={`text-xs mt-0.5 ${
                    calendarConnected ? "text-emerald-400" : "text-zinc-500"
                  }`}
                >
                  {calendarConnected
                    ? "Connected — reading your availability"
                    : "Not connected"}
                </div>
              </div>
              {calendarConnected ? (
                <div className="w-5 h-5 rounded-full bg-emerald-500/20 flex items-center justify-center flex-shrink-0">
                  <svg
                    className="w-3 h-3 text-emerald-400"
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
                  onClick={() => {
                    signIn("google", { callbackUrl: "/dashboard" });
                  }}
                  className="px-3 py-1 text-xs font-medium rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white transition flex-shrink-0"
                >
                  Connect
                </button>
              )}
            </div>

            {/* Future: Agent connection */}
            <div className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-zinc-800/50 opacity-60">
              <div className="w-8 h-8 rounded-lg bg-zinc-700 flex items-center justify-center flex-shrink-0">
                <svg
                  className="w-4 h-4 text-zinc-400"
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
                <div className="text-sm font-medium text-zinc-400">
                  AI Agent
                </div>
                <div className="text-xs text-zinc-600 mt-0.5">
                  Coming soon — connect your own agent
                </div>
              </div>
            </div>

            {/* Future: Other calendars */}
            <div className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-zinc-800/50 opacity-60">
              <div className="w-8 h-8 rounded-lg bg-zinc-700 flex items-center justify-center flex-shrink-0">
                <svg
                  className="w-4 h-4 text-zinc-400"
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
                <div className="text-sm font-medium text-zinc-400">
                  Outlook / iCal
                </div>
                <div className="text-xs text-zinc-600 mt-0.5">
                  Coming soon
                </div>
              </div>
            </div>
          </div>

          <div className="px-4 py-2.5 border-t border-zinc-800 bg-zinc-900/50">
            <p className="text-[10px] text-zinc-600">
              Connections let AgentEnvoy read your availability and create events on your behalf.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
