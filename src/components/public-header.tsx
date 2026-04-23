"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { LogoFull } from "./logo";
import { useOAuthSignIn, hasReturningCookie } from "./oauth/use-oauth-signin";

/**
 * Minimal header for public pages (FAQ, Terms, Privacy, Agents).
 * Matches the dashboard header's visual style but without auth/session features.
 *
 * The "Sign in / Join" CTA is a single entry point — Google's account chooser
 * routes new vs existing users automatically, so one link serves both intents.
 */
export function PublicHeader() {
  // `mode: "login"` — the same button serves new AND returning users. Cookie
  // presence gates whether the pre-consent modal shows (first-timer) or is
  // skipped entirely (returning user).
  const { trigger, modal } = useOAuthSignIn({
    mode: "login",
    callbackUrl: "/dashboard",
  });

  const [isReturning, setIsReturning] = useState(false);
  useEffect(() => { setIsReturning(hasReturningCookie()); }, []);

  return (
    <header className="sticky top-0 z-50 bg-surface/95 backdrop-blur-sm border-b border-secondary">
      <div className="max-w-5xl mx-auto px-6 py-3 flex items-center justify-between">
        <Link href="/" className="text-indigo-400 hover:text-indigo-300 transition">
          <LogoFull height={28} />
        </Link>
        <div className="flex items-center gap-4">
          <Link
            href="/faq"
            className="text-xs text-secondary hover:text-primary transition"
          >
            How It Works
          </Link>
          <Link
            href="/agents"
            className="text-xs text-secondary hover:text-primary transition"
          >
            For Agents
          </Link>
          <button
            type="button"
            onClick={trigger}
            className="text-xs bg-indigo-600 hover:bg-indigo-500 text-white px-3 py-1.5 rounded-md transition font-medium"
          >
            {isReturning ? "Sign in" : "Sign in / Join"}
          </button>
        </div>
      </div>
      {modal}
    </header>
  );
}
