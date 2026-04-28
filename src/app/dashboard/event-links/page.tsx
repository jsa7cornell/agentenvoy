/**
 * Event Links — desktop full-page view.
 *
 * Phase 2 PR 3: mirrors the mobile sheet's two-group structure (Reusable
 * links + Upcoming events) at desktop width. Reuses the same data sources
 * (`/api/tuner/preferences` + `/api/negotiate/sessions?archived=false`) and
 * the same `event-links-buckets.ts` classifier the sheet uses.
 *
 * Visual contract: `mockups/desktop-v2.html` §5
 * (`.links-body` — single-column 1fr grid, two stacked groups, max-width
 * 1120px, padding 32/48). Mobile users continue to see the slide-up sheet
 * via the topbar; desktop users land on this route.
 *
 * Header href update (`dashboard-header.tsx`) flips the desktop "Event
 * Links" tab from `/dashboard/meetings` → `/dashboard/event-links`. The
 * v1 meetings route remains in place — `isEventLinks` matches both paths
 * so deep links still highlight correctly.
 */

import { EventLinksPageContent } from "@/components/desktop/event-links-page-content";

export const metadata = {
  title: "Event Links — AgentEnvoy",
};

export default function EventLinksPage() {
  return <EventLinksPageContent />;
}
