-- AlterTable: NegotiationSession — add gcalHtmlLink to store the canonical
-- Google Calendar event URL returned by the GCal API at insert/patch time.
-- Nullable so existing confirmed sessions (confirmed before this column shipped)
-- keep working via the googleCalendarEventUrl() fallback.
ALTER TABLE "NegotiationSession" ADD COLUMN "gcalHtmlLink" TEXT;
