"use client";

/**
 * Primary link edit dialog — the canonical posture editor.
 *
 * Per the V1.5 model ("Primary IS the posture"), this dialog edits
 * `User.preferences.explicit.*` directly:
 *   - `businessHoursStart/End` + `*Minutes` (the host's daily window)
 *   - `defaultDuration` (15 / 30 / 45 / 60 / 90)
 *   - `bufferMinutes` (0 / 5 / 10 / 15 / 30)
 *   - `defaultFormat` (video / phone / in-person)
 *   - `defaultLocation` (host-private home base)
 *
 * After save, the parent inspects which fields changed and offers an
 * Apply-to-all prompt. The fan-out itself runs through
 * `/api/me/posture/apply-to-all` (which uses `applyPostureToScope`
 * internally).
 *
 * **Why not reuse EventLinksEditDialog?** That dialog hydrates from
 * `recurringWindowConfig` (an Office Hours rule shape) and saves via
 * `/api/availability-rules/edit`. Primary has no rule row — its posture
 * lives on `User.preferences`. The save target differs and so does the
 * field set (Primary doesn't have its own `daysOfWeek` today; that's
 * implicit Mon–Fri at the user level). Sharing a parent component would
 * thread two unrelated control flows; a separate dialog is cleaner.
 *
 * Decision references:
 *  - `proposals/2026-05-02_primary-as-posture-and-reusable-link-propagation` §2.1
 *  - `proposals/2026-05-02_per-link-config-storage-and-scoring-link-scope` §2.2
 */

import { useEffect, useMemo, useState } from "react";
import {
  ApplyToAllPrompt,
  type AffectedLink,
} from "./apply-to-all-prompt";

type FormatValue = "video" | "phone" | "in-person";

interface PrimaryPosture {
  hoursStartMinutes: number;
  hoursEndMinutes: number;
  defaultDuration: number;
  bufferMinutes: number;
  defaultFormat: FormatValue;
  defaultLocation: string;
}

interface PrimaryEditDialogProps {
  /** When false, the dialog is unmounted. Parent owns lifecycle. */
  open: boolean;
  /** Fired after a successful save (and after the optional apply-to-all
   *  step), so the parent can refetch the link list. */
  onSaved: () => void;
  /** Fired when the host dismisses without saving. */
  onDismiss: () => void;
}

const DURATION_OPTIONS = [15, 30, 45, 60, 90];
const BUFFER_OPTIONS = [0, 5, 10, 15, 30];
const FORMAT_OPTIONS: Array<{ value: FormatValue; label: string }> = [
  { value: "video", label: "Video" },
  { value: "phone", label: "Phone" },
  { value: "in-person", label: "In-person" },
];

