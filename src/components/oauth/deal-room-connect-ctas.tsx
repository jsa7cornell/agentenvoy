"use client";

import { useEffect, useState } from "react";
import { useOAuthSignIn, hasReturningCookie } from "./use-oauth-signin";

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
 *
 * Returning users (ae_returning cookie present) get "Log in to see your
 * match" — skips the pitch modal and goes straight to Google select_account.
 * New users see the trust-building first-connect modal with an escape hatch
 * ("Already have an account?") for cookie-less returning visitors.
 */
export function DealRoomConnectCtas({
  variant,
  sessionId,
  slug,
  code,
}: Props) {
  // sessionId no longer used — the callbackUrl below routes the user back
  // to the deal-room they came from, where the now-connected calendar
  // lights up the bilateral availability view immediately.
  void sessionId;

  const [isReturning, setIsReturning] = useState(false);
  useEffect(() => { setIsReturning(hasReturningCookie()); }, []);

  const signUpFlow = useOAuthSignIn({
    mode: "login",
    entryPoint: "deal-room",
    callbackUrl: `/meet/${slug}${code ? `/${code}` : ""}`,
  });

  const wrapperClass =
    variant === "mobile-banner"
      ? "md:hidden border-b border-secondary flex-shrink-0 px-4 py-2"
      : "hidden md:block mb-1";

  return (
    <>
      <div className={wrapperClass}>
        <button
          type="button"
          onClick={() => {
            // Mark this tab as having just initiated calendar connection so
            // the post-OAuth bilateral celebration banner only fires for
            // fresh connects, not on every revisit. Consumed by deal-room
            // useEffect that flips hasCelebrated. SessionStorage survives
            // the OAuth redirect round-trip in the same tab.
            try {
              window.sessionStorage.setItem("aenv-cal-just-connected", "1");
            } catch {
              // ignore — Safari private mode etc.
            }
            signUpFlow.trigger();
          }}
          className={
            variant === "mobile-banner"
              ? "w-full px-3 py-2 rounded-md text-xs font-semibold bg-blue-500/90 hover:bg-blue-500 text-white transition leading-snug"
              : "w-full px-4 py-3 rounded-xl text-sm font-bold bg-gradient-to-r from-violet-600 via-blue-600 to-cyan-500 hover:from-violet-500 hover:via-blue-500 hover:to-cyan-400 text-white transition-all shadow-lg shadow-blue-900/30 leading-snug"
          }
        >
          {isReturning
            ? "Log in to see your match"
            : "✦ Connect your calendar — see where you both have time"}
        </button>
      </div>
      {signUpFlow.modal}
    </>
  );
}
