-- Rename NegotiationLink.sourceRuleId -> recurringWindowId.
-- Office Hours generalization: the column now describes "the recurring window
-- this link is bound to" rather than a special-cased AvailabilityRule pointer.
-- Semantics-preserving — no data loss. Use RENAME COLUMN (not DROP+ADD).
ALTER TABLE "NegotiationLink" RENAME COLUMN "sourceRuleId" TO "recurringWindowId";
