"use client";

import { GoogleButton } from "./google-button";
import { useOAuthSignIn } from "./use-oauth-signin";

type Variant = "bubble" | "mobile-banner";

interface Props {
  variant: Variant;
  sessionId: string;
  slug: string;
  code?: string | null;
  expanded: boolean;
  onExpand: () => void;
  onCollapse: () => void;
  onDismiss: () => void;
}

/**
 * Anonymous-viewer CTA in the deal room. Single primary route:
 *   Continue with Google → pre-consent modal → NextAuth host signin
 *
 * Rendered at two callsites today (in-bubble desktop, mobile sticky banner).
 * Shared component prevents copy/behavior drift across the two surfaces.
 */
export function DealRoomConnectCtas({
  variant,
  sessionId,
  slug,
  code,
  expanded,
  onExpand,
  onCollapse,
  onDismiss,
}: Props) {
  // returnUrl preserved for future flows that need to bounce back to the
  // deal room after auth (e.g. read-only path if it returns).
  void slug;
  void code;

  const signUpFlow = useOAuthSignIn({
    mode: "first-connect",
    callbackUrl: `/dashboard?from=deal-room&sessionId=${encodeURIComponent(sessionId)}`,
  });

  if (!expanded) {
    const wrapperClass =
      variant === "mobile-banner"
        ? "md:hidden border-b border-secondary flex-shrink-0 px-4 py-2 flex items-center gap-2"
        : "flex items-center gap-2 mb-1";

    return (
      <>
        <div className={wrapperClass}>
          <button
            type="button"
            onClick={onExpand}
            className="flex-1 px-2 py-1.5 rounded-md text-xs font-semibold bg-blue-500/90 hover:bg-blue-500 text-white transition"
          >
            ✨ Safely sync your calendar
          </button>
          <button
            type="button"
            onClick={onDismiss}
            className="text-muted hover:text-secondary transition text-xs"
            title="Dismiss"
          >
            ✕
          </button>
        </div>
        {signUpFlow.modal}
      </>
    );
  }

  const expandedWrapperClass =
    variant === "mobile-banner"
      ? "md:hidden border-b border-secondary flex-shrink-0 px-4 py-3"
      : "mb-3";

  return (
    <>
      <div className={expandedWrapperClass}>
        <div className="p-3.5 rounded-xl border border-indigo-500/30 bg-gradient-to-br from-emerald-500/10 to-indigo-500/10 space-y-3">
          <div className="flex items-start gap-2.5">
            <span
              className="flex-shrink-0 w-5 h-5 rounded-md bg-gradient-to-br from-emerald-500 to-indigo-500 flex items-center justify-center text-[11px] mt-0.5"
              aria-hidden
            >
              ✨
            </span>
            <p className="text-sm font-semibold text-primary leading-snug">
              Safely sync your calendar to automatically find the best time
            </p>
          </div>
          <div className="flex flex-col sm:flex-row sm:items-center gap-2">
            <GoogleButton onClick={signUpFlow.trigger} block />
            <button
              type="button"
              onClick={onCollapse}
              className="text-xs text-muted hover:text-secondary underline underline-offset-2 transition py-2 px-1 sm:py-0"
            >
              Maybe later
            </button>
          </div>
        </div>
      </div>
      {signUpFlow.modal}
    </>
  );
}
