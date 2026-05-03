"use client";

import { useRouter } from "next/navigation";
import { useCallback } from "react";
import { useMobilePanels } from "../mobile/mobile-panels-context";
import { TARGET_MAP, type BubbleTarget } from "./targets";

// Matches Tailwind's `md` breakpoint (768px). Below this, the dashboard
// renders mobile chrome with slide-in drawers; at/above, full-page routes.
const MOBILE_QUERY = "(max-width: 767px)";

function isMobileViewport(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.matchMedia(MOBILE_QUERY).matches;
  } catch {
    return false;
  }
}

/**
 * Open a logical bubble destination on the right surface for the current
 * viewport — drawer on mobile when one exists, full-page route otherwise.
 *
 * Use this for any CTA in a contextual nudge (help bubble, banner, toast)
 * that points at a settings surface. Routing through here is what keeps
 * mobile users from getting stuck on a desktop page that has no close.
 */
export function useOpenTarget() {
  const router = useRouter();
  const { openPanel } = useMobilePanels();

  return useCallback(
    (target: BubbleTarget) => {
      const mapping = TARGET_MAP[target];
      if (mapping.mobilePanel && isMobileViewport()) {
        openPanel(mapping.mobilePanel);
        return;
      }
      router.push(mapping.route);
    },
    [router, openPanel],
  );
}
