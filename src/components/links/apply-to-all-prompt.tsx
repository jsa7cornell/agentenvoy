"use client";

/**
 * "Apply to all reusable links?" prompt — shown after a host saves a
 * Primary edit (or Office Hours edit) that changes scoring posture.
 *
 * Surface-symmetric with the chat fan-out narration: "I'll block this
 * globally across all your links — let me know if you wanted only certain
 * ones." Modal default is **Yes**; the host can opt out with **No, just
 * this link**. This matches the per-link-config-storage proposal §2.5
 * decision (default-all, scope-down on correction).
 *
 * Lifecycle:
 *   1. Parent saves the edit, writes to User.preferences.
 *   2. Parent fetches affected variances (GET /api/me/posture/apply-to-all
 *      with the changed fields as query params) and renders this prompt
 *      with the resulting list.
 *   3. On Yes → parent calls POST /api/me/posture/apply-to-all with the
 *      same field set. On No → parent dismisses.
 *
 * UX:
 *   - List caps at 3 names + "+N more" (parent §2.2 reviewer R1 fold).
 *   - Empty list (no variance differs) → parent should never render this
 *     prompt; defensive empty-state included for safety.
 *
 * Decision references:
 *  - `proposals/2026-05-02_per-link-config-storage-and-scoring-link-scope` §2.5
 *  - `proposals/2026-05-02_primary-as-posture-and-reusable-link-propagation` §2.2
 */

import { useState } from "react";

export interface AffectedLink {
  id: string;
  name: string;
}

interface ApplyToAllPromptProps {
  /** When false, the prompt isn't rendered (parent owns lifecycle). */
  open: boolean;
  /** The changed fields the parent is offering to propagate. The component
   *  doesn't act on these directly — it just relays them to onConfirm. */
  changedFields: string[];
  /** Variance links whose current values differ from the proposed update.
   *  Render-capped at 3 + "+N more". */
  affected: AffectedLink[];
  /** Apply to all reusable links (call POST /api/me/posture/apply-to-all). */
  onConfirm: () => Promise<void> | void;
  /** Keep the change Primary-only (just dismiss). */
  onSkip: () => void;
}

const NAME_CAP = 3;

export function ApplyToAllPrompt({
  open,
  changedFields,
  affected,
  onConfirm,
  onSkip,
}: ApplyToAllPromptProps) {
  const [submitting, setSubmitting] = useState(false);

  if (!open) return null;

  const visibleNames = affected.slice(0, NAME_CAP).map((a) => a.name);
  const remainder = affected.length - visibleNames.length;
  const namesString =
    visibleNames.length === 0
      ? "any other reusable links"
      : remainder > 0
        ? `${visibleNames.join(", ")}, +${remainder} more`
        : visibleNames.length === 1
          ? visibleNames[0]
          : visibleNames.length === 2
            ? `${visibleNames[0]} and ${visibleNames[1]}`
            : `${visibleNames.slice(0, -1).join(", ")}, and ${visibleNames[visibleNames.length - 1]}`;

  const fieldsString = changedFields.length > 0
    ? formatFieldList(changedFields)
    : "this change";

  async function handleYes() {
    setSubmitting(true);
    try {
      await onConfirm();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center px-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="apply-to-all-title"
      data-testid="apply-to-all-prompt"
    >
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => !submitting && onSkip()}
        className="absolute inset-0 bg-black/55"
      />
      <div className="relative bg-background border border-secondary rounded-2xl shadow-xl max-w-md w-full p-5 flex flex-col gap-3">
        <h3 id="apply-to-all-title" className="text-base font-semibold text-primary">
          Apply to all reusable links?
        </h3>
        <p className="text-[13px] text-secondary leading-relaxed">
          Your Primary link is updated.{" "}
          {affected.length > 0 ? (
            <>
              Want to apply <span className="font-medium text-primary">{fieldsString}</span> to{" "}
              <span className="font-medium text-primary">{namesString}</span> too?
            </>
          ) : (
            <>You don&apos;t have other reusable links yet — nothing else to update.</>
          )}
        </p>

        <div className="flex flex-col-reverse sm:flex-row gap-2 mt-1">
          <button
            type="button"
            onClick={() => !submitting && onSkip()}
            disabled={submitting}
            className="flex-1 rounded-lg border border-secondary text-secondary hover:bg-surface-secondary/60 text-sm font-medium px-3 py-2.5 transition-colors disabled:opacity-50"
            data-testid="apply-to-all-skip"
          >
            {affected.length > 0 ? "No, just Primary" : "OK"}
          </button>
          {affected.length > 0 && (
            <button
              type="button"
              onClick={handleYes}
              disabled={submitting}
              className="flex-1 rounded-lg bg-accent hover:bg-accent/90 text-white text-sm font-semibold px-3 py-2.5 transition-colors disabled:opacity-50"
              data-testid="apply-to-all-confirm"
            >
              {submitting ? "Applying…" : "Yes, apply to all"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

const FIELD_LABELS: Record<string, string> = {
  hoursStartMinutes: "business hours",
  hoursEndMinutes: "business hours",
  duration: "default duration",
  bufferMinutes: "buffer",
  format: "default format",
  eveningsPosture: "evenings posture",
  daysOfWeek: "available days",
};

/** Format a list of changed field-keys as a human-readable phrase. Dedupes
 *  hours start/end into a single "business hours" entry. */
function formatFieldList(keys: string[]): string {
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const k of keys) {
    const lbl = FIELD_LABELS[k] ?? k;
    if (seen.has(lbl)) continue;
    seen.add(lbl);
    labels.push(lbl);
  }
  if (labels.length === 0) return "this change";
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}`;
}
