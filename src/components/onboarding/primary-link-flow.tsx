"use client";

/**
 * Renderer for the primary-link tuning conversational flow.
 *
 * Per SPEC §6.6 "Chat thread invariants" + proposal `2026-04-30_onboarding-and-tuning-as-chat`:
 * this component does NOT own a state machine. Each user pick POSTs to
 * `/api/onboarding/primary-link`, which persists the user's message + the
 * Envoy response as `ChannelMessage` rows tagged
 * `metadata: { kind: "onboarding", subkind: "primary-link-tuning", step }`,
 * and returns the response so the parent (`Feed`) can append to its in-memory
 * messages state.
 *
 * Resume model: current step is inferred from the most recent persisted
 * tuning message's metadata. The component reads `messages` from props
 * (filtered to the tuning subkind), renders them, and shows the active
 * step's quick-replies based on that latest message's metadata.
 */

import { useEffect, useRef, useState } from "react";
import { QuickReplies } from "./quick-replies";
import { WelcomeCelebration } from "./welcome-celebration";
import {
  HOURS_OPTIONS,
  DURATION_OPTIONS,
  FORMAT_OPTIONS,
  GUEST_FLEX_OPTIONS,
  type PrimaryLinkStep,
} from "@/app/api/onboarding/primary-link/_steps";
import type { QuickReplyOption } from "@/lib/onboarding/types";

interface ChannelMsg {
  id: string;
  role: string;
  content: string;
  createdAt: string;
  metadata?: Record<string, unknown> | null;
}

/** Minimal inline markdown for tuning bubbles. Supports **bold**, _italic_,
 *  and `code` — same vocabulary the route emits in step prompts. Not full
 *  markdown; if a step needs links or lists, route emits explicit text and
 *  this stays small. */
