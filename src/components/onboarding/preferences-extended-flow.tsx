"use client";

/**
 * Renderer for the preferences-extended ("Fine-tune your availability +
 * theme") continuation flow. Same shape as PrimaryLinkFlow per SPEC §6.6:
 * each pick POSTs to `/api/onboarding/preferences-extended`, which
 * persists user + envoy turns as `ChannelMessage`s tagged
 * `metadata: { kind: "onboarding", subkind: "preferences-extended", step }`.
 * Resume comes from the latest tuning message's metadata.
 */

import { useEffect, useRef, useState } from "react";
import { QuickReplies } from "./quick-replies";
import {
  BUFFER_OPTIONS,
  CUSTOM_RULES_OPTIONS,
  EVENINGS_OPTIONS,
  THEME_OPTIONS,
  type ExtendedStep,
} from "@/app/api/onboarding/preferences-extended/_steps";
import type { QuickReplyOption } from "@/lib/onboarding-machine";

interface ChannelMsg {
  id: string;
  role: string;
  content: string;
  createdAt: string;
  metadata?: Record<string, unknown> | null;
}

/** Minimal inline markdown — same surface as primary-link-flow's helper.
 *  Kept local so the two flows stay self-contained; can be extracted to
 *  a shared module if a third flow ever needs it. */
function renderMd(text: string): React.ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*|_[^_]+_|`[^`]+`)/g);
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return (
        <strong key={i} className="font-semibold">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith("_") && part.endsWith("_") && part.length > 2) {
      return (
        <em key={i} className="text-secondary">
          {part.slice(1, -1)}
        </em>
      );
    }
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      return (
        <code key={i} className="text-purple-400 text-[0.9em]">
          {part.slice(1, -1)}
        </code>
      );
    }
    return <span key={i}>{part}</span>;
  });
}

interface PreferencesExtendedFlowProps {
  /** Channel messages (host's full conversation history). Filtered to
   *  `metadata.subkind === "preferences-extended"`. */
  messages: ChannelMsg[];
  /** Append a new turn to the parent's in-memory messages state. */
  onAppendMessage: (msg: ChannelMsg) => void;
  /** Fires when the user dismisses the post-completion state (e.g. clicks
   *  "Back to chat"). Optional — older callers may leave it unset. */
  onDismiss?: () => void;
}

function optionsForStep(step: ExtendedStep): QuickReplyOption[] | null {
  switch (step) {
    case "buffer":
      return BUFFER_OPTIONS;
    case "custom_rules":
      return CUSTOM_RULES_OPTIONS;
    case "evenings":
      return EVENINGS_OPTIONS;
    case "theme":
      return THEME_OPTIONS;
    default:
      return null;
  }
}

function readState(messages: ChannelMsg[]): {
  flowMsgs: ChannelMsg[];
  step: ExtendedStep | null;
  terminal: boolean;
} {
  const flowMsgs = messages
    .filter((m) => {
      const meta = m.metadata as { kind?: string; subkind?: string } | null;
      return meta?.kind === "onboarding" && meta?.subkind === "preferences-extended";
    })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (flowMsgs.length === 0) {
    return { flowMsgs, step: null, terminal: false };
  }
  const latestEnvoy = [...flowMsgs].reverse().find((m) => m.role === "envoy");
  const meta = (latestEnvoy?.metadata ?? {}) as {
    step?: ExtendedStep;
    terminal?: boolean;
  };
  return {
    flowMsgs,
    step: meta.step ?? null,
    terminal: meta.terminal === true,
  };
}

export function PreferencesExtendedFlow({
  messages,
  onAppendMessage,
  onDismiss,
}: PreferencesExtendedFlowProps) {
  const { flowMsgs, step, terminal } = readState(messages);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    if (flowMsgs.length > 0) {
      startedRef.current = true;
      return;
    }
    startedRef.current = true;
    void postAdvance({ start: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function postAdvance(body: Record<string, unknown>): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/onboarding/preferences-extended", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Something went wrong");
        return;
      }
      const now = new Date().toISOString();
      if (typeof body.label === "string" && body.label) {
        onAppendMessage({
          id: `ext-user-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          role: "user",
          content: body.label,
          createdAt: now,
          metadata: { kind: "onboarding", subkind: "preferences-extended", step: data.step },
        });
      }
      const envoyMsgs = (data.messages ?? []) as { content: string }[];
      for (let i = 0; i < envoyMsgs.length; i++) {
        const m = envoyMsgs[i];
        if (!m.content) continue;
        const isLast = i === envoyMsgs.length - 1;
        const meta: Record<string, unknown> = {
          kind: "onboarding",
          subkind: "preferences-extended",
          step: data.step,
        };
        if (isLast && data.complete) meta.terminal = true;
        onAppendMessage({
          id: `ext-envoy-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 6)}`,
          role: "envoy",
          content: m.content,
          createdAt: new Date(Date.now() + i + 1).toISOString(),
          metadata: meta,
        });
      }
    } catch {
      setError("Network error — please try again.");
    } finally {
      setSaving(false);
    }
  }

  function handlePick(value: string, label: string) {
    if (!step) return;
    void postAdvance({ step, value, label });
  }

  const activeOptions = !terminal && step ? optionsForStep(step) : null;

  return (
    <div className="flex-1 flex flex-col py-6 gap-3">
      {flowMsgs.map((m) =>
        m.role === "envoy" ? (
          <div key={m.id} className="flex flex-col gap-1">
            <span className="text-purple-400 text-[10px] font-semibold uppercase tracking-wide px-1">
              Envoy
            </span>
            <div className="bg-black/5 dark:bg-white/[0.07] rounded-2xl rounded-bl-sm px-4 py-3 text-sm text-primary max-w-lg leading-relaxed whitespace-pre-wrap">
              {renderMd(m.content)}
            </div>
          </div>
        ) : (
          <div key={m.id} className="self-end">
            <div className="bg-purple-600 text-white rounded-2xl rounded-br-sm px-4 py-2.5 text-sm max-w-lg leading-relaxed">
              {m.content}
            </div>
          </div>
        ),
      )}

      {!terminal && activeOptions && (
        <div className="self-start max-w-[72%] mt-1">
          <QuickReplies options={activeOptions} onSelect={handlePick} disabled={saving} />
        </div>
      )}

      {error && <div className="self-start text-xs text-rose-400 px-1 mt-1">{error}</div>}

      {terminal && onDismiss && (
        <div className="px-1 mt-2">
          <button
            type="button"
            onClick={onDismiss}
            className="text-xs px-4 py-2 rounded-full bg-indigo-600 hover:bg-indigo-500 text-white font-medium transition"
          >
            Back to chat →
          </button>
        </div>
      )}
    </div>
  );
}
