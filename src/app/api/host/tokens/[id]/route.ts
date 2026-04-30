/**
 * POST /api/host/tokens/:id/revoke  — revoke a PAT
 * DELETE /api/host/tokens/:id       — revoke a PAT (alias)
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function revoke(id: string): Promise<NextResponse> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const user = await prisma.user.findUnique({
    where: { email: session.user.email },
    select: { id: true },
  });
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

  const token = await prisma.hostAccessToken.findUnique({
    where: { id },
    select: { id: true, userId: true, revokedAt: true },
  });

  if (!token || token.userId !== user.id) {
    return NextResponse.json({ error: "Token not found" }, { status: 404 });
  }

  if (token.revokedAt) {
    return NextResponse.json({ error: "Token already revoked" }, { status: 409 });
  }

  await prisma.hostAccessToken.update({
    where: { id },
    data: { revokedAt: new Date() },
  });

  return NextResponse.json({ ok: true });
}

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params;
  return revoke(id);
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params;
  return revoke(id);
}
