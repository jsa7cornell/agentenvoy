"use client";

/**
 * ThumbsDownFeedback — inline 👎 on Envoy messages (admin/host only).
 *
 * Submits to /api/feedback/submit with area="composer_thumbs_down".
 * The admin note lands in userText; the flagged message content lands in
 * triedToDoText so the agent reading the report has the exact turn.
 * Review queue: /admin/feedback?area=composer_thumbs_down
 */

import { useCallback, useState } from "react";

interface Props {
  /** NegotiationSession.id — scopes the bundle the server builds. */
  sessionId: string | null;
  /** The full text of the Envoy message being flagged. */
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
        className="opacity-0 group-hover:opacity-60 hover:!opacity-100 transition-opacity text-zinc-400 hover:text-red-400 text-[13px] ml-1.5 leading-none"
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
  const [done, setDone] = useState(false);
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
      const json = (await res.json()) as { ok: boolean; error?: string };
      if (!res.ok || !json.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setDone(true);
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
        {done ? (
          <div className="space-y-3">
            <p className="font-semibold">Logged 👎</p>
            <p className="text-xs text-zinc-400">
              Added to composer feedback queue.
            </p>
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
