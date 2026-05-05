"use client";

/**
 * DormantReturnBubble — welcome-back bubble for returning-dormant hosts.
 *
 * Introduced in PR-E (onboarding proposal §3.3). Renders when:
 *   1. `welcomeVariant === "returning-dormant"` from /api/me/scheduling-defaults
 *   2. No PrimaryLinkFlow is currently in progress (Q3 guard — auto-resumed
 *      PrimaryLinkFlow wins; see `tuningInProgress` in dormant-eligibility.ts)
 *
 * Deterministic copy — no LLM call needed. Content is derived from the
 * `dormantContext` block returned by the scheduling-defaults GET endpoint.
 *
 * Two chips:
 *   - "Yes, retune" — fires a synthetic host message ("My schedule has
 *     changed — I'd like to retune my setup.") which the classifier routes
 *     to `recalibrate`. The recalibrate module contextLoader reads the same
 *     drift analysis and builds the CALIBRATION DRIFT block.
 *   - "No thanks, dismiss" — removes this bubble for the session; no DB write.
 */

import React, { useState } from "react";
import type { DriftAnalysis } from "@/lib/onboarding/drift";

/** Drift summary passed in from the scheduling-defaults GET response. */
export interface DormantContext {
  daysSinceCalibration: number | null;
  drift: Pick<
    DriftAnalysis,
    | "timezoneDrifted"
    | "durationDrifted"
    | "googleTimezone"
    | "storedTimezone"
    | "googleDuration"
    | "storedDuration"
    | "newCalendarsAvailable"
  >;
}

interface Props {
  name: string | null;
  dormantContext: DormantContext;
  /**
   * Fires when the host clicks "Yes, retune."
   * The caller should submit this as a synthetic host message so the
   * classifier routes it to `recalibrate`.
   */
  onRetune: (message: string) => void;
  /** Fires when the host clicks "No thanks." Caller hides the bubble. */
  onDismiss: () => void;
}

/** Short timezone label — strips continent prefix for readability. */
function shortTz(tz: string): string {
  const parts = tz.split("/");
  return parts[parts.length - 1]?.replace(/_/g, " ") ?? tz;
}

function firstNameOf(name: string | null): string {
  if (!name) return "there";
  return name.split(/\s+/)[0];
}

export function DormantReturnBubble({ name, dormantContext, onRetune, onDismiss }: Props) {
  const [dismissed, setDismissed] = useState(false);

  if (dismissed) return null;

  const { daysSinceCalibration, drift } = dormantContext;

  // Build the drift summary lines.
  const driftLines: string[] = [];

  if (drift.timezoneDrifted && drift.storedTimezone && drift.googleTimezone) {
    driftLines.push(
      `Your timezone may have shifted — Google shows ${shortTz(drift.googleTimezone)} but I have ${shortTz(drift.storedTimezone)} on file.`,
    );
  }

  if (drift.durationDrifted && drift.storedDuration !== null && drift.googleDuration !== null) {
    driftLines.push(
      `Your default meeting length looks different — ${drift.googleDuration} min from Google vs. ${drift.storedDuration} min stored.`,
    );
  }

  if (drift.newCalendarsAvailable > 0) {
    driftLines.push(
      `${drift.newCalendarsAvailable} new calendar${drift.newCalendarsAvailable === 1 ? "" : "s"} in your Google account not yet in your active set.`,
    );
  }

  const hasDrift = driftLines.length > 0;

  const dayLabel =
    daysSinceCalibration !== null
      ? `${daysSinceCalibration} day${daysSinceCalibration === 1 ? "" : "s"}`
      : "a while";

  const syntheticMessage =
    "My schedule has changed — I'd like to retune my setup.";

  function handleRetune() {
    onRetune(syntheticMessage);
  }

  function handleDismiss() {
    setDismissed(true);
    onDismiss();
  }

  return (
    <div className="flex-1 flex flex-col justify-center py-6 gap-4">
      <h1 className="text-xl sm:text-2xl font-semibold text-primary px-1">
        👋 Welcome back, {firstNameOf(name)}.
      </h1>

      {/* Envoy label */}
      <div className="flex flex-col gap-1">
        <span className="text-purple-400 text-[10px] font-semibold uppercase tracking-wide px-1">
          Envoy
        </span>
        <div className="bg-black/5 dark:bg-white/[0.07] rounded-2xl rounded-bl-sm px-4 py-3 text-sm text-primary max-w-lg leading-relaxed">
          <div className="mb-2">
            It&rsquo;s been {dayLabel} since we last synced your setup.
            {hasDrift ? " A few things may have shifted:" : " Everything looks current."}
          </div>

          {hasDrift && (
            <ul className="space-y-1 text-[13px] mb-3 list-disc list-inside text-muted">
              {driftLines.map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ul>
          )}

          <div>
            {hasDrift
              ? "Want to update your setup so I&rsquo;m working with the right info?"
              : "Want a quick review to make sure everything still fits?"}
          </div>
        </div>
      </div>

      {/* Action chips */}
      <div className="flex flex-wrap gap-2 px-1">
        <button
          type="button"
          onClick={handleRetune}
          className="text-xs px-3 py-1.5 rounded-full bg-indigo-600 hover:bg-indigo-500 text-white font-medium transition"
        >
          Yes, retune
        </button>
        <button
          type="button"
          onClick={handleDismiss}
          className="text-xs px-3 py-1.5 rounded-full border border-secondary/60 hover:border-secondary hover:bg-black/5 dark:hover:bg-white/5 text-primary transition"
        >
          No thanks
        </button>
      </div>
    </div>
  );
}
