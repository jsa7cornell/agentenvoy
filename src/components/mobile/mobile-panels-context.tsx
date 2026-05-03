"use client";

/**
 * Shared opener for the mobile slide-in panels (Preferences, Event Links,
 * Availability). State and the panels themselves live here, in the dashboard
 * layout, so any descendant — chat bubbles, deep-link CTAs, future
 * notifications — can request a panel by name without owning a drawer.
 *
 * Before: panel state lived inside `MobileDashboardHeader`; only the avatar
 * could open Preferences. The dark-mode help bubble had to hard-link to
 * `/dashboard/account`, which on mobile dropped the user on the desktop
 * full-page Preferences with no escape (see `useOpenTarget`).
 *
 * The desktop/anonymous chrome doesn't render any drawers — `useMobilePanels`
 * returns a no-op when called outside the provider, so callers don't need
 * to branch on auth state.
 */

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { PreferencesDrawer } from "./preferences-drawer";
import { EventLinksSheet } from "./event-links-sheet";
import { AvailabilityDrawer } from "./availability-drawer";

export type MobilePanelName = "preferences" | "eventLinks" | "availability";

interface MobilePanelsContextValue {
  openName: MobilePanelName | null;
  openPanel: (name: MobilePanelName) => void;
  closeAll: () => void;
}

const NOOP_VALUE: MobilePanelsContextValue = {
  openName: null,
  openPanel: () => {},
  closeAll: () => {},
};

const MobilePanelsContext = createContext<MobilePanelsContextValue | null>(null);

export function useMobilePanels(): MobilePanelsContextValue {
  const ctx = useContext(MobilePanelsContext);
  return ctx ?? NOOP_VALUE;
}

export function MobilePanelsProvider({ children }: { children: React.ReactNode }) {
  const { data: session } = useSession();
  const [openName, setOpenName] = useState<MobilePanelName | null>(null);

  const openPanel = useCallback((name: MobilePanelName) => setOpenName(name), []);
  const closeAll = useCallback(() => setOpenName(null), []);

  // Body scroll lock + Escape — global so any opener (header, bubble, future
  // CTA) inherits the same chrome.
  useEffect(() => {
    if (openName === null) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [openName]);

  useEffect(() => {
    if (openName === null) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpenName(null);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [openName]);

  return (
    <MobilePanelsContext.Provider value={{ openName, openPanel, closeAll }}>
      {children}
      {session && (
        <>
          <PreferencesDrawer
            open={openName === "preferences"}
            onClose={closeAll}
            session={session}
          />
          <EventLinksSheet open={openName === "eventLinks"} onClose={closeAll} />
          <AvailabilityDrawer open={openName === "availability"} onClose={closeAll} />
        </>
      )}
    </MobilePanelsContext.Provider>
  );
}
