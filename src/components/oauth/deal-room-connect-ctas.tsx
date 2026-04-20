"use client";

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
 * Anonymous-viewer CTAs in the deal room. Two routes:
 *   - Auto-match (read-only) → guest-calendar OAuth flow (no account)
 *   - Sign up for AgentEnvoy → NextAuth host signin (full account + onboarding)
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
  const returnUrl = `/meet/${slug}${code ? `/${code}` : ""}`;

  const connectReadOnly = () => {
    if (typeof window === "undefined") return;
    window.location.href = `/api/auth/guest-calendar?sessionId=${encodeURIComponent(
      sessionId
    )}&returnUrl=${encodeURIComponent(returnUrl)}`;
  };

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
            🗓️ Auto-match (read-only)
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
  const innerClass =
    "p-3 rounded-lg bg-blue-900/20 border border-blue-800/40 space-y-2";

  return (
    <>
      <div className={expandedWrapperClass}>
        <div className={innerClass}>
          <div className="text-xs font-medium text-blue-200">
            Find the best time automatically?
          </div>
          <p className="text-xs text-secondary leading-snug">
            Connect your calendar (read-only, ~5 seconds) to see times that work
            for both of you. No account needed.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={connectReadOnly}
              className="flex-1 px-2 py-1.5 rounded-md text-xs font-semibold bg-blue-500 hover:bg-blue-600 text-white transition"
            >
              Auto-match (read-only)
            </button>
            <button
              type="button"
              onClick={onCollapse}
              className="flex-1 px-2 py-1.5 rounded-md text-xs font-medium text-secondary border border-secondary hover:border-DEFAULT transition"
            >
              Not now
            </button>
          </div>
          <button
            type="button"
            onClick={signUpFlow.trigger}
            className="block w-full text-center text-[11px] text-blue-300 hover:text-blue-200 underline underline-offset-2 transition pt-1"
          >
            Or sign up for AgentEnvoy →
          </button>
        </div>
      </div>
      {signUpFlow.modal}
    </>
  );
}
