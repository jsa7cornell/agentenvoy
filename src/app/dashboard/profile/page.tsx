"use client";

import { useSession, signIn, signOut } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { DashboardHeader } from "@/components/dashboard-header";
import Link from "next/link";

interface ConnectionStatus {
  google: {
    connected: boolean;
    calendar: boolean;
    scopes: string[];
  };
}

interface KnowledgeState {
  persistentKnowledge: string;
  situationalKnowledge: string;
  preview: string;
}

export default function ProfilePage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const [connStatus, setConnStatus] = useState<ConnectionStatus | null>(null);
  const [, setKnowledge] = useState<KnowledgeState | null>(null);
  const [persistent, setPersistent] = useState("");
  const [situational, setSituational] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");

  useEffect(() => {
    if (status === "unauthenticated") router.push("/");
  }, [status, router]);

  useEffect(() => {
    fetch("/api/connections/status")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => { if (data) setConnStatus(data); })
      .catch(() => {});

    fetch("/api/agent/knowledge")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: KnowledgeState | null) => {
        if (data) {
          setKnowledge(data);
          setPersistent(data.persistentKnowledge);
          setSituational(data.situationalKnowledge);
        }
      })
      .catch(() => {});
  }, []);

  const calendarConnected = connStatus?.google?.calendar ?? false;

  async function handleSaveKnowledge() {
    if (saving) return;
    setSaving(true);
    setSaveMessage("");
    try {
      const res = await fetch("/api/agent/knowledge", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          persistentKnowledge: persistent,
          situationalKnowledge: situational,
        }),
      });
      if (res.ok) {
        setSaveMessage("Saved");
        setTimeout(() => setSaveMessage(""), 2000);
      } else {
        setSaveMessage("Failed to save");
      }
    } catch {
      setSaveMessage("Failed to save");
    } finally {
      setSaving(false);
    }
  }

  if (status === "loading" || !session) {
    return (
      <div className="min-h-screen bg-[#0a0a0f] flex items-center justify-center">
        <div className="text-zinc-500">Loading...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0a0a0f] text-zinc-100 flex flex-col">
      <DashboardHeader />

      <div className="max-w-2xl mx-auto w-full px-4 sm:px-6 py-8 space-y-8">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            {session.user?.image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={session.user.image} alt="" className="w-12 h-12 rounded-full" />
            ) : (
              <div className="w-12 h-12 rounded-full bg-gradient-to-br from-indigo-500 to-purple-500 flex items-center justify-center">
                <span className="text-lg font-bold text-white">
                  {session.user?.name?.charAt(0)?.toUpperCase() || "?"}
                </span>
              </div>
            )}
            <div>
              <h1 className="text-lg font-semibold">{session.user?.name}</h1>
              <p className="text-sm text-zinc-500">{session.user?.email}</p>
            </div>
          </div>
          <button
            onClick={() => signOut({ callbackUrl: "/" })}
            className="text-xs text-zinc-600 hover:text-zinc-400 transition"
          >
            Sign out
          </button>
        </div>

        {/* Connections */}
        <section>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-500 mb-3">
            Connections
          </h2>
          <div className="space-y-2">
            {/* Google Calendar */}
            <div
              className={`flex items-center gap-3 px-4 py-3 rounded-xl ${
                calendarConnected
                  ? "bg-emerald-900/10 border border-emerald-700/30"
                  : "bg-zinc-900/50 border border-zinc-800"
              } transition`}
            >
              <div className="w-8 h-8 rounded-lg bg-white flex items-center justify-center flex-shrink-0">
                <svg viewBox="0 0 24 24" className="w-5 h-5">
                  <path d="M18.316 5.684H24v12.632h-5.684V5.684z" fill="#1967D2" />
                  <path d="M5.684 18.316V5.684L0 5.684v12.632l5.684 0z" fill="#188038" />
                  <path d="M18.316 24V18.316H5.684V24h12.632z" fill="#1967D2" />
                  <path d="M18.316 5.684V0H5.684v5.684h12.632z" fill="#EA4335" />
                  <path d="M18.316 18.316H5.684V5.684h12.632v12.632z" fill="#fff" />
                  <path d="M9.2 15.7V9.1h1.5v2.4h2.6V9.1h1.5v6.6h-1.5v-2.8h-2.6v2.8H9.2z" fill="#1967D2" />
                </svg>
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-zinc-200">Google Calendar</div>
                <div className={`text-xs mt-0.5 ${calendarConnected ? "text-emerald-400" : "text-zinc-600"}`}>
                  {calendarConnected ? "Connected" : "Not connected"}
                </div>
              </div>
              {calendarConnected ? (
                <div className="w-5 h-5 rounded-full bg-emerald-500/20 flex items-center justify-center flex-shrink-0">
                  <svg className="w-3 h-3 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                </div>
              ) : (
                <button
                  onClick={() => signIn("google", { callbackUrl: "/dashboard/profile" })}
                  className="px-3 py-1.5 text-xs font-medium rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white transition flex-shrink-0"
                >
                  Connect
                </button>
              )}
            </div>

            {/* AI Agent — coming soon */}
            <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-zinc-900/50 border border-zinc-800 opacity-50">
              <div className="w-8 h-8 rounded-lg bg-zinc-700 flex items-center justify-center flex-shrink-0">
                <svg className="w-4 h-4 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0112 15a9.065 9.065 0 00-6.23.693L5 14.5m14.8.8l1.402 1.402c1.232 1.232.65 3.318-1.067 3.611l-.772.13a18.142 18.142 0 01-15.126-3.617" />
                </svg>
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium text-zinc-400">AI Agent</div>
                <div className="text-[10px] text-zinc-600 mt-0.5">Coming soon</div>
              </div>
            </div>
          </div>
        </section>

        {/* Knowledge Base */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-500">
              Knowledge Base
            </h2>
            <div className="flex items-center gap-2">
              {saveMessage && (
                <span className={`text-xs ${saveMessage === "Saved" ? "text-emerald-400" : "text-red-400"}`}>
                  {saveMessage}
                </span>
              )}
              <button
                onClick={handleSaveKnowledge}
                disabled={saving}
                className="px-3 py-1.5 bg-purple-600 hover:bg-purple-700 disabled:opacity-30 text-white text-xs rounded-lg font-medium transition"
              >
                {saving ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
          <div className="space-y-4">
            {/* Persistent Preferences */}
            <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-4">
              <h3 className="text-xs font-semibold text-zinc-400 mb-1">
                Persistent Preferences
              </h3>
              <p className="text-[10px] text-zinc-600 mb-3">
                Who you are, how you work, what matters. Rarely changes. Your agent reads this on every negotiation.
              </p>
              <textarea
                value={persistent}
                onChange={(e) => setPersistent(e.target.value)}
                rows={6}
                placeholder="e.g. I prefer mornings for calls. Budget 30 min travel for in-person meetings. I like to stack calls on MWF."
                className="w-full bg-zinc-800/60 border border-zinc-700/50 rounded-lg px-3 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-purple-500/50 transition resize-y min-h-[100px]"
              />
            </div>

            {/* Situational Context */}
            <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-4">
              <h3 className="text-xs font-semibold text-zinc-400 mb-1">
                Situational Context
              </h3>
              <p className="text-[10px] text-zinc-600 mb-3">
                What&apos;s happening right now — near-term overrides, upcoming events, temporary rules. Update as things change.
              </p>
              <textarea
                value={situational}
                onChange={(e) => setSituational(e.target.value)}
                rows={4}
                placeholder="e.g. In Mexico next week — no morning meetings. Training for a race this month, 7am calls are fine."
                className="w-full bg-zinc-800/60 border border-zinc-700/50 rounded-lg px-3 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-purple-500/50 transition resize-y min-h-[80px]"
              />
            </div>
          </div>
        </section>

        {/* Archived Meetings */}
        <section>
          <Link
            href="/dashboard/archive"
            className="flex items-center justify-between bg-zinc-900/50 border border-zinc-800 rounded-xl px-4 py-3.5 hover:border-zinc-700 transition group"
          >
            <div className="flex items-center gap-2">
              <svg className="w-4 h-4 text-zinc-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5m8.25 3v6.75m0 0l-3-3m3 3l3-3M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z" />
              </svg>
              <span className="text-sm text-zinc-300">Archived meetings</span>
            </div>
            <span className="text-xs text-zinc-600 group-hover:text-zinc-400 transition">
              View &rarr;
            </span>
          </Link>
        </section>
      </div>
    </div>
  );
}
