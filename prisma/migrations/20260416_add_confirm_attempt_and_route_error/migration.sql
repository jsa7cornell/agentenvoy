-- Audit trail for every /api/negotiate/confirm attempt, regardless of
-- outcome. Survives log rotation and function timeouts. Writes are
-- fire-and-forget from the route so they don't add latency to the user
-- response. Readable at /admin/failures.
CREATE TABLE "ConfirmAttempt" (
  "id" TEXT NOT NULL,
  "sessionId" TEXT,
  "slotStart" TIMESTAMP(3),
  "slotEnd" TIMESTAMP(3),
  -- success | already_agreed | slot_mismatch | gcal_failed | server_error | validation_failed
  "outcome" TEXT NOT NULL,
  "errorMessage" TEXT,
  "userAgent" TEXT,
  "durationMs" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ConfirmAttempt_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ConfirmAttempt_sessionId_createdAt_idx"
  ON "ConfirmAttempt"("sessionId", "createdAt");
CREATE INDEX "ConfirmAttempt_outcome_createdAt_idx"
  ON "ConfirmAttempt"("outcome", "createdAt");

-- Generic route-error audit trail. Any API route can call logRouteError()
-- to persist a server-side error here. Captures the route, error class,
-- message, stack (truncated), and optional structured context.
-- Shown on /admin/failures alongside ConfirmAttempt + SideEffectLog.failed.
CREATE TABLE "RouteError" (
  "id" TEXT NOT NULL,
  "route" TEXT NOT NULL,
  "method" TEXT,
  "statusCode" INTEGER,
  "errorClass" TEXT,
  "message" TEXT NOT NULL,
  "stack" TEXT,
  "contextJson" JSONB,
  "userId" TEXT,
  "userAgent" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RouteError_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RouteError_route_createdAt_idx"
  ON "RouteError"("route", "createdAt");
CREATE INDEX "RouteError_createdAt_idx"
  ON "RouteError"("createdAt");
