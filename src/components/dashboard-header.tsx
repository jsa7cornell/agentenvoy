"use client";

import { useState, useEffect } from "react";
import { useSession } from "next-auth/react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { LogoFull } from "./logo";
import { useOAuthSignIn, hasReturningCookie } from "./oauth/use-oauth-signin";
import { onboardingCallbackUrl } from "@/lib/onboarding/return-to";

const BADGE_COUNTS_REVALIDATE_MS = 30_000;

/**
 * Site header. Single component across every page — host dashboard, logged-in
 * guest deal room, anonymous guest deal room. Layout stays identical (logo
 * left, profile right); contents adapt to auth state.
 *
 * Never build a bespoke header for a single page. Inline banners below the
 * header can vary freely, but the header itself is always this component.
 *
 * **Layout.** Single three-element layout at all breakpoints — Logo+Home left |
 * Event Links tab center | Avatar+Preferences right. The anonymous branch shows
 * logo + sign-in only. See `refactor-package-2026-04-25/SPEC-2.0.md`
 * §3.1 and `mockups/desktop-v2.html` for the visual contract.
 *
 * Cyan dot on the Event Links tab indicates one or more sessions are in
 * `awaiting_ack_self` state. Backed by `/api/dashboard/badge-counts`,
 * revalidating every 30s. Decorative — fetch failures render nothing.
 */
