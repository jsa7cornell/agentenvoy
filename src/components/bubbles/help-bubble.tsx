"use client";

/**
 * Reusable shell for a contextual FYI nudge — a fixed bottom-right card
 * with a short message, an optional "Open ___" action, and a dismiss
 * affordance.
 *
 * The dark-mode auto-flip explainer is the first user; the look is
 * deliberately preserved here so future bubbles read as the same family.
 *
 * Bubbles supply their own:
 *   - trigger logic (when to mount the bubble)
 *   - persistence (whether the user has dismissed; usually a server-side
 *     `seen<X>` flag on `User.preferences.explicit.*`)
 *   - copy + target
 *
 * The shell handles layout, dismiss button, and (via `useOpenTarget`) the
 * device-aware routing of the action so no bubble can land a mobile user
 * on a dead-end page.
 */

import { useOpenTarget } from "./use-open-target";
import type { BubbleTarget } from "./targets";

interface HelpBubbleProps {
  /** Stable identifier — drives `data-testid` and is the natural key for
   *  any analytics/persistence the caller wires up. */
  id: string;
  /** Body copy. Plain text; keep to 1–2 sentences. */
  message: string;
  /** Logical destination for the action button. Resolves to a drawer on
   *  mobile when one exists, otherwise a route push. Omit to render no
   *  action button. */
  target?: BubbleTarget;
  /** Action label, e.g. "Open preferences". A trailing arrow is appended. */
  targetLabel?: string;
  /** Called for both the × button and the "Got it" button. The action
   *  button also calls this after opening the target so the bubble doesn't
   *  reappear behind the drawer. */
  onDismiss: () => void;
}

export function HelpBubble({ id, message, target, targetLabel, onDismiss }: HelpBubbleProps) {
  const openTarget = useOpenTarget();

  return (
    <div
      className="fixed bottom-4 right-4 z-[90] max-w-sm rounded-xl border border-purple-500/40 bg-surface shadow-lg px-4 py-3"
      role="status"
      data-testid={`help-bubble-${id}`}
    >
      <div className="flex items-start gap-3">
        <div className="flex-1 text-sm text-primary leading-relaxed">{message}</div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="text-muted hover:text-primary transition text-lg leading-none -mt-0.5"
        >
          ×
        </button>
      </div>
      <div className="flex justify-end gap-2 mt-2">
        {target && targetLabel && (
          <button
            type="button"
            onClick={() => {
              openTarget(target);
              onDismiss();
            }}
            className="text-[11px] text-purple-400 hover:text-purple-300 underline underline-offset-2"
            data-testid={`help-bubble-${id}-action`}
          >
            {targetLabel} →
          </button>
        )}
        <button
          type="button"
          onClick={onDismiss}
          className="text-[11px] text-muted hover:text-primary transition"
          data-testid={`help-bubble-${id}-got-it`}
        >
          Got it
        </button>
      </div>
    </div>
  );
}
