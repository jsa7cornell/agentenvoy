import { NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { streamText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";

const DASHBOARD_SYSTEM = `You are the AgentEnvoy assistant on the user's dashboard. You help them:
1. Create meet links (generic or contextual) from natural language
2. Configure their scheduling preferences
3. View and manage their negotiations

When the user describes a meeting they want to set up, extract:
- Who they want to meet (name, email)
- Topic/purpose
- Time preferences, format preferences, constraints
- Any special rules

Then respond with the link details. Be conversational but efficient.

IMPORTANT: When you create a link, include the structured data in a JSON block at the end of your message like this:
\`\`\`agentenvoy-action
{"action": "create_link", "inviteeEmail": "...", "inviteeName": "...", "topic": "...", "rules": {...}}
\`\`\`

If the user just wants to update their default preferences:
\`\`\`agentenvoy-action
{"action": "update_preferences", "preferences": {...}}
\`\`\`
`;

// POST /api/dashboard/chat
// Stream chat response for the dashboard agent
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { messages } = await req.json();

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { name: true, meetSlug: true, preferences: true },
  });

  const contextMessage = `User: ${user?.name || "User"}\nMeet slug: ${user?.meetSlug || "not set"}\nCurrent preferences: ${JSON.stringify(user?.preferences || {})}\nBase URL: ${process.env.NEXTAUTH_URL || "https://agentenvoy.ai"}`;

  const result = streamText({
    model: anthropic("claude-sonnet-4-20250514"),
    system: DASHBOARD_SYSTEM + "\n\nCONTEXT:\n" + contextMessage,
    messages,
  });

  return result.toTextStreamResponse();
}
