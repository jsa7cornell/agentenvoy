"use client";

/**
 * "Send feedback" quick-action + single-field modal with Haiku prefill.
 *
 * The italic disclosure line is the consent moment. The checkbox preserves
 * F3's per-incident consent commitment with less UI. See the decided
 * proposal: 2026-04-21_deal-room-send-feedback-symmetry.
 *
 * Three mount modes:
 *   - "host"              : NextAuth host, uses /api/feedback/submit.
 *                           F3 bundle (channel + sessions + errors + cal).
 *   - "host-deal-room"    : NextAuth host viewing own deal room. Same
 *                           endpoint/bundle as "host" — only disclosure
 *                           copy and subtitle change.
 *   - "guest-deal-room"   : linkCode auth, uses /api/feedback/submit-as-guest.
 *                           Narrower bundle (channel messages only).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { captureClientState } from "@/lib/feedback/capture-client-state";
import { FEEDBACK_AREAS, type FeedbackArea } from "@/lib/feedback/schema";

type Mode = "host" | "host-deal-room" | "guest-deal-room";

const AREA_LABELS: Record<FeedbackArea, string> = {
  dashboard_chat: "Dashboard chat",
  deal_room_chat: "Deal room chat",
  link_creation: "Link creation",
  meeting_editing: "Meeting editing",
  calendar_sync: "Calendar sync",
  confirmation_flow: "Confirmation flow",
  other: "Something else",
};

interface SendFeedbackLinkProps {
  className?: string;
  mode?: Mode;
  /** Required when mode === "guest-deal-room". */
  linkCode?: string;
  /** NegotiationSession.id in the current deal room (if known). */
  sessionId?: string | null;
}

