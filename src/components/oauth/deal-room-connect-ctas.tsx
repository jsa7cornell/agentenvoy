"use client";

import { useOAuthSignIn } from "./use-oauth-signin";

type Variant = "bubble" | "mobile-banner";

interface Props {
  variant: Variant;
  sessionId: string;
  slug: string;
  code?: string | null;
}

/**
 * Anonymous-viewer CTA in the deal room. One-tap:
 *   Click → pre-consent modal → NextAuth host signin.
 *
 * Rendered at two callsites (in-bubble desktop, mobile sticky banner) so a
 * shared component keeps copy/behavior aligned.
 */
export function DealRoomConnectCtas({
  variant,
  sessionId,
  slug,
  code,
}: Props) {
  // returnUrl preserved for future flows that need to bounce back to the
  // deal room after auth (e.g. read-only path if it returns).
  void slug;
  void code;

  const signUpFlow = useOAuthSignIn({
    mode: "first-connect",
    entryPoint: "deal-room",
    callbackUrl: `/dashboard?from=deal-room&sessionId=${encodeURIComponent(sessionId)}`,
  });

  const wrapperClass =
    variant === "mobile-banner"
      ? "md:hidden border-b border-secondary flex-shrink-0 px-4 py-2"
      : "mb-1";

  return (
    <>
      <div className={wrapperClass}>
        <button
          type="button"
          onClick={signUpFlow.trigger}
          className="w-full px-3 py-2 rounded-md text-xs font-semibold bg-blue-500/90 hover:bg-blue-500 text-white transition leading-snug"
        >
          ✨ Sync your calendar to instantly find the best mutual availability
        </button>
      </div>
      {signUpFlow.modal}
    </>
  );
}
