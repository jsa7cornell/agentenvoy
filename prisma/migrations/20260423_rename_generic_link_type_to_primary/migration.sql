-- Rename NegotiationLink.type value "generic" -> "primary" to align with
-- user-facing vocabulary. The column is a free-text string with no FK/enum
-- constraint, so this is a straight UPDATE. Also update the column default
-- so newly inserted rows without an explicit type use "primary".

-- Flip existing rows.
UPDATE "NegotiationLink" SET "type" = 'primary' WHERE "type" = 'generic';

-- Keep the column default in sync with schema.prisma.
ALTER TABLE "NegotiationLink" ALTER COLUMN "type" SET DEFAULT 'primary';
