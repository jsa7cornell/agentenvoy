"use client";

/**
 * "Send feedback" quick-action + transparent include-list modal (F3).
 *
 * The checkboxes ARE the consent moment — every row plainly states what
 * will be attached. Calendar events in the bundle go through the
 * server-side redactor (src/lib/feedback/redact-calendar.ts) — this
 * component renders the UX; the server enforces the payload shape.
 */

import { useCallback, useMemo, useState } from "react";

type CheckboxKey = "messages" | "sessions" | "calendar" | "errors" | "console";

interface ChecklistItem {
  key: CheckboxKey;
  label: string;
  description: string;
  defaultChecked: boolean;
}

const CHECKLIST: ChecklistItem[] = [
  {
    key: "messages",
    label: "Last 30 messages with Envoy",
    description: "Your recent conversation with the assistant.",
    defaultChecked: true,
  },
  {
    key: "sessions",
    label: "Your active sessions (titles + status only)",
    description: "Session titles, statuses, and agreed times — no message content.",
    defaultChecked: true,
  },
  {
    key: "calendar",
    label: "Calendar events from the last 7 days (titles + times only)",
    description:
      "Only titles and times. Descriptions, attachments, and non-participant attendee emails are stripped automatically; attendee count is preserved for debugging.",
    defaultChecked: false,
  },
  {
    key: "errors",
    label: "Route errors in the last 24h",
    description: "Server errors tied to your account. No user content.",
    defaultChecked: true,
  },
  {
    key: "console",
    label: "Browser console logs (last 50 entries)",
    description:
      "Captured from this tab. May contain component state — review before submitting. Off by default.",
    defaultChecked: false,
  },
];

type ChecklistState = Record<CheckboxKey, boolean>;

function initialChecklist(): ChecklistState {
  return CHECKLIST.reduce<ChecklistState>(
    (acc, item) => ({ ...acc, [item.key]: item.defaultChecked }),
    {} as ChecklistState,
  );
}

export function SendFeedbackLink({ className }: { className?: string }) {
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
      {open ? <SendFeedbackModal onClose={() => setOpen(false)} /> : null}
    </>
  );
}

interface ModalProps {
  onClose: () => void;
}

function captureConsoleLines(): string[] {
  // We don't patch console globally; instead we rely on whatever the
  // user had open. This is a best-effort read of any error/warn we can
  // see in performance entries as a fallback. In v1 this is empty and
  // the checkbox is off by default — the UI plumbing exists for a v2
  // where we wrap console. Leaving the shape stable keeps the server
  // schema honest either way.
  return [];
}

function SendFeedbackModal({ onClose }: ModalProps) {
  const [userText, setUserText] = useState("");
  const [triedToDo, setTriedToDo] = useState("");
  const [checklist, setChecklist] = useState<ChecklistState>(initialChecklist);
  const [showPreview, setShowPreview] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submittedId, setSubmittedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const toggle = useCallback((key: CheckboxKey) => {
    setChecklist((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const previewSummary = useMemo(() => {
    const parts: string[] = [];
    if (checklist.messages) parts.push("up to 30 recent messages");
    if (checklist.sessions) parts.push("up to 10 recent sessions (titles + status only)");
    if (checklist.calendar) parts.push("calendar events in the last 7 days (titles + times only)");
    if (checklist.errors) parts.push("route errors in the last 24h");
    if (checklist.console) parts.push("console lines (empty in v1)");
    if (parts.length === 0) return "No context attached — just your message.";
    return parts.join(" · ");
  }, [checklist]);

  const submit = useCallback(async () => {
    if (!userText.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/feedback/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userText: userText.trim(),
          triedToDoText: triedToDo.trim() || undefined,
          checklistState: checklist,
          consoleLines: checklist.console ? captureConsoleLines() : undefined,
          url: typeof window !== "undefined" ? window.location.href : undefined,
          userAgent: typeof navigator !== "undefined" ? navigator.userAgent : undefined,
        }),
      });
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
  }, [userText, triedToDo, checklist, submitting]);

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
            <h2 className="text-lg font-semibold">Thanks — we got it.</h2>
            <p className="text-sm text-zinc-400">
              Report ID <code className="text-zinc-300">{submittedId}</code>. Our team will take a look.
            </p>
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
                  What happened?
                </span>
                <textarea
                  value={userText}
                  onChange={(e) => setUserText(e.target.value)}
                  rows={3}
                  placeholder="Describe what you saw…"
                  className="mt-1 w-full resize-none rounded-lg border border-white/10 bg-zinc-900 px-3 py-2 text-sm focus:border-purple-500/60 focus:outline-none"
                />
              </label>

              <label className="block">
                <span className="text-xs uppercase tracking-wide text-zinc-400">
                  What were you trying to do? (optional)
                </span>
                <textarea
                  value={triedToDo}
                  onChange={(e) => setTriedToDo(e.target.value)}
                  rows={2}
                  placeholder="e.g. confirm a meeting on Friday at 2pm…"
                  className="mt-1 w-full resize-none rounded-lg border border-white/10 bg-zinc-900 px-3 py-2 text-sm focus:border-purple-500/60 focus:outline-none"
                />
              </label>

              <div className="rounded-lg border border-white/10 bg-zinc-900/60 p-3">
                <p className="text-xs uppercase tracking-wide text-zinc-400">
                  Context to attach
                </p>
                <p className="mt-1 text-[11px] text-zinc-500">
                  Every item below is off by default unless listed as on. You can toggle any of them — we only send what you check.
                </p>
                <ul className="mt-3 space-y-2">
                  {CHECKLIST.map((item) => (
                    <li key={item.key} className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        id={`fb-${item.key}`}
                        checked={checklist[item.key]}
                        onChange={() => toggle(item.key)}
                        className="mt-0.5 h-4 w-4 accent-purple-500"
                      />
                      <label htmlFor={`fb-${item.key}`} className="flex-1">
                        <div className="text-sm text-zinc-200">{item.label}</div>
                        <div className="text-[11px] text-zinc-500">{item.description}</div>
                      </label>
                    </li>
                  ))}
                </ul>

                <button
                  type="button"
                  onClick={() => setShowPreview((s) => !s)}
                  className="mt-3 text-xs text-sky-400 hover:text-sky-300"
                >
                  {showPreview ? "Hide" : "Preview"} what will be sent
                </button>
                {showPreview ? (
                  <pre className="mt-2 whitespace-pre-wrap rounded bg-black/40 p-2 text-[11px] leading-relaxed text-zinc-300">
                    URL: {typeof window !== "undefined" ? window.location.href : "(server)"}
                    {"\n"}User-Agent: {typeof navigator !== "undefined" ? navigator.userAgent : "(server)"}
                    {"\n"}Captured at: (server time on submit)
                    {"\n"}
                    {"\n"}Context: {previewSummary}
                  </pre>
                ) : null}
              </div>

              {error ? (
                <p className="text-xs text-red-400">{error}</p>
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
                  disabled={submitting || !userText.trim()}
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
