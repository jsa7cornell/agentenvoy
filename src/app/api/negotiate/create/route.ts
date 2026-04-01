import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { generateCode } from "@/lib/utils";
import { parsePreferences } from "@/agent/administrator";

// POST /api/negotiate/create
// Creates a contextual negotiation link
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { inviteeEmail, inviteeName, topic, rules, prompt } = body;

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
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
      userId: session.user.id,
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
