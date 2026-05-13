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
import { installConsoleRing, getConsoleRing } from "@/lib/feedback/console-ring";
// Area picker hidden for now; keeping imports so re-enabling is a one-line flip.
// import { FEEDBACK_AREAS, type FeedbackArea } from "@/lib/feedback/schema";
import type { FeedbackArea } from "@/lib/feedback/schema";

type Mode = "host" | "host-deal-room" | "guest-deal-room";

// Area labels — kept (not currently rendered) so re-enabling the picker is
// trivial. eslint-disable-next-line is cheaper than code deletion + restore.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const AREA_LABELS: Record<FeedbackArea, string> = {
  dashboard_chat: "Dashboard chat",
  deal_room_chat: "Deal room chat",
  link_creation: "Link creation",
  meeting_editing: "Meeting editing",
  calendar_sync: "Calendar sync",
  confirmation_flow: "Confirmation flow",
  other: "Something else",
  composer_thumbs_down: "Composer feedback",
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
  // Install the console ring as soon as the feedback entrypoint mounts so
  // the ring has lines to capture by the time the user opens the modal.
  useEffect(() => { installConsoleRing(); }, []);
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

function defaultAreaForMode(mode: Mode): FeedbackArea | "" {
  if (mode === "guest-deal-room" || mode === "host-deal-room") return "deal_room_chat";
  if (mode === "host") return "dashboard_chat";
  return "";
}

