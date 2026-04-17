-- Migration: partial expression index on SideEffectLog for the idempotency gate.
-- Run in Supabase Dashboard → SQL Editor → New query.
--
-- `hasDispatchedFor({ kind, userId, purpose })` queries:
--   SELECT id FROM "SideEffectLog"
--     WHERE kind = $1
--       AND status IN ('sent','suppressed','dryrun','failed')
--       AND "contextJson"->>'userId' = $2
--       AND "contextJson"->>'purpose' = $3
-- This partial expression index matches the query shape exactly so the lookup
-- stays O(log n) as the log grows.
--
-- Additive + idempotent. No data written.

CREATE INDEX IF NOT EXISTS "SideEffectLog_kind_user_purpose_idx"
  ON "SideEffectLog" (kind, (("contextJson"->>'userId')), (("contextJson"->>'purpose')))
  WHERE status IN ('sent', 'suppressed', 'dryrun', 'failed');
