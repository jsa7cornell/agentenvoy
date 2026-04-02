import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { generateCode } from "@/lib/utils";
import { parsePreferences } from "@/agent/administrator";
import { authenticateRequest } from "@/lib/api-auth";

// POST /api/negotiate/create
// Creates a contextual negotiation link
// Auth: Bearer token OR NextAuth session
export async function POST(req: NextRequest) {
  const userId = await authenticateRequest(req);
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { inviteeEmail, inviteeName, topic, rules, prompt } = body;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { meetSlug: true },
  });

  if (!user?.meetSlug) {
    return NextResponse.json(
      { error: "No meet slug configured" },
      { status: 400 }
    );
  }

  // If a natural language prompt is provided, parse it into structured rules
  let parsedRules = rules || {};
  if (prompt && !rules) {
    parsedRules = await parsePreferences(prompt);
  }

  const code = generateCode();

  const link = await prisma.negotiationLink.create({
    data: {
      userId,
      type: "contextual",
      slug: user.meetSlug,
      code,
      inviteeEmail: inviteeEmail || parsedRules.inviteeEmail || null,
      inviteeName: inviteeName || parsedRules.inviteeName || null,
      topic: topic || parsedRules.topic || null,
      rules: parsedRules,
    },
  });

  const baseUrl = process.env.NEXTAUTH_URL || "https://agentenvoy.ai";
  const genericUrl = `${baseUrl}/meet/${user.meetSlug}`;
  const contextualUrl = `${baseUrl}/meet/${user.meetSlug}/${code}`;

  return NextResponse.json({
    link: {
      id: link.id,
      type: "contextual",
      genericUrl,
      contextualUrl,
      code,
      inviteeEmail: link.inviteeEmail,
      inviteeName: link.inviteeName,
      topic: link.topic,
      rules: link.rules,
    },
  });
}