export function SendFeedbackLink({
  className,
  mode = "host",
  linkCode,
  sessionId,
}: SendFeedbackLinkProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`text-xs text-muted hover:text-primary underline decoration-dotted underline-offset-4 ${className ?? ""}`}
      >
        Send feedback
      </button>
      {open ? (
        <SendFeedbackModal
          mode={mode}
          linkCode={linkCode}
          sessionId={sessionId ?? null}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

interface ModalProps {
  mode: Mode;
  linkCode?: string;
  sessionId: string | null;
  onClose: () => void;
}

function contextSubtitle(mode: Mode): string {
  if (mode === "guest-deal-room") {
    return "Attaches the last 30 messages in this thread and your session state. No calendar data, no other conversations.";
  }
  return "Attaches your recent messages, sessions, and any route errors in the last 24h. Calendar data is title+time only.";
}

function SendFeedbackModal({ mode, linkCode, sessionId, onClose }: ModalProps) {
  const [userText, setUserText] = useState("");
  const [userTyped, setUserTyped] = useState(false);
  const [prefillLoading, setPrefillLoading] = useState(true);
  const [prefillDraft, setPrefillDraft] = useState<string | null>(null);
  const [includeContext, setIncludeContext] = useState(true);
  const [area, setArea] = useState<FeedbackArea | "">("");
  const [submitting, setSubmitting] = useState(false);
  const [submittedId, setSubmittedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const prefillController = useRef<AbortController | null>(null);

  // Prefill on mount. Race guard per N2 of the proposal: if the response
  // arrives after the user has typed, DROP it — never overwrite typed
  // content. abort() is best-effort; userTyped is the authoritative gate.
  useEffect(() => {
    const controller = new AbortController();
    prefillController.current = controller;
    let cancelled = false;

    const run = async () => {
      try {
        const res = await fetch("/api/feedback/prefill", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            linkCode: mode === "guest-deal-room" ? linkCode : undefined,
            sessionId: sessionId ?? undefined,
            url: typeof window !== "undefined" ? window.location.href : undefined,
          }),
        });
        if (cancelled) return;
        const json = (await res.json()) as { ok: boolean; draft?: string };
        if (cancelled) return;
        const draft = json.ok ? (json.draft ?? "").trim() : "";
        // Race guard: if user has already typed, drop the response entirely.
        setUserTyped((typedNow) => {
          if (!typedNow && draft) {
            setPrefillDraft(draft);
            setUserText(draft);
          }
          return typedNow;
        });
      } catch {
        // Aborted or network error — leave textarea empty.
      } finally {
        if (!cancelled) setPrefillLoading(false);
      }
    };

    run();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [mode, linkCode, sessionId]);

  const onTextChange = useCallback((value: string) => {
    setUserText(value);
    setUserTyped(true);
    // Invalidate the prefill draft once the user types — future submit
    // treats the text as user-authored, not prefilled.
    setPrefillDraft(null);
    prefillController.current?.abort();
  }, []);

  const submit = useCallback(async () => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const url = typeof window !== "undefined" ? window.location.href : undefined;
      const userAgent = typeof navigator !== "undefined" ? navigator.userAgent : undefined;
      // If the user never typed, the gray prefill draft submits verbatim.
      const textToSend = (userText.trim() || prefillDraft || "").trim();
      const clientState = captureClientState();
      const areaField = area || undefined;

      let res: Response;
      if (mode === "guest-deal-room") {
        if (!linkCode) throw new Error("Missing linkCode");
        res = await fetch("/api/feedback/submit-as-guest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            linkCode,
            userText: textToSend || undefined,
            area: areaField,
            includeContext,
            sessionId: sessionId ?? undefined,
            url,
            userAgent,
            clientState,
          }),
        });
      } else {
        const checklist = {
          messages: includeContext,
          sessions: includeContext,
          calendar: false,
          errors: includeContext,
          console: false,
        };
        res = await fetch("/api/feedback/submit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userText: textToSend || undefined,
            area: areaField,
            checklistState: checklist,
            sessionId: sessionId ?? undefined,
            url,
            userAgent,
            clientState,
          }),
        });
      }
      const json = (await res.json()) as { ok: boolean; reportId?: string; error?: string };
      if (!res.ok || !json.ok) {
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }
      setSubmittedId(json.reportId ?? "");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send feedback");
    } finally {
      setSubmitting(false);
    }
  }, [mode, linkCode, sessionId, userText, prefillDraft, includeContext, area, submitting]);

  const placeholder = prefillLoading
    ? "Reading recent activity…"
    : "What did you click? What did you expect to happen?";

  // Styling: when the textarea shows a prefill draft the user hasn't
  // touched, render it gray so the user feels free to type over it.
  const textareaClass =
    !userTyped && prefillDraft && userText === prefillDraft
      ? "mt-1 w-full resize-none rounded-lg border border-white/10 bg-zinc-900 px-3 py-2 text-sm text-zinc-500 italic focus:border-purple-500/60 focus:text-zinc-100 focus:not-italic focus:outline-none"
      : "mt-1 w-full resize-none rounded-lg border border-white/10 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 focus:border-purple-500/60 focus:outline-none";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-xl rounded-2xl border border-white/10 bg-zinc-950 p-6 text-sm text-zinc-100 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {submittedId !== null ? (
          <div className="space-y-3">
            <h2 className="text-lg font-semibold">Thank you 🙏</h2>
            {mode === "guest-deal-room" ? (
              <p className="text-sm text-zinc-300">
                Thanks — email{" "}
                <a
                  href="mailto:support@agentenvoy.com"
                  className="underline decoration-dotted underline-offset-4 hover:text-zinc-100"
                >
                  support@agentenvoy.com
                </a>{" "}
                if you want to follow up.
              </p>
            ) : (
              <p className="text-sm text-zinc-300">
                Every report makes AgentEnvoy better, and we&rsquo;re grateful you took the
                time to send this one. 💜
              </p>
            )}
            <div className="flex justify-end pt-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg bg-purple-600 px-4 py-2 text-white hover:bg-purple-500"
              >
                Close
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="mb-4 flex items-start justify-between">
              <h2 className="text-lg font-semibold">Send feedback</h2>
              <button
                type="button"
                onClick={onClose}
                className="text-xl leading-none text-zinc-500 hover:text-zinc-200"
                aria-label="Close"
              >
                ×
              </button>
            </div>

            <div className="space-y-3">
              <label className="block">
                <span className="text-xs uppercase tracking-wide text-zinc-400">
                  Area (optional)
                </span>
                <select
                  value={area}
                  onChange={(e) => setArea(e.target.value as FeedbackArea | "")}
                  className="mt-1 w-full rounded-lg border border-white/10 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 focus:border-purple-500/60 focus:outline-none"
                >
                  <option value="">— pick an area —</option>
                  {FEEDBACK_AREAS.map((a) => (
                    <option key={a} value={a}>
                      {AREA_LABELS[a]}
                    </option>
                  ))}
                </select>
              </label>

              <label className="block">
                <span className="text-xs uppercase tracking-wide text-zinc-400">
                  What happened? (optional)
                </span>
                <textarea
                  value={userText}
                  onChange={(e) => onTextChange(e.target.value)}
                  rows={4}
                  placeholder={placeholder}
                  className={textareaClass}
                />
              </label>

              <label className="flex items-start gap-2 rounded-lg border border-white/10 bg-zinc-900/60 p-3">
                <input
                  type="checkbox"
                  id="fb-include-context"
                  checked={includeContext}
                  onChange={() => setIncludeContext((v) => !v)}
                  className="mt-0.5 h-4 w-4 accent-purple-500"
                />
                <span className="flex-1">
                  <span className="block text-sm text-zinc-200">
                    Include recent activity
                  </span>
                  <span className="block text-[11px] text-zinc-500 mt-0.5">
                    {contextSubtitle(mode)}
                  </span>
                </span>
              </label>

              <p className="text-xs text-zinc-400">
                Feedback is a gift — thank you for taking the time. 💜
              </p>

              {error ? <p className="text-xs text-red-400">{error}</p> : null}

              <div className="flex items-center justify-end gap-2 pt-2">
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
                  className="rounded-lg bg-purple-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-purple-500 disabled:opacity-40"
                >
                  {submitting ? "Sending…" : "Send feedback"}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
