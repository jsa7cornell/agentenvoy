/**
 * Logical destinations a help bubble (or any contextual CTA) can request.
 *
 * Several settings surfaces live in two places: a full-page route on desktop
 * and a slide-in drawer on mobile (see `MobilePanelsProvider`). Hard-coding
 * a route in a CTA dumps mobile users on the desktop page with no way back.
 * Bubbles instead declare a logical target; `useOpenTarget` picks the right
 * surface for the viewport.
 *
 * To add a new target: extend `BubbleTarget`, add an entry below, and any
 * existing bubble can point at it. If the target has no mobile drawer
 * counterpart, omit `mobilePanel` and the resolver will navigate on both
 * surfaces.
 */

import type { MobilePanelName } from "../mobile/mobile-panels-context";

export type BubbleTarget =
  | "preferences"
  | "availability"
  | "eventLinks"
  | "connectors";

export interface TargetMapping {
  route: string;
  mobilePanel?: MobilePanelName;
}

export const TARGET_MAP: Record<BubbleTarget, TargetMapping> = {
  preferences: { route: "/dashboard/account", mobilePanel: "preferences" },
  availability: { route: "/dashboard/availability", mobilePanel: "availability" },
  eventLinks: { route: "/dashboard/event-links", mobilePanel: "eventLinks" },
  connectors: { route: "/dashboard/account/connectors" },
};
