import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { generateApiKey } from "@/lib/api-auth";

// POST /api/keys/create
// Generate a new API key for the authenticated user
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const name = body.name || "Default";

  const { plaintextKey, apiKey } = await generateApiKey(
    session.user.id,
    name
  );

  return NextResponse.json({
    key: plaintextKey,
    id: apiKey.id,
    name: apiKey.name,
    createdAt: apiKey.createdAt,
    message:
      "Save this key — it won't be shown again.",
  });
}