function SendFeedbackModal({ mode, linkCode, sessionId, onClose }: ModalProps) {
  const inferredArea = defaultAreaForMode(mode);
  const [userText, setUserText] = useState("");
  const [userTyped, setUserTyped] = useState(false);
  const [prefillLoading, setPrefillLoading] = useState(true);
  const [prefillDraft, setPrefillDraft] = useState<string | null>(null);
  const [includeContext, setIncludeContext] = useState(true);
  const [area] = useState<FeedbackArea | "">(inferredArea);
  const [submitting, setSubmitting] = useState(false);
  const [submittedId, setSubmittedId] = useState<string | null>(null);
  const [submittedIsAdmin, setSubmittedIsAdmin] = useState(false);
  const [submittedPrompt, setSubmittedPrompt] = useState<string | null>(null);
  const [promptCopied, setPromptCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorRef, setErrorRef] = useState<string | null>(null);
  const prefillController = useRef<AbortController | null>(null);

  // Draggable on desktop (pointer events fall back gracefully on touch).
  // Drag is initiated only from the title bar — close button and form fields
  // carry data-no-drag so they stay interactive.
  const [drag, setDrag] = useState({ x: 0, y: 0 });
  const dragStart = useRef<{
    px: number;
    py: number;
    ox: number;
    oy: number;
  } | null>(null);
  const onDragPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if ((e.target as HTMLElement).closest("[data-no-drag]")) return;
      dragStart.current = { px: e.clientX, py: e.clientY, ox: drag.x, oy: drag.y };
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    },
    [drag.x, drag.y],
  );
  const onDragPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragStart.current) return;
      setDrag({
        x: dragStart.current.ox + (e.clientX - dragStart.current.px),
        y: dragStart.current.oy + (e.clientY - dragStart.current.py),
      });
    },
    [],
  );
  const onDragPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      dragStart.current = null;
      try {
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    },
    [],
  );
  const dragHandleProps = {
    onPointerDown: onDragPointerDown,
    onPointerMove: onDragPointerMove,
    onPointerUp: onDragPointerUp,
    onPointerCancel: onDragPointerUp,
  };

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
    setErrorRef(null);
    try {
      const url = typeof window !== "undefined" ? window.location.href : undefined;
      const userAgent = typeof navigator !== "undefined" ? navigator.userAgent : undefined;
      // If the user never typed, the gray prefill draft submits verbatim.
      const textToSend = (userText.trim() || prefillDraft || "").trim();
      const clientState = captureClientState();
      const areaField = area || undefined;
      const consoleLines = getConsoleRing();

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
            consoleLines,
          }),
        });
      } else {
        const checklist = {
          messages: includeContext,
          sessions: includeContext,
          calendar: false,
          errors: includeContext,
          console: true,
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
            consoleLines,
          }),
        });
      }
      const json = (await res.json()) as {
        ok: boolean;
        reportId?: string;
        isAdmin?: boolean;
        agentPrompt?: string;
        error?: string;
        errorRef?: string;
        issues?: {
          fieldErrors?: Record<string, string[]>;
          formErrors?: string[];
        };
      };
      if (!res.ok || !json.ok) {
        if (json.errorRef) setErrorRef(json.errorRef);
        // Surface Zod field-level rejections so "Invalid submission" stops
        // being a dead-end. Names the first failing field (e.g. consoleLines,
        // userText, url) so the user can see WHAT failed, not just THAT it did.
        // 2026-05-13: paired with the console-ring off-by-one fix; if a future
        // schema drift causes Invalid submission, the field name surfaces here.
        const fieldErrors = json.issues?.fieldErrors;
        if (fieldErrors && Object.keys(fieldErrors).length > 0) {
          const firstField = Object.keys(fieldErrors)[0];
          const firstMsg = fieldErrors[firstField]?.[0];
          throw new Error(
            `${json.error ?? "Validation failed"} — field "${firstField}"${firstMsg ? ` (${firstMsg})` : ""}`,
          );
        }
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }
      setSubmittedId(json.reportId ?? "");
      setSubmittedIsAdmin(Boolean(json.isAdmin));
      setSubmittedPrompt(json.agentPrompt ?? null);
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
      ? "mt-1 w-full min-h-[96px] resize-y rounded-lg border border-white/10 bg-zinc-900 px-3 py-2 text-sm text-zinc-500 italic focus:border-purple-500/60 focus:text-zinc-100 focus:not-italic focus:outline-none"
      : "mt-1 w-full min-h-[96px] resize-y rounded-lg border border-white/10 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 focus:border-purple-500/60 focus:outline-none";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-xl rounded-2xl border border-white/10 bg-zinc-950 p-6 text-sm text-zinc-100 shadow-xl"
        onClick={(e) => e.stopPropagation()}
        style={{ transform: `translate(${drag.x}px, ${drag.y}px)` }}
      >
        {submittedId !== null ? (
          <div className="space-y-3">
            <h2
              className="cursor-move select-none text-lg font-semibold"
              {...dragHandleProps}
            >
              Thank you 🙏
            </h2>
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
            {submittedId ? (
              <p className="pt-1 text-[11px] text-zinc-500">
                Report ID:{" "}
                <code className="font-mono text-zinc-400 select-all">{submittedId}</code>
              </p>
            ) : null}
            {submittedId && submittedPrompt ? (
              // Auto-mint agent prompt for ALL authenticated submitters
              // (2026-05-01) — previously admin-only. Token in the curl is
              // short-lived (15 min) and only useful for THIS report, so
              // showing it broadly carries no privilege escalation. Admin
              // viewers also get the "Open report →" link in the same row.
              // Treatment is intentionally discreet: small, monospace,
              // selectable — suits John's "test from non-admin accounts"
              // workflow without dominating the Thank-you copy.
              <div className="mt-2 flex flex-col gap-1.5 rounded-md border border-sky-500/30 bg-sky-500/5 px-3 py-2 text-[11px]">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sky-200">Debug:</span>
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(submittedPrompt);
                        setPromptCopied(true);
                        setTimeout(() => setPromptCopied(false), 2000);
                      } catch {
                        /* ignore */
                      }
                    }}
                    className="rounded border border-sky-500/40 bg-sky-500/10 px-2 py-0.5 font-medium text-sky-100 hover:bg-sky-500/20"
                  >
                    {promptCopied ? "Copied ✓" : "Copy agent prompt (15 min)"}
                  </button>
                  {submittedIsAdmin ? (
                    <a
                      href={`/admin/feedback/${submittedId}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="rounded border border-sky-500/40 bg-sky-500/10 px-2 py-0.5 font-medium text-sky-100 hover:bg-sky-500/20"
                    >
                      Open report →
                    </a>
                  ) : null}
                </div>
                {/* Show the curl line itself, monospace + selectable, so the
                    user can copy by selection too (some test flows prefer
                    that to clipboard API). Truncated visually but full text
                    is selectable. */}
                <code className="block max-w-full overflow-x-auto whitespace-nowrap font-mono text-[10px] text-zinc-300/80 select-all">
                  {submittedPrompt.split("\n")[0]}
                </code>
              </div>
            ) : null}
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
            <div
              className="mb-4 flex cursor-move select-none items-start justify-between"
              {...dragHandleProps}
            >
              <h2 className="text-lg font-semibold">❤️ Feedback as a Gift</h2>
              <button
                type="button"
                onClick={onClose}
                data-no-drag
                className="text-xl leading-none text-zinc-500 hover:text-zinc-200"
                aria-label="Close"
              >
                ×
              </button>
            </div>

            <div className="space-y-3" data-no-drag>
              {/* Area picker intentionally hidden for now — inferredArea is
                  still submitted with every report, so admin filtering still
                  works. Flip this block back on if we want user override. */}

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

              {error ? (
                <p className="text-xs text-red-400">
                  {error}
                  {errorRef ? (
                    <span className="ml-1 font-mono text-[10px] text-red-300/80">
                      (ref {errorRef})
                    </span>
                  ) : null}
                </p>
              ) : null}

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