function renderTuningMarkdown(text: string): React.ReactNode[] {
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

type FreetextHint = "timezone-other" | "hours-custom" | "zoom-link" | "phone-number";

interface PrimaryLinkFlowProps {
  /** Channel messages (host's full conversation history). The component
   *  filters to `metadata.subkind === "primary-link-tuning"` to identify
   *  its own turns. */
  messages: ChannelMsg[];
  /** Push a new message into the parent's in-memory state so it appears
   *  in the feed without a refetch. Mirrors the legacy
   *  `addEnvoyMessage`/`addUserMessage` pattern. */
  onAppendMessage: (msg: ChannelMsg) => void;
  /** Browser-detected timezone — passed on `start` so the route can
   *  propose it as the default. */
  browserTz: string | null;
  /** Fires when the host taps the celebration's "Back to chat" CTA. */
  onDismiss?: () => void;
  /** Optional post-flow seed handler — see legacy contract. */
  onPostFlowSeed?: (seed: string) => void;
  /** Display name for the celebration headline. */
  hostName: string | null;
  /** Primary-link slug for the celebration headline + summary fallback. */
  meetSlug: string | null;
  /** Called whenever the active freetext step changes. When a freetext step
   *  is active (phone, zoom, custom hours), passes { submit, placeholder }
   *  so the parent's main composer routes text directly here — one fluid
   *  input rather than an inline box + a main composer. Passes null when
   *  no freetext step is active. */
  onComposerBridge?: (state: { submit: (text: string) => void; placeholder: string } | null) => void;
}

/**
 * Static option set for each step. The tuning route writes the prompt
 * content to ChannelMessage but the options are determined by the step
 * name alone (deterministic). Timezone options are dynamic — they need
 * the browser tz — so they're built inline below.
 */
function staticOptionsForStep(step: PrimaryLinkStep): QuickReplyOption[] | null {
  switch (step) {
    case "hours":
      return HOURS_OPTIONS;
    case "duration":
      return DURATION_OPTIONS;
    case "format":
      return FORMAT_OPTIONS;
    case "guest_flex":
      return GUEST_FLEX_OPTIONS;
    default:
      return null;
  }
}

const TZ_BASE = [
  { label: "America/Los_Angeles", value: "America/Los_Angeles" },
  { label: "America/Denver", value: "America/Denver" },
  { label: "America/Chicago", value: "America/Chicago" },
  { label: "America/New_York", value: "America/New_York" },
  { label: "Europe/London", value: "Europe/London" },
  { label: "Asia/Tokyo", value: "Asia/Tokyo" },
];

function timezoneOptions(browserTz: string | null): QuickReplyOption[] {
  const opts: QuickReplyOption[] = [];
  let n = 1;
  if (browserTz) {
    opts.push({ number: n++, label: `Yes, ${browserTz} is right`, value: browserTz });
  }
  for (const o of TZ_BASE) {
    if (o.value === browserTz) continue;
    opts.push({ number: n++, label: o.label, value: o.value });
  }
  opts.push({ number: n++, label: "Other / not sure", value: "__other__" });
  return opts;
}

function activeOptionsFor(step: PrimaryLinkStep, browserTz: string | null): QuickReplyOption[] | null {
  if (step === "timezone") return timezoneOptions(browserTz);
  return staticOptionsForStep(step);
}

/** Extract the latest tuning message and its inferred step + freetextHint
 *  from the channel. Used both on first mount and after each POST to know
 *  what to render. */
function readTuningState(messages: ChannelMsg[]): {
  tuningMsgs: ChannelMsg[];
  step: PrimaryLinkStep | null;
  freetextHint: FreetextHint | null;
  terminal: boolean;
} {
  const tuningMsgs = messages
    .filter((m) => {
      const meta = m.metadata as { kind?: string; subkind?: string } | null;
      return meta?.kind === "onboarding" && meta?.subkind === "primary-link-tuning";
    })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (tuningMsgs.length === 0) {
    return { tuningMsgs, step: null, freetextHint: null, terminal: false };
  }
  // Latest envoy message determines the active step's options.
  const latestEnvoy = [...tuningMsgs].reverse().find((m) => m.role === "envoy");
  const meta = (latestEnvoy?.metadata ?? {}) as {
    step?: PrimaryLinkStep;
    freetextHint?: FreetextHint;
    terminal?: boolean;
  };
  return {
    tuningMsgs,
    step: meta.step ?? null,
    freetextHint: meta.freetextHint ?? null,
    terminal: meta.terminal === true,
  };
}

export function PrimaryLinkFlow({
  messages,
  onAppendMessage,
  browserTz,
  onDismiss,
  onPostFlowSeed,
  hostName,
  meetSlug,
  onComposerBridge,
}: PrimaryLinkFlowProps) {
  const { tuningMsgs, step, freetextHint, terminal } = readTuningState(messages);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [freetextInput, setFreetextInput] = useState("");
  const startedRef = useRef(false);

  // Register/unregister the composer bridge whenever the freetext step changes.
  // The parent's main composer routes text here on freetext steps — one
  // input, no ambiguity.
  useEffect(() => {
    if (!onComposerBridge) return;
    if (terminal || !freetextHint) {
      onComposerBridge(null);
      return;
    }
    const placeholder =
      freetextHint === "hours-custom"
        ? "e.g. 8:30 to 5:30"
        : freetextHint === "zoom-link"
          ? "https://zoom.us/j/…"
          : freetextHint === "phone-number"
            ? "+1 555-1234"
            : "e.g. America/Phoenix";
    onComposerBridge({
      placeholder,
      submit: (text: string) => {
        if (!step) return;
        void postAdvance({ step, freetext: text, label: text, browserTz });
      },
    });
    return () => onComposerBridge(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [freetextHint, terminal, step]);

  // Kick-off: if there are no tuning messages yet, POST {start: true} to
  // get the timezone prompt persisted + returned.
  useEffect(() => {
    if (startedRef.current) return;
    if (tuningMsgs.length > 0) {
      startedRef.current = true;
      return;
    }
    startedRef.current = true;
    void postAdvance({ start: true, browserTz });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function postAdvance(body: Record<string, unknown>): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/onboarding/primary-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Something went wrong");
        return;
      }
      // Append the new turns the server persisted. We synthesize transient
      // ChannelMsg shapes (matching what /api/channel/messages returns) so
      // the parent's render loop picks them up. createdAt uses now() so
      // ordering is stable until the next refetch.
      const now = new Date().toISOString();
      // If the body included a label (user pick), the server persisted a
      // user message — synthesize it client-side too for immediate feedback.
      if (typeof body.label === "string" && body.label) {
        onAppendMessage({
          id: `tuning-user-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          role: "user",
          content: body.label,
          createdAt: now,
          metadata: { kind: "onboarding", subkind: "primary-link-tuning", step: data.step },
        });
      }
      const envoyMsgs = (data.messages ?? []) as { content: string }[];
      for (let i = 0; i < envoyMsgs.length; i++) {
        const m = envoyMsgs[i];
        if (!m.content) continue;
        const isLast = i === envoyMsgs.length - 1;
        const meta: Record<string, unknown> = {
          kind: "onboarding",
          subkind: "primary-link-tuning",
          step: data.step,
        };
        if (isLast && data.freetextHint) meta.freetextHint = data.freetextHint;
        if (isLast && data.complete) meta.terminal = true;
        onAppendMessage({
          id: `tuning-envoy-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 6)}`,
          role: "envoy",
          content: m.content,
          createdAt: new Date(Date.now() + i + 1).toISOString(),
          metadata: meta,
        });
      }
      setFreetextInput("");
    } catch {
      setError("Network error — please try again.");
    } finally {
      setSaving(false);
    }
  }

  function handlePick(value: string, label: string) {
    if (!step) return;
    void postAdvance({ step, value, label, browserTz });
  }

  function handleFreetextSubmit() {
    if (!step) return;
    const trimmed = freetextInput.trim();
    if (!trimmed) return;
    const label =
      freetextHint === "timezone-other"
        ? trimmed
        : freetextHint === "hours-custom"
          ? trimmed
          : trimmed;
    void postAdvance({ step, freetext: trimmed, label, browserTz });
  }

  const activeOptions = !terminal && step ? activeOptionsFor(step, browserTz) : null;

  function firstNameOf(n: string | null): string | null {
    if (!n) return null;
    const f = n.split(/\s+/)[0]?.trim();
    return f || null;
  }

  return (
    <div className="flex-1 flex flex-col py-6 gap-3">
      {tuningMsgs.map((m) =>
        m.role === "envoy" ? (
          <div key={m.id} className="flex flex-col gap-1">
            <span className="text-purple-400 text-[10px] font-semibold uppercase tracking-wide px-1">
              Envoy
            </span>
            <div className="bg-black/5 dark:bg-white/[0.07] rounded-2xl rounded-bl-sm px-4 py-3 text-sm text-primary max-w-lg leading-relaxed whitespace-pre-wrap">
              {renderTuningMarkdown(m.content)}
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

      {!terminal && activeOptions && !freetextHint && (
        <div className="self-start max-w-[72%] mt-1">
          <QuickReplies options={activeOptions} onSelect={handlePick} disabled={saving} />
        </div>
      )}

      {/* Inline freetext — only rendered when the parent composer bridge is
          NOT active. When onComposerBridge is provided the main composer at
          the bottom of the page handles the input, keeping one clear entry
          point for the user. */}
      {!terminal && freetextHint && !onComposerBridge && (
        <div className="self-start max-w-[72%] mt-2 flex flex-col gap-1.5">
          <form
            onSubmit={(ev) => {
              ev.preventDefault();
              handleFreetextSubmit();
            }}
            className="flex gap-2"
          >
            <input
              type="text"
              autoFocus
              value={freetextInput}
              onChange={(ev) => setFreetextInput(ev.target.value)}
              placeholder={
                freetextHint === "hours-custom"
                  ? "e.g. 8:30 to 5:30"
                  : freetextHint === "zoom-link"
                    ? "https://zoom.us/j/…"
                    : freetextHint === "phone-number"
                      ? "+1 555-1234"
                      : "e.g. America/Phoenix"
              }
              className="flex-1 text-sm px-3.5 py-2.5 rounded-xl border border-indigo-500/30 bg-indigo-500/5 text-primary placeholder:text-primary/40 focus:outline-none focus:border-indigo-500/60"
              disabled={saving}
            />
            <button
              type="submit"
              disabled={saving || !freetextInput.trim()}
              className="px-4 py-2 bg-purple-600 hover:bg-purple-500 disabled:opacity-40 text-white text-sm font-medium rounded-xl transition"
            >
              Set
            </button>
          </form>
          {error && <span className="text-xs text-rose-400 px-1">{error}</span>}
        </div>
      )}

      {/* Error when bridge is active (input lives in parent composer) */}
      {error && (onComposerBridge || !freetextHint) && (
        <div className="self-start text-xs text-rose-400 px-1 mt-1">{error}</div>
      )}

      {terminal && onDismiss && (
        <WelcomeCelebration
          firstName={firstNameOf(hostName)}
          meetSlug={meetSlug}
          onDismiss={onDismiss}
          onPostFlowSeed={onPostFlowSeed}
        />
      )}
    </div>
  );
}
