import { NextResponse, type NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  parseChannelMessageMetadata,
  type ActionCall,
  type ActionResultRecord,
} from "@/lib/channel/metadata-schema";
import { buildFilingContext } from "@/lib/feedback/build-filing-context";

export const dynamic = "force-dynamic";

const MAX_MESSAGES = 60;
const MAX_SESSIONS = 10;
const ROUTE_ERROR_LOOKBACK_HOURS = 24;

export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  const { messageContent, adminNote, sessionId, url } = body as {
    messageContent?: string;
    adminNote?: string;
    sessionId?: string;
    url?: string;
  };

  if (!messageContent || typeof messageContent !== "string") {
    return NextResponse.json({ ok: false, error: "messageContent required" }, { status: 400 });
  }

  const bundle = await buildBundle(userId, sessionId ?? null);

  const report = await prisma.composerReport.create({
    data: {
      userId,
      sessionId: sessionId ?? null,
      messageContent,
      adminNote: adminNote ?? null,
      url: url ?? null,
      bundle: bundle as never,
    },
  });

  return NextResponse.json({ ok: true, reportId: report.id });
}

async function buildBundle(userId: string, sessionId: string | null) {
  const capturedAt = new Date().toISOString();

  const [rawMessages, user, sessions, routeErrors, dealRoomMessages] = await Promise.all([
    prisma.channelMessage.findMany({
      where: { channel: { userId } },
      orderBy: { createdAt: "asc" },
      take: MAX_MESSAGES,
      select: { id: true, role: true, content: true, createdAt: true, metadata: true },
    }),
    prisma.user.findUnique({
      where: { id: userId },
      select: {
        preferences: true,
        persistentKnowledge: true,
        upcomingSchedulePreferences: true,
        hostDirectives: true,
      },
    }),
    prisma.negotiationSession.findMany({
      where: { hostId: userId },
      orderBy: { createdAt: "desc" },
      take: MAX_SESSIONS,
      select: {
        id: true,
        title: true,
        status: true,
        agreedTime: true,
        createdAt: true,
        link: { select: { code: true, slug: true, parameters: true, customTitle: true, inviteeName: true } },
      },
    }),
    prisma.routeError.findMany({
      where: {
        userId,
        createdAt: { gte: new Date(Date.now() - ROUTE_ERROR_LOOKBACK_HOURS * 3600 * 1000) },
      },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: { id: true, createdAt: true, route: true, method: true, errorClass: true, message: true },
    }),
    sessionId
      ? prisma.message.findMany({
          where: { sessionId },
          orderBy: { createdAt: "asc" },
          select: { id: true, role: true, content: true, createdAt: true },
        })
      : Promise.resolve(null),
  ]);

  const conversationHistory = rawMessages.map((m) => {
    const meta = parseChannelMessageMetadata(m.metadata);
    return {
      id: m.id,
      role: m.role,
      createdAt: m.createdAt.toISOString(),
      content: m.content ?? "",
      ...(meta.actions?.length ? {
        actions: meta.actions.map((a: ActionCall) => ({ action: a.action, params: a.params })),
      } : {}),
      ...(meta.actionResults?.length ? {
        actionResults: meta.actionResults.map((r: ActionResultRecord) => ({
          action: r.action, success: r.success, message: r.message,
          ...(r.data ? { data: r.data } : {}),
        })),
      } : {}),
      ...(meta.promptContext ? { promptContext: meta.promptContext } : {}),
    };
  });

  const filingMessages = rawMessages.map((m) => ({
    id: m.id, role: m.role, content: m.content ?? "",
    createdAt: m.createdAt, metadata: m.metadata,
  }));
  const filingContext = filingMessages.length > 0
    ? buildFilingContext(filingMessages, new Date())
    : null;

  return {
    capturedAt,
    conversationHistory,
    filingContext,
    userPreferences: {
      preferences: user?.preferences ?? null,
      persistentKnowledge: user?.persistentKnowledge ?? null,
      upcomingSchedulePreferences: user?.upcomingSchedulePreferences ?? null,
      hostDirectives: user?.hostDirectives ?? null,
    },
    activeSessions: sessions.map((s) => ({
      id: s.id,
      title: s.link?.customTitle ?? s.title ?? null,
      status: s.status,
      agreedTime: s.agreedTime?.toISOString() ?? null,
      createdAt: s.createdAt.toISOString(),
      linkCode: s.link?.code ?? null,
      linkUrl: s.link?.slug ? `/meet/${s.link.slug}/${s.link.code}` : null,
      linkParameters: s.link?.parameters ?? null,
    })),
    routeErrors: routeErrors.map((e) => ({
      id: e.id,
      createdAt: e.createdAt.toISOString(),
      route: e.route,
      method: e.method ?? null,
      errorClass: e.errorClass ?? null,
      message: e.message,
    })),
    ...(dealRoomMessages ? {
      dealRoomThread: dealRoomMessages.map((m) => ({
        id: m.id, role: m.role, content: m.content,
        createdAt: m.createdAt.toISOString(),
      })),
    } : {}),
  };
}
