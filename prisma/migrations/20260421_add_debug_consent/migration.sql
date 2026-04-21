-- F4: Beta-cohort debug consent flag on User.
-- Additive: three nullable/defaulted columns, no changes to existing rows' semantics.

ALTER TABLE "User"
  ADD COLUMN "debugConsent" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "debugConsentAt" TIMESTAMP(3),
  ADD COLUMN "debugConsentRevokedAt" TIMESTAMP(3);
