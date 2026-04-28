"use client";

/**
 * Mobile Availability drawer — slide-down from the topbar calendar icon.
 *
 * Mirrors the `PreferencesDrawer` chrome (top-2/left-2/right-2/bottom-2 panel,
 * X close button, overlay tap-to-dismiss) so both right- and left-rail entries
 * feel like the same primitive. Body is the existing `<AvailabilityPanel
 * forceMobile />` — the same component the standalone `/dashboard/availability`
 * route already renders on mobile, so there's no behavior fork between the
 * drawer and the route.
 *
 * The drawer is the new primary mobile entry point. The route still exists as
 * a fallback for direct URLs (e.g. the "Availability" link inside the
 * Preferences drawer). Both paths are wired to the same component so they
 * stay in sync.
 */

import { useEffect, useState } from "react";
import { AvailabilityPanel } from "@/components/availability-panel";

interface AvailabilityDrawerProps {
  open: boolean;
  onClose: () => void;
}

export function AvailabilityDrawer({ open, onClose }: AvailabilityDrawerProps) {
  // Defer rendering the panel until first open so an unopened drawer doesn't
  // ship the AvailabilityPanel's mount-time fetches into the page. Once
  // mounted, it stays — animation is CSS-driven on `open`.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    if (open) setMounted(true);
  }, [open]);

  if (!mounted) return null;

  return (
    <div
      className={`fixed inset-0 z-[60] md:hidden transition-opacity duration-200 ${
        open ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
      }`}
      aria-hidden={!open}
      data-testid="mobile-availability-drawer"
    >
      {/* Overlay — tap to close */}
      <button
        type="button"
        onClick={onClose}
        className="absolute inset-0 bg-black/55"
        aria-label="Close Availability"
        tabIndex={open ? 0 : -1}
      />

      {/* Drawer panel — slides down from the top, same chrome as Preferences. */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="mobile-avail-title"
        className={`absolute top-2 left-2 right-2 bottom-2 bg-surface border border-secondary rounded-[18px] flex flex-col overflow-hidden shadow-2xl transition-transform duration-300 ease-out ${
          open ? "translate-y-0" : "-translate-y-4"
        }`}
      >
        {/* Header */}
        <div className="px-4 py-3.5 border-b border-secondary flex items-center justify-between flex-shrink-0">
          <h3 id="mobile-avail-title" className="text-lg font-semibold text-primary tracking-tight">
            Availability
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="w-7 h-7 rounded-full bg-surface-secondary/80 flex items-center justify-center text-secondary hover:text-primary"
            aria-label="Close"
            data-testid="mobile-avail-close"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body — AvailabilityPanel manages its own scrolling, week nav, and
            modals. Wrap it in a flex column so its internal flex-1 sizing
            works against the drawer panel's bounded height. */}
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
          <AvailabilityPanel forceMobile />
        </div>
      </div>
    </div>
  );
}
