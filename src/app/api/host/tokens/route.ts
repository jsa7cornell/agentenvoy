/**
 * PAT management — mint and list host-side MCP tokens.
 *
 * POST /api/host/tokens  — mint a new PAT
 * GET  /api/host/tokens  — list existing PATs (no plaintext returned)
 */
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { createHash, randomBytes } from "crypto";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
function toBase62(buf: Buffer): string {
  let n = BigInt("0x" + buf.toString("hex"));
  let result = "";
  const base = BigInt(62);
  while (n > 0n) {
    result = BASE62[Number(n % base)] + result;
    n /= base;
  }
  return result.padStart(43, "0"); // ~256 bits in base62
}

const VALID_SCOPES = new Set(["read", "schedule", "admin"]);

const mintSchema = z.object({
  name: z.string().min(1).max(100),
  scopes: z.array(z.string()).min(1).max(3),
});

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const user = await prisma.user.findUnique({
    where: { email: session.user.email },
    select: { id: true },
  });
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = mintSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  }

  const { name, scopes } = parsed.data;
  const invalidScopes = scopes.filter((s) => !VALID_SCOPES.has(s));
  if (invalidScopes.length > 0) {
    return NextResponse.json(
      { error: `Invalid scopes: ${invalidScopes.join(", ")}. Valid: read, schedule, admin` },
      { status: 400 },
    );
  }

  // Generate token: agentenvoy_pat_live_<43-char-base62>
  const randomPart = toBase62(randomBytes(32));
  const plaintext = `agentenvoy_pat_live_${randomPart}`;
  const tokenHash = createHash("sha256").update(plaintext).digest("hex");
  const displayId = randomPart.slice(0, 8);

  const token = await prisma.hostAccessToken.create({
    data: {
      userId: user.id,
      tokenHash,
      displayId,
      name,
      scopes,
    },
  });

  return NextResponse.json({
    id: token.id,
    displayId: token.displayId,
    name: token.name,
    scopes: token.scopes,
    createdAt: token.createdAt,
    // Plaintext shown ONCE — never stored, never re-fetchable.
    plaintext,
  });
}

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const user = await prisma.user.findUnique({
    where: { email: session.user.email },
    select: { id: true },
  });
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

  const tokens = await prisma.hostAccessToken.findMany({
    where: { userId: user.id, revokedAt: null },
    select: {
      id: true,
      displayId: true,
      name: true,
      scopes: true,
      lastUsedAt: true,
      createdAt: true,
      expiresAt: true,
    },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({ tokens });
}
