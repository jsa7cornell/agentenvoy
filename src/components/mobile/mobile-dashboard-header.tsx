"use client";

/**
 * Mobile dashboard chrome — v2.
 *
 * Three-element topbar (avatar | "Event Links" header pill | calendar icon).
 * Each button calls `openPanel(...)` on the shared `MobilePanelsProvider`,
 * which owns the slide-in drawers and renders them once at the layout level.
 * Hosting state in the provider lets contextual nudges (help bubbles, deep-
 * link CTAs) open the same panels without owning their own drawer copy.
 *
 * Sheets:
 * - Avatar (left)         → slide-down Preferences drawer.
 * - Header pill (center)  → slide-up Event Links sheet.
 * - Calendar icon (right) → slide-down Availability drawer (same chrome as
 *   Preferences). The legacy `/dashboard/availability` route still exists for
 *   direct URL access and renders the same `<AvailabilityPanel>` underneath.
 *
 * Lives only at the mobile breakpoint — `dashboard-header.tsx` decides which
 * branch to render based on `md:` so desktop chrome is untouched (Phase 2
 * owns the desktop rebuild). See `SPEC.md`
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
import type { Session } from "next-auth";
import { useMobilePanels } from "./mobile-panels-context";

interface MobileDashboardHeaderProps {
  session: Session;
}

const BADGE_COUNTS_REVALIDATE_MS = 30_000;

export function MobileDashboardHeader({ session }: MobileDashboardHeaderProps) {
  const { openName, openPanel } = useMobilePanels();
  const [awaitingAck, setAwaitingAck] = useState(0);

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

  const initial =
    session.user?.name?.charAt(0)?.toUpperCase() ||
    session.user?.email?.charAt(0)?.toUpperCase() ||
    "?";

  return (
    <header
      className="sticky top-0 z-50 bg-surface/95 backdrop-blur-sm border-b border-secondary flex-shrink-0 flex md:hidden"
      data-testid="mobile-dashboard-header"
    >
      <div className="grid grid-cols-[1fr_auto_1fr] items-center w-full px-3 py-2.5 gap-2">
        {/* Avatar — left → Preferences drawer */}
        <div className="justify-self-start">
          <button
            type="button"
            onClick={() => openPanel("preferences")}
            className="w-9 h-9 rounded-full bg-gradient-to-br from-indigo-500 to-purple-500 flex items-center justify-center"
            title="Preferences"
            aria-label="Open Preferences"
            aria-haspopup="dialog"
            aria-expanded={openName === "preferences"}
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
            onClick={() => openPanel("eventLinks")}
            className="relative inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full bg-surface-secondary/60 border border-secondary text-primary text-xs font-medium hover:border-accent/50 transition"
            title="Links & Events"
            aria-label="Open Links and Events"
            aria-haspopup="dialog"
            aria-expanded={openName === "eventLinks"}
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
            <span>Links &amp; Events</span>
            {hasAwaitingAck && (
              <span
                className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-accent3 ring-2 ring-surface"
                aria-label="One or more events need your attention"
                data-testid="mobile-header-awaiting-ack-dot"
              />
            )}
          </button>
        </div>

        {/* Right slot — calendar icon → slide-down Availability drawer. Same
            chrome primitive as the Preferences drawer. */}
        <div className="justify-self-end">
          <button
            type="button"
            onClick={() => openPanel("availability")}
            className="w-9 h-9 rounded-full bg-surface-secondary/60 border border-secondary flex items-center justify-center text-secondary hover:text-primary hover:border-accent/50 transition"
            title="Availability"
            aria-label="Open Availability"
            aria-haspopup="dialog"
            aria-expanded={openName === "availability"}
            data-testid="mobile-header-availability"
          >
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
          </button>
        </div>
      </div>
    </header>
  );
}
