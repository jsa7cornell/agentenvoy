import { NextResponse, type NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

// NegotiatorResult has no userId (shareCode-keyed, anonymous by design) — not touched.
// ConfirmAttempt has no userId and is session-scoped; orphan rows remain as audit history without PII.

function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return false;
  try {
    const url = new URL(origin);
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return true;
    const appUrl = process.env.NEXTAUTH_URL;
    if (appUrl) {
      const appHost = new URL(appUrl).hostname;
      if (url.hostname === appHost) return true;
    }
    return false;
  } catch {
    return false;
  }
}

export async function POST(request: NextRequest) {
  // CSRF: same-origin only. NextAuth's built-in CSRF covers /api/auth/*;
  // custom session-gated destructive endpoints need their own check.
  const origin = request.headers.get("origin");
  if (!isAllowedOrigin(origin)) {
    return NextResponse.json({ ok: false, error: "Invalid origin" }, { status: 403 });
  }

  const session = await getServerSession(authOptions);
  if (!session?.user?.id || !session.user.email) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;
  const userEmail = session.user.email;

  let body: { confirmEmail?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid body" }, { status: 400 });
  }
  const confirmEmail = typeof body.confirmEmail === "string" ? body.confirmEmail.trim().toLowerCase() : "";
  if (!confirmEmail || confirmEmail !== userEmail.trim().toLowerCase()) {
    return NextResponse.json({ ok: false, error: "Email does not match" }, { status: 400 });
  }

  // Stash refresh tokens BEFORE deletion so we can revoke after the tx.
  const accounts = await prisma.account.findMany({
    where: { userId, provider: "google" },
    select: { refresh_token: true, access_token: true },
  });
  const tokensToRevoke: string[] = [];
  for (const a of accounts) {
    if (a.refresh_token) tokensToRevoke.push(a.refresh_token);
    if (a.access_token) tokensToRevoke.push(a.access_token);
  }

  try {
    // Main destructive transaction. Most tables cascade from User or NegotiationLink.
    // Pre-null optional FKs from other users' rows that reference this user:
    //   - NegotiationSession.guestId (this user as guest on someone else's session)
    //   - SessionParticipant.userId (this user as participant on someone else's link)
    await prisma.$transaction([
      prisma.negotiationSession.updateMany({
        where: { guestId: userId },
        data: { guestId: null },
      }),
      prisma.sessionParticipant.updateMany({
        where: { userId },
        data: { userId: null },
      }),
      // Group-mode edge case: a session can have hostId = target while its
      // NegotiationLink belongs to another user. `hostId` has no onDelete
      // and is non-nullable, so we hard-delete those rows before the User
      // delete to avoid a NO ACTION FK failure. Sessions hosted on the
      // target's own links get cleaned up via the link cascade.
      prisma.negotiationSession.deleteMany({
        where: { hostId: userId, link: { userId: { not: userId } } },
      }),
      // Cascades: Account, Session, ApiKey, Channel (+ messages, sessions),
      // CalendarCache, ComputedSchedule, NegotiationLink (+ sessions, messages,
      // proposals, outcome, holds, participants, consent requests, MCP logs).
      // hostedSessions die via their link; Hold rows die via session cascade.
      prisma.user.delete({ where: { id: userId } }),
    ]);
  } catch (err) {
    console.error("[account.delete] transaction failed", { userId, err });
    return NextResponse.json(
      { ok: false, error: "Deletion failed. No changes were made." },
      { status: 500 }
    );
  }

  // Best-effort: revoke Google tokens AFTER the DB is already consistent.
  // Worst case on failure is a stranded refresh token at Google that the
  // user can clear from myaccount.google.com/permissions.
  await Promise.allSettled(
    tokensToRevoke.map(async (token) => {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          signal: controller.signal,
        });
        clearTimeout(timeout);
      } catch (err) {
        console.warn("[account.delete] token revoke failed (non-blocking)", { userId, err });
      }
    })
  );

  // Best-effort housekeeping outside the main tx. Batched to avoid long holds.
  // These tables have userId but no FK/cascade; orphan rows are benign if a
  // batch fails partway.
  try {
    await prisma.routeError.deleteMany({ where: { userId } });
  } catch (err) {
    console.warn("[account.delete] RouteError cleanup failed (non-blocking)", { userId, err });
  }
  try {
    // SideEffectLog references userId only inside contextJson. No index
    // supports this predicate; deleteMany will seq-scan. Run it best-effort
    // and in a bounded loop so a very heavy user doesn't stall the response.
    for (let i = 0; i < 50; i++) {
      const res = await prisma.$executeRaw`
        DELETE FROM "SideEffectLog"
        WHERE id IN (
          SELECT id FROM "SideEffectLog"
          WHERE "contextJson"->>'userId' = ${userId}
          LIMIT 1000
        )
      `;
      if (!res) break;
    }
  } catch (err) {
    console.warn("[account.delete] SideEffectLog cleanup failed (non-blocking)", { userId, err });
  }

  // Audit breadcrumb. Vercel retains 30 days of logs — enough for v1.
  console.log("[account.delete]", {
    event: "account.delete",
    userId,
    email: userEmail,
    at: new Date().toISOString(),
  });

  return NextResponse.json({ ok: true });
}
