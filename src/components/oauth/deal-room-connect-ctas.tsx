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
  // sessionId no longer used — the callbackUrl below routes the user back
  // to the deal-room they came from, where the now-connected calendar
  // lights up the bilateral availability view immediately.
  void sessionId;

  const signUpFlow = useOAuthSignIn({
    mode: "first-connect",
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
          onClick={signUpFlow.trigger}
          className={
            variant === "mobile-banner"
              ? "w-full px-3 py-2 rounded-md text-xs font-semibold bg-blue-500/90 hover:bg-blue-500 text-white transition leading-snug"
              : "w-full px-4 py-3 rounded-xl text-sm font-bold bg-gradient-to-r from-violet-600 via-blue-600 to-cyan-500 hover:from-violet-500 hover:via-blue-500 hover:to-cyan-400 text-white transition-all shadow-lg shadow-blue-900/30 leading-snug"
          }
        >
          ✦ Connect your calendar — see where you both have time
        </button>
      </div>
      {signUpFlow.modal}
    </>
  );
}
