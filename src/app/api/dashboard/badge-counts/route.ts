/**
 * Aggregated badge counts for the dashboard chrome.
 *
 * Producer for indicators that ride on the topbar — today the only consumer is
 * the cyan "needs your attention" dot on the mobile Event Links pill, which
 * lights up when at least one `awaiting_ack_self` notification is unread for
 * the signed-in user. Backed by the `Notification` table's `(userId, readAt)`
 * index (`prisma/schema.prisma`); the bell UI / notification center listed in
 * `WISHLIST.md notification-bell-and-center` will join this endpoint as it
 * lands rather than spawning a parallel aggregator.
 *
 * GET → { awaitingAck: <integer> }
 *
 * Defensive on the client: callers should treat the dot as decorative — a fetch
 * failure renders no dot rather than a spinner or error toast.
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const count = await prisma.notification.count({
    where: {
      userId: session.user.id,
      kind: "awaiting_ack_self",
      readAt: null,
    },
  });

  return NextResponse.json({ awaitingAck: count });
}
