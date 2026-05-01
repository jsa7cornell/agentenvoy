"use client";

import { useState, useEffect } from "react";
import { useSession } from "next-auth/react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { LogoFull } from "./logo";
import { MobileDashboardHeader } from "./mobile/mobile-dashboard-header";
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
 * **Responsive split.** At and above the `md:` breakpoint the signed-in viewer
 * sees the v2 desktop chrome below — three-element layout (Logo+Home left |
 * Event Links tab center | Avatar+Preferences right). Below `md:` we render
 * `<MobileDashboardHeader>` instead — the v2 three-element topbar (avatar |
 * "Event Links" header pill | calendar icon). The anonymous branch is
 * unchanged in either mode. See `SPEC.md`
 * §3.1 and `mockups/desktop-v2.html` for the visual contract.
 *
 * Cyan dot on the Event Links tab indicates one or more sessions are in
 * `awaiting_ack_self` state (same `/api/dashboard/badge-counts` aggregator
 * used by mobile, revalidating every 30s). Decorative — fetch failures render
 * nothing.
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

  // Copy feedback for the standard-link pill. Mirrors the pattern in
  // `my-links-popover.tsx` — flag flips for 1.5s, then resets.
  const [copied, setCopied] = useState(false);
  const meetSlug = session?.user?.meetSlug ?? null;
  const standardUrl = meetSlug ? `agentenvoy.ai/meet/${meetSlug}` : null;
  function copyStandardLink() {
    if (!standardUrl) return;
    navigator.clipboard?.writeText(`https://${standardUrl}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

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
      {/* Mobile chrome (below `md:`) — three-element topbar. */}
      <MobileDashboardHeader session={session!} />

      {/* Desktop chrome (`md:` and up) — v2 three-element layout. */}
      <header
        className="sticky top-0 z-50 bg-surface/95 backdrop-blur-sm border-b border-secondary flex-shrink-0 hidden md:block"
        data-testid="desktop-dashboard-header"
      >
        <div className="grid grid-cols-[auto_1fr_auto] items-center px-6 py-3 gap-x-4">
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

          {/* Standard-link pill (center) — three segments separated by
              vertical dividers:
                · URL button (click copies)
                · Copy icon button (click copies)
                · "Edit my links and events" → /dashboard/event-links
              The `isEventLinks` matcher still accepts the legacy
              `/dashboard/meetings` route so deep links highlight on the
              edit segment. Cyan dot rides on the edit segment when one or
              more sessions are awaiting host acknowledgement. */}
          <div className="justify-self-center">
            {standardUrl ? (
              <div
                className="relative inline-flex items-center bg-surface-secondary/60 border border-secondary rounded-lg overflow-hidden"
                data-testid="desktop-header-standard-link-pill"
              >
                <button
                  type="button"
                  onClick={copyStandardLink}
                  className="flex items-center gap-2 px-3 py-1.5 text-secondary hover:bg-surface-secondary/90 hover:text-primary transition"
                  title={copied ? "Copied!" : "Click to copy"}
                  aria-label="Copy standard link"
                  data-testid="desktop-header-standard-link-url"
                >
                  <svg
                    className="w-4 h-4 text-accent flex-shrink-0"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M10 13a5 5 0 0 0 7.07 0l1.41-1.41a5 5 0 0 0-7.07-7.07L10 6" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M14 11a5 5 0 0 0-7.07 0l-1.41 1.41a5 5 0 0 0 7.07 7.07L14 18" />
                  </svg>
                  <span className="text-[13px] font-mono tracking-tight">
                    <span className="text-tertiary">agentenvoy.ai/meet/</span>
                    <span className="text-primary font-medium">{meetSlug}</span>
                  </span>
                </button>
                <div className="w-px h-5 bg-secondary" aria-hidden />
                <button
                  type="button"
                  onClick={copyStandardLink}
                  className={`flex items-center justify-center h-8 px-2.5 transition ${
                    copied
                      ? "text-emerald-400"
                      : "text-tertiary hover:bg-surface-secondary/90 hover:text-primary"
                  }`}
                  title={copied ? "Copied!" : "Copy link"}
                  aria-label="Copy standard link"
                  data-testid="desktop-header-standard-link-copy"
                >
                  {copied ? (
                    <span className="text-[12px] font-medium">Copied!</span>
                  ) : (
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <rect x="9" y="9" width="13" height="13" rx="2" />
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                    </svg>
                  )}
                </button>
                <div className="w-px h-5 bg-secondary" aria-hidden />
                <Link
                  href="/dashboard/event-links"
                  className={`relative flex items-center gap-1.5 px-3 py-1.5 text-[13px] font-medium transition ${
                    isEventLinks
                      ? "text-accent bg-accent/15"
                      : "text-accent hover:bg-surface-secondary/90"
                  }`}
                  data-active={isEventLinks ? "true" : undefined}
                  data-testid="desktop-header-event-links"
                  title="Edit my links and events"
                >
                  <span>Edit my links and events</span>
                  {hasAwaitingAck && (
                    <span
                      className="w-2 h-2 rounded-full bg-cyan-400"
                      aria-label="One or more events need your attention"
                      data-testid="desktop-header-awaiting-ack-dot"
                    />
                  )}
                  {isEventLinks && (
                    <span className="absolute left-3 right-3 -bottom-[10px] h-0.5 bg-accent rounded-full" />
                  )}
                </Link>
              </div>
            ) : (
              // Fallback for users without a meetSlug (rare — auth.ts seeds
              // one on first sign-in). Keep the edit affordance only.
              <Link
                href="/dashboard/event-links"
                className={`relative flex items-center gap-2 rounded-lg px-3 py-1.5 transition ${
                  isEventLinks
                    ? "bg-accent/15 ring-1 ring-accent/40 text-accent"
                    : "text-secondary hover:bg-surface-secondary/60 hover:text-primary"
                }`}
                data-active={isEventLinks ? "true" : undefined}
                data-testid="desktop-header-event-links"
                title="Edit my links and events"
              >
                <span className="text-sm font-medium">Edit my links and events</span>
                {hasAwaitingAck && (
                  <span
                    className="w-2 h-2 rounded-full bg-cyan-400"
                    aria-label="One or more events need your attention"
                    data-testid="desktop-header-awaiting-ack-dot"
                  />
                )}
              </Link>
            )}
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
