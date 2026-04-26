"use client";

/**
 * Mobile Preferences drawer — slide-down from the topbar avatar.
 *
 * **Thin shell for PR 3.** Body redesign lands in PR 6 (Preferences page —
 * field-for-field with the current Account-page order, see
 * `refactor-package-2026-04-25/PROJECT-PLAN.md` Phase 1 PR 6). For now each
 * section header is a deep link into the existing `/dashboard/account` page
 * with a `#section-id` hash, so users still reach every preference even
 * before the redesigned form ships.
 *
 * Animation primitive: pure CSS transform driven by an `open` prop. No
 * dependency added (the codebase has no Radix Dialog or similar) — the brief
 * §7.4 explicitly requires this.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import type { Session } from "next-auth";

interface PreferencesDrawerProps {
  open: boolean;
  onClose: () => void;
  session: Session;
}

/** Sections deep-linked from the drawer until PR 6 redesigns the body.
 *  Hash anchors point at the current `/dashboard/account` page. */
const PREF_SECTIONS = [
  { id: "identity", label: "Identity" },
  { id: "google-calendar", label: "Google Calendar" },
  { id: "other-agents", label: "Other Agents" },
  { id: "location", label: "Location preferences" },
  { id: "meeting", label: "Meeting preferences" },
  { id: "appearance", label: "Appearance" },
  { id: "privacy", label: "Privacy" },
] as const;

export function PreferencesDrawer({ open, onClose, session }: PreferencesDrawerProps) {
  // Defer rendering the panel until first open so an unopened drawer doesn't
  // ship empty markup into the DOM. Once mounted, it stays — animation is
  // CSS-driven on `open`.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    if (open) setMounted(true);
  }, [open]);

  if (!mounted) return null;

  const initial =
    session.user?.name?.charAt(0)?.toUpperCase() ||
    session.user?.email?.charAt(0)?.toUpperCase() ||
    "?";

  return (
    <div
      className={`fixed inset-0 z-[60] md:hidden transition-opacity duration-200 ${
        open ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
      }`}
      aria-hidden={!open}
      data-testid="mobile-preferences-drawer"
    >
      {/* Overlay — tap to close */}
      <button
        type="button"
        onClick={onClose}
        className="absolute inset-0 bg-black/55"
        aria-label="Close Preferences"
        tabIndex={open ? 0 : -1}
      />

      {/* Drawer panel — slides down from the top. `top-2` matches the mobile
          mockup's 8px margin so the user still sees a sliver of the topbar. */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="mobile-prefs-title"
        className={`absolute top-2 left-2 right-2 bottom-2 bg-surface border border-secondary rounded-[18px] overflow-y-auto shadow-2xl transition-transform duration-300 ease-out ${
          open ? "translate-y-0" : "-translate-y-4"
        }`}
      >
        {/* Header */}
        <div className="px-4 py-3.5 border-b border-secondary flex items-center justify-between">
          <h3 id="mobile-prefs-title" className="text-lg font-semibold text-primary tracking-tight">
            Preferences
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="w-7 h-7 rounded-full bg-surface-secondary/80 flex items-center justify-center text-secondary hover:text-primary"
            aria-label="Close"
            data-testid="mobile-prefs-close"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Identity row — avatar + name + email */}
        <div className="px-4 py-4 border-b border-secondary/60 flex items-center gap-3">
          <div className="w-12 h-12 rounded-full bg-gradient-to-br from-indigo-500 to-purple-500 flex items-center justify-center flex-shrink-0">
            {session.user?.image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={session.user.image} alt="" className="w-12 h-12 rounded-full" />
            ) : (
              <span className="text-sm font-semibold text-white">{initial}</span>
            )}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-primary truncate">
              {session.user?.name || "Signed in"}
            </div>
            <div className="text-[11px] text-muted truncate">{session.user?.email}</div>
          </div>
        </div>

        {/* Section list — each item is a deep link to /dashboard/account#anchor.
            PR 6 replaces the body of this drawer with the redesigned inline form. */}
        <nav className="px-3 py-3 flex flex-col gap-1.5" aria-label="Preference sections">
          {PREF_SECTIONS.map((section) => (
            <Link
              key={section.id}
              href={`/dashboard/account#${section.id}`}
              onClick={onClose}
              className="px-3 py-3 rounded-xl bg-surface-secondary/60 border border-secondary text-sm text-primary hover:border-accent/40 transition flex items-center justify-between"
              data-testid={`mobile-prefs-section-${section.id}`}
            >
              <span>{section.label}</span>
              <span aria-hidden className="text-muted">›</span>
            </Link>
          ))}
        </nav>
      </div>
    </div>
  );
}