export function DashboardHeader({ signInCallbackUrl }: { signInCallbackUrl?: string } = {}) {
  const { data: session, status: sessionStatus } = useSession();
  const pathname = usePathname();

  const [isReturning, setIsReturning] = useState(false);
  useEffect(() => { setIsReturning(hasReturningCookie()); }, []);

  const isAccount = pathname.startsWith("/dashboard/account");
  const isDashboard = pathname === "/dashboard" || pathname === "/dashboard/";
  // Future-proofs the PR 3 swap from /dashboard/meetings → /dashboard/event-links.
  const isEventLinks =
    pathname.startsWith("/dashboard/meetings") ||
    pathname.startsWith("/dashboard/event-links");
  const isSignedIn = sessionStatus === "authenticated" && !!session?.user;

  // Cyan-dot fetch — mirrors the pattern in mobile-dashboard-header.tsx.
  const [awaitingAck, setAwaitingAck] = useState(0);
  useEffect(() => {
    if (!isSignedIn) return;
    let cancelled = false;
    const controller = new AbortController();

    async function load() {
      try {
        const res = await fetch("/api/dashboard/badge-counts", {
          signal: controller.signal,
          credentials: "same-origin",
        });
        if (!res.ok) return;
        const data = (await res.json()) as { awaitingAck?: unknown };
        if (cancelled) return;
        if (typeof data.awaitingAck === "number" && Number.isFinite(data.awaitingAck)) {
          setAwaitingAck(data.awaitingAck);
        }
      } catch {
        // Silent fail — dot is decorative.
      }
    }

    load();
    const timer = setInterval(load, BADGE_COUNTS_REVALIDATE_MS);
    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(timer);
    };
  }, [isSignedIn]);

  const hasAwaitingAck = awaitingAck > 0;

  // `mode: "login"` — anonymous viewers on a logged-in-host surface (deal
  // room, etc.) are likely returning users. `useOAuthSignIn` suppresses the
  // pre-consent modal when the `ae_returning` cookie is present and uses
  // `prompt: "select_account"` so returning users don't re-grant. First-time
  // visitors still see the first-connect trust copy via the modal fallback.
  const rawCallback =
    signInCallbackUrl ||
    (typeof window !== "undefined" ? window.location.pathname + window.location.search : "/");
  const anonSignIn = useOAuthSignIn({
    mode: "login",
    callbackUrl: onboardingCallbackUrl(rawCallback),
  });

  // Anonymous variant — same layout, but logo links home and the right side
  // is a single Sign-in button that round-trips back to the current page.
  if (!isSignedIn) {
    return (
      <header className="sticky top-0 z-50 bg-surface/95 backdrop-blur-sm border-b border-secondary flex-shrink-0">
        <div className="px-4 sm:px-6 py-2.5 flex items-center gap-3">
          <Link href="/" className="flex-shrink-0" title="AgentEnvoy">
            <LogoFull height={22} className="text-primary" />
          </Link>
          <div className="flex-1" />
          <button
            type="button"
            onClick={anonSignIn.trigger}
            className="text-xs text-muted hover:text-primary transition px-2 py-1"
            data-testid="header-signin"
          >
            {isReturning ? "Sign in" : "Sign in / Join"}
          </button>
        </div>
        {anonSignIn.modal}
      </header>
    );
  }

  const firstName = session?.user?.name?.split(" ")[0];

  return (
    <>
      {/* Header — three-element layout (Logo+Home | Event Links | Avatar+Preferences). */}
      <header
        className="sticky top-0 z-50 bg-surface/95 backdrop-blur-sm border-b border-secondary flex-shrink-0 block"
        data-testid="desktop-dashboard-header"
      >
        <div className="grid grid-cols-[auto_1fr_auto] items-center px-4 sm:px-6 py-3 gap-x-3 sm:gap-x-4">
          {/* Logo + Home (left) — active state when on /dashboard. */}
          <Link
            href="/dashboard"
            className={`relative flex items-center gap-2 rounded-lg px-2 py-1.5 transition ${
              isDashboard
                ? "bg-accent/15 ring-1 ring-accent/40 text-accent"
                : "text-secondary hover:bg-surface-secondary/60 hover:text-primary"
            }`}
            data-active={isDashboard ? "true" : undefined}
            title="AgentEnvoy — Home"
          >
            <LogoFull height={22} className={isDashboard ? "text-accent" : "text-primary"} />
            {isDashboard && (
              <span className="text-sm font-semibold">· Home</span>
            )}
            {isDashboard && (
              <span className="absolute left-2 right-2 -bottom-[13px] h-0.5 bg-accent rounded-full" />
            )}
          </Link>

          {/* Event Links tab (center). Links to /dashboard/event-links
              (Phase 2 PR 3). The `isEventLinks` matcher still accepts the
              legacy `/dashboard/meetings` route so deep links highlight.
              Cyan dot when one or more sessions are awaiting host
              acknowledgement. */}
          <div className="justify-self-center">
            <Link
              href="/dashboard/event-links"
              className={`relative flex items-center gap-2 rounded-lg px-3 py-1.5 transition ${
                isEventLinks
                  ? "bg-accent/15 ring-1 ring-accent/40 text-accent"
                  : "text-secondary hover:bg-surface-secondary/60 hover:text-primary"
              }`}
              data-active={isEventLinks ? "true" : undefined}
              data-testid="desktop-header-event-links"
              title="Event Links"
            >
              <svg
                className="w-4 h-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M10 13a5 5 0 0 0 7.07 0l1.41-1.41a5 5 0 0 0-7.07-7.07L10 6"
                />
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M14 11a5 5 0 0 0-7.07 0l-1.41 1.41a5 5 0 0 0 7.07 7.07L14 18"
                />
              </svg>
              <span className="text-sm font-medium">Event Links</span>
              {hasAwaitingAck && (
                <span
                  className="w-2 h-2 rounded-full bg-cyan-400"
                  aria-label="One or more events need your attention"
                  data-testid="desktop-header-awaiting-ack-dot"
                />
              )}
              {isEventLinks && (
                <span className="absolute left-3 right-3 -bottom-[13px] h-0.5 bg-accent rounded-full" />
              )}
            </Link>
          </div>

          {/* Avatar + name + Preferences (right) — active state on /dashboard/account. */}
          <Link
            href="/dashboard/account"
            className={`relative flex items-center gap-2 rounded-lg px-2 py-1 transition ${
              isAccount
                ? "bg-accent/15 ring-1 ring-accent/40 text-accent"
                : "text-secondary hover:bg-surface-secondary/60 hover:text-primary"
            }`}
            data-active={isAccount ? "true" : undefined}
            data-testid="desktop-header-account"
            title="Preferences"
          >
            {session?.user?.image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={session.user.image}
                alt=""
                className={`w-7 h-7 rounded-full ${isAccount ? "ring-2 ring-accent" : ""}`}
              />
            ) : (
              <div className={`w-7 h-7 rounded-full bg-gradient-to-br from-indigo-500 to-purple-500 flex items-center justify-center ${isAccount ? "ring-2 ring-accent" : ""}`}>
                <span className="text-[10px] font-bold text-white">
                  {session?.user?.name?.charAt(0)?.toUpperCase() || "?"}
                </span>
              </div>
            )}
            {firstName && (
              <span className="text-sm font-medium">{firstName}</span>
            )}
            {isAccount && (
              <span className="text-sm font-semibold">· Preferences</span>
            )}
            {isAccount && (
              <span className="absolute left-2 right-2 -bottom-[13px] h-0.5 bg-accent rounded-full" />
            )}
          </Link>
        </div>
      </header>
    </>
  );
}
