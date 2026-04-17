-- Task 1 (guest flow redesign): add guestName column to NegotiationSession.
-- Session-scoped so a single generic link can host many named guests without
-- overwriting the link's inviteeName. Used by the new confirm card's name
-- field + the top event card after confirm.
ALTER TABLE "NegotiationSession"
  ADD COLUMN IF NOT EXISTS "guestName" TEXT;
