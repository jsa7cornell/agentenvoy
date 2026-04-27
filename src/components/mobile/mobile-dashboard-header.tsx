"use client";

/**
 * Mobile dashboard chrome — v2.
 *
 * Three-element topbar (avatar | "Event Links" header pill | calendar icon)
 * paired with two slide-style sheets:
 *
 * - Avatar (left) → slide-down Preferences drawer (this PR ships a thin shell).
 * - Header pill (center) → slide-up Event Links sheet (this PR ships a thin
 *   shell with the existing my-link list + an "Upcoming events" hand-off).
 * - Calendar icon (right) → routes to `/dashboard/availability`, the
 *   already-mobile-friendly Availability surface.
 *
 * Lives only at the mobile breakpoint — `dashboard-header.tsx` decides which
 * branch to render based on `md:` so desktop chrome is untouched (Phase 2
 * owns the desktop rebuild). See `refactor-package-2026-04-25/SPEC-2.0.md`
 * §3.1 and `mockups/mobile-v2.html` §3 for the visual contract.
 *
 * Cyan dot on the header pill indicates that one or more sessions are in
 * `awaiting_ack_self` state. Backed by `/api/dashboard/badge-counts`, which
 * counts unread notifications of kind `awaiting_ack_self` for the signed-in
 * user. The component self-fetches on mount and revalidates every 30s; the
 * dot is decorative, so fetch failures render nothing rather than surfacing
 * an error. The notification bell / center in `WISHLIST.md
 * notification-bell-and-center` will share this aggregator when it lands.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { Session } from "next-auth";
import { PreferencesDrawer } from "./preferences-drawer";
import { EventLinksSheet } from "./event-links-sheet";

interface MobileDashboardHeaderProps {
  session: Session;
}

const BADGE_COUNTS_REVALIDATE_MS = 30_000;

export function MobileDashboardHeader({ session }: MobileDashboardHeaderProps) {
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [linksOpen, setLinksOpen] = useState(false);
  const [awaitingAck, setAwaitingAck] = useState(0);
  const pathname = usePathname();
  const onAvailability = pathname?.startsWith("/dashboard/availability") ?? false;

  // Fetch the cyan-dot count on mount and revalidate every 30s. Defensive: a
  // fetch failure keeps the previous value (initially 0 → no dot), since the
  // dot is decorative and the underlying data is informational. The cleanup
  // both clears the interval and aborts an in-flight fetch on unmount.
  useEffect(() => {
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
  }, []);

  const hasAwaitingAck = awaitingAck > 0;

  // Lock body scroll while either sheet is open. Mobile sheets cover the
  // viewport; without this the underlying page scrolls when users drag on
  // the overlay.
  useEffect(() => {
    if (!prefsOpen && !linksOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [prefsOpen, linksOpen]);

  // Close the open sheet on Escape — keyboard parity with the desktop popover.
  useEffect(() => {
    if (!prefsOpen && !linksOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      setPrefsOpen(false);
      setLinksOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [prefsOpen, linksOpen]);

  const initial =
    session.user?.name?.charAt(0)?.toUpperCase() ||
    session.user?.email?.charAt(0)?.toUpperCase() ||
    "?";

  // The header sets `backdrop-filter: blur(...)` for its scroll halo. Per the
  // CSS spec, a non-`none` backdrop-filter creates a containing block for any
  // `position: fixed` descendant — which would clip the drawer/sheet to the
  // header's box (~56px tall) instead of the viewport. Render the drawer and
  // sheet as siblings of <header>, not children, so they escape the trap.
  return (
    <>
    <header
      className="sticky top-0 z-50 bg-surface/95 backdrop-blur-sm border-b border-secondary flex-shrink-0 flex md:hidden"
      data-testid="mobile-dashboard-header"
    >
      <div className="grid grid-cols-[1fr_auto_1fr] items-center w-full px-3 py-2.5 gap-2">
        {/* Avatar — left → Preferences drawer */}
        <div className="justify-self-start">
          <button
            type="button"
            onClick={() => setPrefsOpen(true)}
            className="w-9 h-9 rounded-full bg-gradient-to-br from-indigo-500 to-purple-500 flex items-center justify-center"
            title="Preferences"
            aria-label="Open Preferences"
            aria-haspopup="dialog"
            aria-expanded={prefsOpen}
            data-testid="mobile-header-avatar"
          >
            {session.user?.image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={session.user.image}
                alt=""
                className="w-9 h-9 rounded-full"
              />
            ) : (
              <span className="text-[11px] font-semibold text-white">
                {initial}
              </span>
            )}
          </button>
        </div>

        {/* Event Links pill — center → slide-up sheet. The `awaiting_ack_self`
            cyan dot rides on this center element per PROJECT-PLAN — Phase 1
            checklist "Cyan dot on header pill". The mockup occasionally
            decorates the topbar-right icon; the spec wins. */}
        <div className="justify-self-center">
          <button
            type="button"
            onClick={() => setLinksOpen(true)}
            className="relative inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full bg-surface-secondary/60 border border-secondary text-primary text-xs font-medium hover:border-accent/50 transition"
            title="Event Links"
            aria-label="Open Event Links"
            aria-haspopup="dialog"
            aria-expanded={linksOpen}
            data-testid="mobile-header-event-links"
          >
            <svg
              className="w-3.5 h-3.5 text-accent"
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
            <span>Event Links</span>
            {hasAwaitingAck && (
              <span
                className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-accent3 ring-2 ring-surface"
                aria-label="One or more events need your attention"
                data-testid="mobile-header-awaiting-ack-dot"
              />
            )}
          </button>
        </div>

        {/* Right slot — context-sensitive:
            - On /dashboard chat: calendar icon → /dashboard/availability.
            - On /dashboard/availability: close (×) → /dashboard so leaving
              the surface feels like dismissing a panel rather than navigating. */}
        <div className="justify-self-end">
          <Link
            href={onAvailability ? "/dashboard" : "/dashboard/availability"}
            className="w-9 h-9 rounded-full bg-surface-secondary/60 border border-secondary flex items-center justify-center text-secondary hover:text-primary hover:border-accent/50 transition"
            title={onAvailability ? "Close" : "Availability"}
            aria-label={onAvailability ? "Close Availability" : "Go to Availability"}
            data-testid={onAvailability ? "mobile-header-close-availability" : "mobile-header-availability"}
          >
            {onAvailability ? (
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
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            ) : (
              <svg
                className="w-4 h-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.8}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5"
                />
              </svg>
            )}
          </Link>
        </div>
      </div>

    </header>
    <PreferencesDrawer
      open={prefsOpen}
      onClose={() => setPrefsOpen(false)}
      session={session}
    />
    <EventLinksSheet
      open={linksOpen}
      onClose={() => setLinksOpen(false)}
    />
    </>
  );
}
