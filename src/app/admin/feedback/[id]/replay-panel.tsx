"use client";

/**
 * FB-4 — Replay panel for /admin/feedback/[id].
 *
 * Streams the current prompt's response to the stored conversation history.
 * Diagnostic only — no DB writes. Shows a disclaimer that replay uses current
 * live context, not the frozen snapshot at failure time.
 */

import { useState, useRef } from "react";

interface Props {
  reportId: string;
  disabled?: boolean;
}

export function ReplayPanel({ reportId, disabled }: Props) {
  const [state, setState] = useState<"idle" | "streaming" | "done" | "error">("idle");
  const [output, setOutput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const readerRef = useRef<ReadableStreamDefaultReader<string> | null>(null);

  async function startReplay() {
    setState("streaming");
    setOutput("");
    setError(null);

    try {
      const res = await fetch("/api/admin/replay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reportId }),
      });

      if (!res.ok) {
        const json = (await res.json()) as { error?: string };
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }

      const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
      readerRef.current = reader;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        setOutput((prev) => prev + value);
      }
      setState("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Replay failed");
      setState("error");
    }
  }

  function reset() {
    readerRef.current?.cancel();
    setState("idle");
    setOutput("");
    setError(null);
  }

  return (
    <section className="mb-5 rounded-lg border border-amber-500/30 bg-amber-500/5 p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-xs uppercase tracking-wider text-amber-300">Replay against current prompt</h2>
        {state !== "idle" && (
          <button
            type="button"
            onClick={reset}
            className="text-xs text-zinc-400 hover:text-zinc-200"
          >
            Reset
          </button>
        )}
      </div>

      <p className="mb-3 text-[11px] text-amber-200/60">
        ⚠ Replay uses the <strong>current</strong> system prompt and model tier, not the state at failure time. A positive result verifies the prompt fix helps; it does not guarantee the exact original failure reproduced.
      </p>

      {state === "idle" && (
        <button
          type="button"
          onClick={startReplay}
          disabled={disabled}
          className="rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-xs font-medium text-amber-200 hover:bg-amber-500/20 disabled:opacity-40"
        >
          Replay
        </button>
      )}

      {state === "streaming" && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-xs text-zinc-400">
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />
            Streaming…
          </div>
          {output && (
            <pre className="whitespace-pre-wrap rounded bg-zinc-900 p-3 text-xs text-zinc-200 max-h-64 overflow-y-auto">
              {output}
            </pre>
          )}
        </div>
      )}

      {state === "done" && (
        <div className="space-y-2">
          <pre className="whitespace-pre-wrap rounded bg-zinc-900 p-3 text-xs text-zinc-200 max-h-64 overflow-y-auto">
            {output}
          </pre>
          <p className="text-[11px] text-zinc-500">
            If this looks correct, mark the report as resolved above.
          </p>
        </div>
      )}

      {state === "error" && (
        <p className="text-xs text-red-400">{error}</p>
      )}
    </section>
  );
}
