"use client";

import { useState } from "react";

export interface GcalUpdateProposal {
  sessionId: string;
  eventId: string;
  proposed: {
    location?: string;
    format?: "phone" | "video" | "in-person";
    startTime?: string;
    endTime?: string;
    duration?: number;
  };
}

interface GcalUpdateCardProps {
  proposal: GcalUpdateProposal;
  onConfirmed?: () => void;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function GcalUpdateCard({ proposal, onConfirmed }: GcalUpdateCardProps) {
  const [notifyAttendees, setNotifyAttendees] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const { proposed } = proposal;
  const changes: [string, string][] = [
    ...(proposed.location !== undefined ? [["Location", proposed.location] as [string, string]] : []),
    ...(proposed.format !== undefined ? [["Format", proposed.format] as [string, string]] : []),
    ...(proposed.startTime !== undefined ? [["Time", formatTime(proposed.startTime)] as [string, string]] : []),
  ];

  async function handleConfirm() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/negotiate/update-gcal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: proposal.sessionId,
          proposed: proposal.proposed,
          notifyAttendees,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error || `Request failed (${res.status})`);
      }
      setDone(true);
      onConfirmed?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  if (done) {
    return (
      <div className="rounded-lg border border-green-700/40 bg-green-950/30 px-3 py-2 text-sm text-green-300">
        Calendar updated.
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-amber-700/40 bg-amber-950/20 p-3 space-y-3 text-sm">
      <p className="font-medium text-amber-200 text-xs uppercase tracking-wide">
        Envoy is proposing an update to the confirmed meeting
      </p>

      {changes.length > 0 && (
        <ul className="space-y-1">
          {changes.map(([label, value]) => (
            <li key={label} className="flex gap-2 text-xs">
              <span className="w-16 font-medium text-foreground/70 shrink-0">{label}</span>
              <span className="text-foreground/90">{value}</span>
            </li>
          ))}
        </ul>
      )}

      <label className="flex items-center gap-2 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={notifyAttendees}
          onChange={(e) => setNotifyAttendees(e.target.checked)}
          className="rounded"
        />
        <span className="text-xs text-muted-foreground">Notify attendees</span>
      </label>

      {error && (
        <p className="text-xs text-red-400">{error}</p>
      )}

      <div className="flex gap-2 pt-1">
        <button
          onClick={handleConfirm}
          disabled={loading}
          className="flex-1 rounded-md bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white text-xs font-medium px-3 py-1.5 transition-colors"
        >
          {loading ? "Updating…" : "Confirm update"}
        </button>
        <button
          onClick={() => setDone(true)}
          disabled={loading}
          className="rounded-md border border-white/10 hover:bg-white/5 text-xs text-muted-foreground px-3 py-1.5 transition-colors"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
