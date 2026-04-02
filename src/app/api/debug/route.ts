import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// Temporary diagnostic endpoint — remove after debugging
export async function GET() {
  const checks: Record<string, unknown> = {};

  // 1. Test DB connection
  try {
    const userCount = await prisma.user.count();
    checks.db = { connected: true, userCount };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    checks.db = { connected: false, error: msg };
  }

  // 2. Check for users without accounts (orphaned — causes OAuthAccountNotLinked)
  try {
    const orphaned = await prisma.user.findMany({
      where: { accounts: { none: {} } },
      select: { id: true, email: true, createdAt: true },
    });
    checks.orphanedUsers = orphaned;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    checks.orphanedUsers = { error: msg };
  }

  // 3. Check if Channel table exists (new migration)
  try {
    const channelCount = await prisma.channel.count();
    checks.channelTable = { exists: true, count: channelCount };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    checks.channelTable = { exists: false, error: msg };
  }

  // 4. Check env vars are set (not their values)
  checks.env = {
    DATABASE_URL: !!process.env.DATABASE_URL,
    DIRECT_URL: !!process.env.DIRECT_URL,
    NEXTAUTH_URL: process.env.NEXTAUTH_URL,
    NEXTAUTH_SECRET: !!process.env.NEXTAUTH_SECRET,
    GOOGLE_CLIENT_ID: !!process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: !!process.env.GOOGLE_CLIENT_SECRET,
  };

  return NextResponse.json(checks, { status: 200 });
}
