-- Add hostNote column on NegotiationLink for host-supplied free-text framing
-- surfaced verbatim in the guest greeting as `💬 {hostFirstName}: {hostNote}`.
-- Sanitized via sanitizeHostFlavor at create_link time. Display-only —
-- excluded from computeInputHash. See proposal:
-- proposals/2026-04-18_dashboard-context-to-deal-room_*.md
ALTER TABLE "NegotiationLink"
  ADD COLUMN "hostNote" VARCHAR(280);
