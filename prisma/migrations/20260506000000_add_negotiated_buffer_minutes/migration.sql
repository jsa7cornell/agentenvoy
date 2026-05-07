-- AddColumn: negotiatedBufferMinutes to NegotiationSession
-- PR-C 2026-05-06 — lock_buffer_minutes agent action symmetry with negotiatedDuration.
-- See proposal 2026-05-06_link-config-canonical-model-and-unified-edit §10 Item 13.
ALTER TABLE "NegotiationSession" ADD COLUMN "negotiatedBufferMinutes" INTEGER;