/** Convert minutes-of-day to a "h:MM AM/PM" string for display. */
function minutesToTime12(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  const suffix = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${suffix}`;
}

/** Parse "h:MM AM/PM" or "HH:MM" 24h to minutes-of-day. Returns null on
 *  failure so the caller can revert the input. */
function time12ToMinutes(input: string): number | null {
  const trimmed = input.trim().toUpperCase();
  const m24 = trimmed.match(/^(\d{1,2}):(\d{2})$/);
  if (m24) {
    const h = Number(m24[1]);
    const m = Number(m24[2]);
    if (h >= 0 && h <= 23 && m >= 0 && m <= 59) return h * 60 + m;
  }
  const m12 = trimmed.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/);
  if (m12) {
    let h = Number(m12[1]);
    const m = Number(m12[2]);
    const suffix = m12[3];
    if (h >= 1 && h <= 12 && m >= 0 && m <= 59) {
      if (suffix === "PM" && h !== 12) h += 12;
      if (suffix === "AM" && h === 12) h = 0;
      return h * 60 + m;
    }
  }
  return null;
}

export function PrimaryEditDialog({ open, onSaved, onDismiss }: PrimaryEditDialogProps) {
  const [posture, setPosture] = useState<PrimaryPosture | null>(null);
  const [originalPosture, setOriginalPosture] = useState<PrimaryPosture | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hoursStartStr, setHoursStartStr] = useState("");
  const [hoursEndStr, setHoursEndStr] = useState("");

  // Apply-to-all flow state — the modal pivots through three states:
  // edit form → (save) → apply-to-all prompt → (confirm/skip) → closed.
  const [phase, setPhase] = useState<"edit" | "apply-to-all">("edit");
  const [affected, setAffected] = useState<AffectedLink[]>([]);
  const [changedFields, setChangedFields] = useState<string[]>([]);

  // Hydrate on open. Reads from /api/me/scheduling-defaults (lightweight;
  // returns the four scalar posture fields) plus /api/tuner/preferences
  // for defaultLocation (not in scheduling-defaults today).
  useEffect(() => {
    if (!open) return;
    setError(null);
    setPhase("edit");
    let cancelled = false;
    (async () => {
      try {
        const [defRes, prefRes] = await Promise.all([
          fetch("/api/me/scheduling-defaults"),
          fetch("/api/tuner/preferences"),
        ]);
        if (cancelled) return;
        const defaults = defRes.ok ? await defRes.json() : null;
        const prefs = prefRes.ok ? await prefRes.json() : null;
        const next: PrimaryPosture = {
          hoursStartMinutes: defaults?.businessHoursStartMinutes ?? 9 * 60,
          hoursEndMinutes: defaults?.businessHoursEndMinutes ?? 17 * 60,
          defaultDuration: defaults?.defaultDuration ?? 30,
          bufferMinutes: defaults?.bufferMinutes ?? 0,
          defaultFormat: (prefs?.defaultFormat as FormatValue) ?? "video",
          defaultLocation: (prefs?.defaultLocation as string) ?? "",
        };
        setPosture(next);
        setOriginalPosture(next);
        setHoursStartStr(minutesToTime12(next.hoursStartMinutes));
        setHoursEndStr(minutesToTime12(next.hoursEndMinutes));
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load preferences");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  function commitHoursStart() {
    if (!posture) return;
    const parsed = time12ToMinutes(hoursStartStr);
    if (parsed !== null) {
      setPosture({ ...posture, hoursStartMinutes: parsed });
    } else {
      setHoursStartStr(minutesToTime12(posture.hoursStartMinutes));
    }
  }

  function commitHoursEnd() {
    if (!posture) return;
    const parsed = time12ToMinutes(hoursEndStr);
    if (parsed !== null) {
      setPosture({ ...posture, hoursEndMinutes: parsed });
    } else {
      setHoursEndStr(minutesToTime12(posture.hoursEndMinutes));
    }
  }

  /** Compute which posture fields actually changed. Used both for the
   *  apply-to-all preview fetch and the prompt copy. */
  const diff = useMemo(() => {
    if (!posture || !originalPosture) return { keys: [] as string[], updates: {} as Record<string, unknown> };
    const keys: string[] = [];
    const updates: Record<string, unknown> = {};
    if (posture.hoursStartMinutes !== originalPosture.hoursStartMinutes) {
      keys.push("hoursStartMinutes");
      updates.hoursStartMinutes = posture.hoursStartMinutes;
    }
    if (posture.hoursEndMinutes !== originalPosture.hoursEndMinutes) {
      keys.push("hoursEndMinutes");
      updates.hoursEndMinutes = posture.hoursEndMinutes;
    }
    if (posture.defaultDuration !== originalPosture.defaultDuration) {
      keys.push("duration");
      updates.duration = posture.defaultDuration;
    }
    if (posture.bufferMinutes !== originalPosture.bufferMinutes) {
      keys.push("bufferMinutes");
      updates.bufferMinutes = posture.bufferMinutes;
    }
    if (posture.defaultFormat !== originalPosture.defaultFormat) {
      keys.push("format");
      updates.format = posture.defaultFormat;
    }
    return { keys, updates };
  }, [posture, originalPosture]);

  const canSave =
    posture !== null &&
    posture.hoursStartMinutes < posture.hoursEndMinutes &&
    diff.keys.length > 0;

  async function handleSave() {
    if (!posture || !originalPosture) return;
    setSubmitting(true);
    setError(null);
    try {
      // Save to user.preferences via the existing scheduling-defaults POST
      // (which writes hours, duration, buffer, format).
      const defRes = await fetch("/api/me/scheduling-defaults", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessHoursStartMinutes: posture.hoursStartMinutes,
          businessHoursEndMinutes: posture.hoursEndMinutes,
          defaultDuration: posture.defaultDuration,
          bufferMinutes: posture.bufferMinutes,
          defaultFormat: posture.defaultFormat,
        }),
      });
      if (!defRes.ok) {
        const body = await defRes.json().catch(() => ({}));
        throw new Error(body.error || `Save failed (${defRes.status})`);
      }

      // Save defaultLocation via tuner/preferences (the existing writer
      // for that field). Skipped when location didn't change to avoid
      // round-tripping the rule compiler.
      if (posture.defaultLocation !== originalPosture.defaultLocation) {
        const prefRes = await fetch("/api/tuner/preferences", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ defaultLocation: posture.defaultLocation }),
        });
        if (!prefRes.ok) {
          const body = await prefRes.json().catch(() => ({}));
          throw new Error(body.error || `Save failed (${prefRes.status})`);
        }
      }

      // If posture fields changed (not just location), check for affected
      // variance links and pivot to the apply-to-all prompt.
      if (diff.keys.length > 0) {
        const params = new URLSearchParams();
        for (const [k, v] of Object.entries(diff.updates)) {
          params.set(k, String(v));
        }
        const affRes = await fetch(`/api/me/posture/apply-to-all?${params.toString()}`);
        if (affRes.ok) {
          const body = (await affRes.json()) as { affected: AffectedLink[] };
          setAffected(body.affected ?? []);
          setChangedFields(diff.keys);
          // Always show the prompt when posture changed — even with zero
          // affected variances, the user sees a confirmation that the
          // Primary edit landed.
          setPhase("apply-to-all");
          setSubmitting(false);
          return;
        }
      }

      // Fall through (location-only change, or affected fetch failed):
      // close the dialog and let the parent refetch.
      onSaved();
      onDismiss();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleApplyToAll() {
    if (diff.keys.length === 0) {
      onSaved();
      onDismiss();
      return;
    }
    try {
      const res = await fetch("/api/me/posture/apply-to-all", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(diff.updates),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Fan-out failed (${res.status})`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Apply-to-all failed");
      // Don't close on fan-out failure — the Primary save already
      // succeeded; the host can retry or skip.
      return;
    }
    onSaved();
    onDismiss();
  }

  function handleSkipApplyToAll() {
    onSaved();
    onDismiss();
  }

  if (!open) return null;

  // Stage 2 — apply-to-all prompt
  if (phase === "apply-to-all") {
    return (
      <ApplyToAllPrompt
        open
        affected={affected}
        changedFields={changedFields}
        onConfirm={handleApplyToAll}
        onSkip={handleSkipApplyToAll}
      />
    );
  }

  // Stage 1 — edit form
  return (
    <div
      className="fixed inset-0 z-[70] flex items-end md:items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="primary-edit-title"
      data-testid="primary-edit-dialog"
    >
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => !submitting && onDismiss()}
        className="absolute inset-0 bg-black/55"
      />

      <div className="relative bg-background border-t md:border border-secondary md:rounded-2xl md:shadow-xl w-full md:max-w-md flex flex-col max-h-[88vh] md:max-h-[80vh]">
        {/* Drag handle (mobile only) */}
        <div className="flex md:hidden justify-center pt-2.5 pb-1">
          <div className="w-9 h-1 rounded-full bg-foreground/20" />
        </div>

        {/* Header */}
        <div className="flex items-center justify-between px-4 md:px-5 pt-3 md:pt-4 pb-2">
          <div className="flex items-center gap-2">
            <span
              className="w-7 h-7 rounded-md bg-accent/15 flex items-center justify-center text-base"
              aria-hidden
            >
              🔗
            </span>
            <div>
              <h3
                id="primary-edit-title"
                className="text-sm font-semibold text-primary"
              >
                Edit Primary link
              </h3>
              <div className="text-[11px] text-muted">
                The defaults that apply when you share your main URL
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => !submitting && onDismiss()}
            disabled={submitting}
            aria-label="Dismiss"
            className="text-foreground/40 hover:text-foreground/70 text-lg leading-none px-1"
          >
            ×
          </button>
        </div>

        {/* Form body */}
        <div className="flex-1 overflow-y-auto px-4 md:px-5 pb-3 flex flex-col gap-3">
          {!posture ? (
            <div className="text-xs text-muted px-1 py-3">Loading…</div>
          ) : (
            <>
              {/* Format */}
              <div className="grid grid-cols-[80px_1fr] items-center gap-3">
                <label className="text-[10px] font-semibold uppercase tracking-wide text-foreground/50">
                  Format
                </label>
                <select
                  className="w-full rounded-md bg-surface border border-secondary px-2.5 py-1.5 text-[12px] text-primary outline-none focus:border-accent"
                  value={posture.defaultFormat}
                  onChange={(e) =>
                    setPosture({ ...posture, defaultFormat: e.target.value as FormatValue })
                  }
                  disabled={submitting}
                  data-testid="primary-edit-format"
                >
                  {FORMAT_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>

              {/* Duration */}
              <div className="grid grid-cols-[80px_1fr] items-center gap-3">
                <label className="text-[10px] font-semibold uppercase tracking-wide text-foreground/50">
                  Duration
                </label>
                <select
                  className="w-full rounded-md bg-surface border border-secondary px-2.5 py-1.5 text-[12px] text-primary outline-none focus:border-accent"
                  value={posture.defaultDuration}
                  onChange={(e) =>
                    setPosture({ ...posture, defaultDuration: Number(e.target.value) })
                  }
                  disabled={submitting}
                  data-testid="primary-edit-duration"
                >
                  {DURATION_OPTIONS.map((d) => (
                    <option key={d} value={d}>
                      {d} min
                    </option>
                  ))}
                </select>
              </div>

              {/* Buffer */}
              <div className="grid grid-cols-[80px_1fr] items-center gap-3">
                <label className="text-[10px] font-semibold uppercase tracking-wide text-foreground/50">
                  Buffer
                </label>
                <select
                  className="w-full rounded-md bg-surface border border-secondary px-2.5 py-1.5 text-[12px] text-primary outline-none focus:border-accent"
                  value={posture.bufferMinutes}
                  onChange={(e) =>
                    setPosture({ ...posture, bufferMinutes: Number(e.target.value) })
                  }
                  disabled={submitting}
                  data-testid="primary-edit-buffer"
                >
                  {BUFFER_OPTIONS.map((b) => (
                    <option key={b} value={b}>
                      {b === 0 ? "No buffer" : `${b} min`}
                    </option>
                  ))}
                </select>
              </div>

              {/* Hours */}
              <div className="grid grid-cols-[80px_1fr] items-center gap-3">
                <span className="text-[10px] font-semibold uppercase tracking-wide text-foreground/50">
                  Hours
                </span>
                <div className="flex items-center gap-2 text-[12px] text-primary">
                  <input
                    type="text"
                    className="w-24 rounded-md bg-surface border border-secondary px-2.5 py-1.5 text-[12px] outline-none focus:border-accent"
                    value={hoursStartStr}
                    onChange={(e) => setHoursStartStr(e.target.value)}
                    onBlur={commitHoursStart}
                    disabled={submitting}
                    data-testid="primary-edit-hours-start"
                  />
                  <span className="text-muted">–</span>
                  <input
                    type="text"
                    className="w-24 rounded-md bg-surface border border-secondary px-2.5 py-1.5 text-[12px] outline-none focus:border-accent"
                    value={hoursEndStr}
                    onChange={(e) => setHoursEndStr(e.target.value)}
                    onBlur={commitHoursEnd}
                    disabled={submitting}
                    data-testid="primary-edit-hours-end"
                  />
                </div>
              </div>

              {/* Default location */}
              <div className="grid grid-cols-[80px_1fr] items-center gap-3">
                <label className="text-[10px] font-semibold uppercase tracking-wide text-foreground/50">
                  Location
                </label>
                <input
                  type="text"
                  className="w-full rounded-md bg-surface border border-secondary px-2.5 py-1.5 text-[12px] text-primary outline-none focus:border-accent"
                  value={posture.defaultLocation}
                  onChange={(e) =>
                    setPosture({ ...posture, defaultLocation: e.target.value })
                  }
                  placeholder="e.g. Coupa Cafe — host-private, never shared"
                  disabled={submitting}
                  data-testid="primary-edit-location"
                />
              </div>

              <p className="text-[11px] text-muted leading-relaxed mt-1">
                Days are Monday–Friday by default. To customize advanced windows,
                say so in chat or create a separate Bookable Hours link.
              </p>
            </>
          )}

          {error && (
            <p className="text-[11px] text-red-500" data-testid="primary-edit-error">
              {error}
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-secondary px-4 md:px-5 py-3 flex gap-2 bg-background md:rounded-b-2xl">
          <button
            type="button"
            onClick={handleSave}
            disabled={submitting || !canSave}
            data-testid="primary-edit-save"
            className="flex-1 rounded-lg bg-accent hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold px-3 py-2.5 transition-colors"
          >
            {submitting ? "Saving…" : "Save changes"}
          </button>
          <button
            type="button"
            onClick={() => !submitting && onDismiss()}
            disabled={submitting}
            className="flex-1 rounded-lg bg-transparent border border-secondary text-secondary hover:bg-surface-secondary/60 text-sm font-semibold px-3 py-2.5 transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
