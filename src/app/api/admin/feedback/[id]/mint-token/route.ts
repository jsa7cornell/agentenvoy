/**
 * POST /api/admin/feedback/[id]/mint-token
 *
 * Admin-gated. Creates an AgentAccessToken row + returns a signed 15-min
 * JWT. Every mint is audited via logAdminAccess. Rate-limited to 20 mints
 * per admin per hour.
 *
 * See proposals/2026-04-21_agent-accessible-feedback-pipeline §2 + §6.5.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdminContext } from "@/lib/admin-auth";
import { logAdminAccess } from "@/lib/admin/access-log";
import {
  AGENT_TOKEN_TTL_SECONDS,
  signAgentToken,
} from "@/lib/feedback/agent-token";

export const dynamic = "force-dynamic";

const MINT_RATE_WINDOW_MS = 60 * 60 * 1000;
const MINT_RATE_LIMIT = 20;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const admin = await requireAdminContext(`/admin/feedback/${id}`);

  const report = await prisma.feedbackReport.findUnique({
    where: { id },
    select: { id: true, userId: true },
  });
  if (!report) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const since = new Date(Date.now() - MINT_RATE_WINDOW_MS);
  const recentMints = await prisma.agentAccessToken.count({
    where: { mintedById: admin.id, createdAt: { gte: since } },
  });
  if (recentMints >= MINT_RATE_LIMIT) {
    return NextResponse.json(
      { error: "rate_limited", detail: `Max ${MINT_RATE_LIMIT} mints per hour.` },
      { status: 429 },
    );
  }

  let minted;
  try {
    minted = signAgentToken({ reportId: report.id });
  } catch (e) {
    console.error("[mint-token] sign failed", e);
    return NextResponse.json(
      { error: "server_error", detail: "AGENT_TOKEN_SECRET is not configured." },
      { status: 500 },
    );
  }

  await prisma.agentAccessToken.create({
    data: {
      reportId: report.id,
      mintedById: admin.id,
      jti: minted.jti,
      expiresAt: minted.expiresAt,
    },
  });

  await logAdminAccess({
    adminId: admin.id,
    path: "/api/admin/feedback/:id/mint-token",
    action: "view",
    targetUserId: report.userId,
    context: {
      feedbackReportId: report.id,
      tokenJti: minted.jti,
      action: "mint",
    },
  });

  const origin = request.headers.get("origin") || new URL(request.url).origin;
  const fetchUrl = `${origin}/api/agent/feedback/${report.id}?token=${minted.token}`;
  const curl = `curl -s '${fetchUrl}'`;

  const ttlMinutes = Math.round(AGENT_TOKEN_TTL_SECONDS / 60);
  const prompt = [
    `You're debugging AgentEnvoy (Next.js + Prisma + Supabase). A feedback report needs investigation.`,
    ``,
    `Report ID: ${report.id}`,
    `Admin page: ${origin}/admin/feedback/${report.id}`,
    ``,
    `Fetch the debug bundle (token expires in ${ttlMinutes} min, ${10} fetches max):`,
    ``,
    curl,
    ``,
    `The response has { report, bundle } — bundle includes messages, sessions, recentLinks, calendar, routeErrors, consoleLines, clientState.`,
    ``,
    `Read agentenvoy/PLAYBOOK.md → "Debug bundle handling" before acting. Summarize findings, propose a root cause, and quote specific bundle lines as evidence before writing code.`,
  ].join("\n");

  return NextResponse.json(
    {
      reportId: report.id,
      jti: minted.jti,
      token: minted.token,
      expiresAt: minted.expiresAt.toISOString(),
      ttlSeconds: AGENT_TOKEN_TTL_SECONDS,
      fetchUrl,
      curl,
      prompt,
    },
    {
      status: 201,
      // Don't let this URL leak via Referer if an admin navigates from it.
      headers: { "Referrer-Policy": "no-referrer" },
    },
  );
}
