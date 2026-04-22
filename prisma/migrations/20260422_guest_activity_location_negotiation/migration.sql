-- Guest activity + location negotiation (2026-04-22)
-- Proposal: 2026-04-22_guest-activity-location-negotiation_reviewed-2026-04-22.md
-- Additive nullable columns — safe to run before code deploys.
ALTER TABLE "NegotiationSession" ADD COLUMN "negotiatedActivity" TEXT;
ALTER TABLE "NegotiationSession" ADD COLUMN "negotiatedLocation" TEXT;
ALTER TABLE "NegotiationSession" ADD COLUMN "negotiatedFormat"   TEXT;
ALTER TABLE "NegotiationSession" ADD COLUMN "negotiatedLockedBy" TEXT;
