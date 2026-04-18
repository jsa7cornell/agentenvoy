"use client";

import { useState } from "react";

interface BrokenSession {
  id: string;
  title: string | null;
  guestName: string | null;
  guestEmail: string | null;
  agreedTime: Date | string | null;
  agreedFormat: string | null;
  duration: number | null;
  calendarEventId: string | null;
  meetLink: string | null;
  host: { id: string; name: string | null; email: string | null };
  link: { slug: string; code: string | null; topic: string | null };
}

interface Props {
  initial: BrokenSession[];
}

type RowStatus =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "success"; newEventId: string; htmlLink?: string | null; newMeetLink?: string | null }
  | { kind: "error"; message: string };

export function DryrunRepairClient({ initial }: Props) {
  const [sessions, setSessions] = useState<BrokenSession[]>(initial);
  const [statusById, setStatusById] = useState<Record<string, RowStatus>>({});
  const [sendUpdates, setSendUpdates] = useState<"none" | "all">("none");

  const setStatus = (id: string, s: RowStatus) =>
    setStatusById((prev) => ({ ...prev, [id]: s }));

  const repair = async (sessionId: string) => {
    setStatus(sessionId, { kind: "pending" });
    try {
      const res = await fetch("/api/admin/repair/dryrun-eventid", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, sendUpdates }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setStatus(sessionId, {
          kind: "error",
          message: data.error || `HTTP ${res.status}`,
        });
        return;
      }
      setStatus(sessionId, {
        kind: "success",
        newEventId: data.newEventId,
        htmlLink: data.htmlLink,
        newMeetLink: data.newMeetLink,
      });
      // Drop the row from the list after a short delay so it's clear what changed.
      setTimeout(() => {
        setSessions((prev) => prev.filter((s) => s.id !== sessionId));
      }, 1500);
    } catch (e) {
      setStatus(sessionId, {
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  };

  if (sessions.length === 0) {
    return (
      <div className="rounded-lg border border-emerald-700/40 bg-emerald-900/10 p-4 text-sm text-emerald-200">
        ✓ No sessions currently have a <code>dryrun-*</code> calendarEventId. Nothing to repair.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between rounded-lg border border-DEFAULT bg-surface-secondary px-3 py-2">
        <div className="text-xs text-muted">
          {sessions.length} session{sessions.length === 1 ? "" : "s"} to repair
        </div>
        <label className="flex items-center gap-2 text-xs text-secondary">
          <span>Notify attendees:</span>
          <select
            value={sendUpdates}
            onChange={(e) => setSendUpdates(e.target.value as "none" | "all")}
            className="bg-surface border border-DEFAULT rounded px-2 py-0.5 text-xs"
          >
            <option value="none">Quiet (no email)</option>
            <option value="all">Send new invite</option>
          </select>
        </label>
      </div>

      {sessions.map((s) => {
        const status = statusById[s.id] || { kind: "idle" };
        const when = s.agreedTime
          ? new Date(s.agreedTime).toLocaleString("en-US", {
              dateStyle: "medium",
              timeStyle: "short",
            })
          : "—";
        return (
          <div
            key={s.id}
            className="rounded-lg border border-DEFAULT bg-surface-secondary p-3 flex items-start gap-3"
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-sm font-semibold">
                  {s.title || s.link.topic || "Meeting"}
                </span>
                <span className="text-[10px] uppercase tracking-wider text-muted">
                  {s.agreedFormat || "meeting"} · {s.duration || 30}m
                </span>
              </div>
              <div className="text-xs text-secondary">
                <span className="text-muted">when:</span> {when}
              </div>
              <div className="text-xs text-secondary">
                <span className="text-muted">host:</span>{" "}
                {s.host.name || s.host.email || s.host.id}
                <span className="text-muted"> · guest:</span>{" "}
                {s.guestName || s.guestEmail || "(unknown)"}
              </div>
              <div className="text-[10px] font-mono text-muted mt-1">
                {s.id} · old eventId: {s.calendarEventId}
              </div>
              {status.kind === "error" && (
                <div className="mt-2 text-xs text-red-300">Error: {status.message}</div>
              )}
              {status.kind === "success" && (
                <div className="mt-2 text-xs text-emerald-300">
                  ✓ Repaired · new eventId: <code>{status.newEventId}</code>
                  {status.htmlLink && (
                    <>
                      {" · "}
                      <a
                        href={status.htmlLink}
                        target="_blank"
                        rel="noreferrer"
                        className="underline hover:text-emerald-200"
                      >
                        open in GCal
                      </a>
                    </>
                  )}
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={() => repair(s.id)}
              disabled={status.kind === "pending" || status.kind === "success"}
              className="px-3 py-1.5 rounded-md text-xs font-semibold bg-blue-500/90 hover:bg-blue-500 text-white transition disabled:opacity-50 disabled:cursor-not-allowed flex-shrink-0"
            >
              {status.kind === "pending"
                ? "Repairing…"
                : status.kind === "success"
                  ? "Done"
                  : "Repair"}
            </button>
          </div>
        );
      })}
    </div>
  );
}
