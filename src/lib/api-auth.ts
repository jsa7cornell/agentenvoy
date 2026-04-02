import { NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "./auth";
import { prisma } from "./prisma";
import { createHash } from "crypto";

function hashKey(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

/**
 * Authenticate a request via Bearer token or NextAuth session.
 * Returns the userId if authenticated, null otherwise.
 */
export async function authenticateRequest(
  req: NextRequest
): Promise<string | null> {
  // 1. Check for Bearer token
  const authHeader = req.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    const hashed = hashKey(token);
    const apiKey = await prisma.apiKey.findUnique({ where: { key: hashed } });
    if (apiKey) {
      // Update lastUsedAt (fire-and-forget)
      prisma.apiKey
        .update({
          where: { id: apiKey.id },
          data: { lastUsedAt: new Date() },
        })
        .catch(() => {});
      return apiKey.userId;
    }
    return null; // Invalid token — don't fall through to session
  }

  // 2. Fall back to NextAuth session
  const session = await getServerSession(authOptions);
  return session?.user?.id ?? null;
}

/**
 * Generate a new API key for a user.
 * Returns { plaintextKey, apiKey } — plaintext is shown once, hash is stored.
 */
export async function generateApiKey(userId: string, name = "Default") {
  const { randomBytes } = await import("crypto");
  const plaintext = `ae_${randomBytes(32).toString("hex")}`;
  const hashed = hashKey(plaintext);

  const apiKey = await prisma.apiKey.create({
    data: {
      key: hashed,
      userId,
      name,
    },
  });

  return { plaintextKey: plaintext, apiKey };
}
