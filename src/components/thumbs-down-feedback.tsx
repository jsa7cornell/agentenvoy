"use client";

/**
 * ThumbsDownFeedback — inline 👎 on Envoy messages (host-only).
 *
 * Submits to /api/feedback/submit with area="composer_thumbs_down".
 * userText = admin note; triedToDoText = flagged message; full conversation
 * bundle built server-side. Review: /admin/feedback?area=composer_thumbs_down
 * Full doc: agentenvoy/COMPOSERREPORTS.md
 */

import { useCallback, useState } from "react";

interface Props {
  sessionId: string | null;
  messageContent: string;
}

export function ThumbsDownFeedback({ sessionId, messageContent }: Props) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Flag this response"
        className="opacity-30 hover:opacity-100 active:opacity-100 transition-opacity text-zinc-400 hover:text-red-400 text-[13px] ml-1.5 leading-none"
      >
        👎
      </button>
      {open && (
        <ThumbsDownModal
          sessionId={sessionId}
          messageContent={messageContent}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function ThumbsDownModal({
  sessionId,
  messageContent,
  onClose,
}: {
  sessionId: string | null;
  messageContent: string;
  onClose: () => void;
}) {
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [reportId, setReportId] = useState<string | null>(null);
  const [agentPrompt, setAgentPrompt] = useState<string | null>(null);
  const [promptCopied, setPromptCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/feedback/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          area: "composer_thumbs_down",
          userText: note.trim() || undefined,
          triedToDoText: messageContent,
          sessionId: sessionId ?? undefined,
          checklistState: {
            messages: true,
            sessions: false,
            calendar: false,
            errors: false,
            console: false,
          },
          url: typeof window !== "undefined" ? window.location.href : undefined,
        }),
      });
      const json = (await res.json()) as {
        ok: boolean;
        reportId?: string;
        agentPrompt?: string;
        error?: string;
      };
      if (!res.ok || !json.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setReportId(json.reportId ?? null);
      setAgentPrompt(json.agentPrompt ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send");
    } finally {
      setSubmitting(false);
    }
  }, [note, sessionId, messageContent]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-2xl border border-white/10 bg-zinc-950 p-5 text-sm text-zinc-100 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {reportId !== null ? (
          <div className="space-y-3">
            <p className="font-semibold">Logged 👎</p>
            <div className="rounded-md border border-white/10 bg-zinc-900 px-3 py-2 space-y-1 text-[11px]">
              <div className="flex justify-between text-zinc-400">
                <span>Report</span>
                <a
                  href={`/admin/feedback/${reportId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-mono text-sky-400 hover:text-sky-300"
                >
                  {reportId}
                </a>
              </div>
              {sessionId && (
                <div className="flex justify-between text-zinc-400">
                  <span>Session</span>
                  <span className="font-mono text-zinc-300">{sessionId}</span>
                </div>
              )}
            </div>
            {agentPrompt && (
              <button
                type="button"
                onClick={async () => {
                  await navigator.clipboard.writeText(agentPrompt);
                  setPromptCopied(true);
                  setTimeout(() => setPromptCopied(false), 2000);
                }}
                className="w-full rounded-md border border-sky-500/30 bg-sky-500/5 px-3 py-1.5 text-[11px] text-sky-300 hover:bg-sky-500/10 text-left"
              >
                {promptCopied ? "Copied ✓" : "Copy debug curl (15 min token)"}
              </button>
            )}
            <div className="flex justify-end pt-1">
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg bg-zinc-800 px-4 py-1.5 text-xs text-zinc-200 hover:bg-zinc-700"
              >
                Close
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <p className="font-semibold">Flag this response</p>
              <button
                type="button"
                onClick={onClose}
                className="text-xl leading-none text-zinc-500 hover:text-zinc-200"
              >
                ×
              </button>
            </div>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="What was wrong? (optional)"
              rows={3}
              autoFocus
              className="w-full resize-none rounded-lg border border-white/10 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-purple-500/60 focus:outline-none"
            />
            {error && <p className="text-xs text-red-400">{error}</p>}
            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-zinc-300 hover:bg-white/5"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={submitting}
                className="rounded-lg bg-red-700 px-4 py-1.5 text-xs font-medium text-white hover:bg-red-600 disabled:opacity-40"
              >
                {submitting ? "Flagging…" : "Flag it"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
