-- Guest TZ UX: viewerTimezone on NegotiationSession.
-- Picker-authoritative viewer tz for deal-room card + Envoy follow-up chat.
-- Additive, nullable. No backfill needed — writes on first card render.

ALTER TABLE "NegotiationSession"
  ADD COLUMN "viewerTimezone" TEXT;
