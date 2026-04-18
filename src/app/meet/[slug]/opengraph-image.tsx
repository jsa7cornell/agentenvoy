/**
 * Dynamic OG image for /meet/[slug] — what iMessage, Slack, Twitter, etc.
 * render in a link preview card. Next.js convention: file name must be
 * `opengraph-image.*` and the default export returns an ImageResponse.
 *
 * Pulls the host's name from Prisma at request time so the card shows
 * "Schedule with Mike" instead of generic branding. Falls back gracefully
 * if the slug doesn't exist.
 */

import { ImageResponse } from "next/og";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs"; // needs prisma, not edge
export const alt = "Schedule with AgentEnvoy";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

interface Props {
  params: { slug: string } | Promise<{ slug: string }>;
}

export default async function OpengraphImage({ params }: Props) {
  // Be tolerant of both Next 14 (direct object) and Next 15 (Promise) shapes.
  const resolved = await params;
  let hostFirst = "Someone";
  try {
    const user = await prisma.user.findUnique({
      where: { meetSlug: resolved.slug },
      select: { name: true },
    });
    if (user?.name) {
      hostFirst = user.name.split(/\s+/)[0];
    }
  } catch {
    // Fall through to generic fallback — never 500 an OG image.
  }

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          alignItems: "flex-start",
          padding: "80px",
          background:
            "linear-gradient(135deg, #0a0a0f 0%, #18122B 50%, #1e1b4b 100%)",
          color: "#f5f5fb",
          fontFamily: "system-ui, -apple-system, sans-serif",
        }}
      >
        {/* Logo mark */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "14px",
            marginBottom: "48px",
            fontSize: "28px",
            fontWeight: 700,
            color: "#c7c4f0",
            letterSpacing: "-0.01em",
          }}
        >
          <div
            style={{
              width: 44,
              height: 44,
              borderRadius: 10,
              background: "#6c5ce7",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 26,
              color: "#fff",
            }}
          >
            🤝
          </div>
          <span>AgentEnvoy</span>
        </div>

        {/* Headline */}
        <div
          style={{
            display: "flex",
            fontSize: "88px",
            fontWeight: 800,
            letterSpacing: "-0.03em",
            lineHeight: 1.05,
            marginBottom: "24px",
            maxWidth: "95%",
          }}
        >
          Schedule with {hostFirst}.
        </div>

        {/* Subhead */}
        <div
          style={{
            display: "flex",
            fontSize: "32px",
            fontWeight: 400,
            color: "#a5a3c4",
            letterSpacing: "-0.01em",
            lineHeight: 1.3,
            maxWidth: "85%",
          }}
        >
          An AI concierge reads the calendar, negotiates the time, books it.
        </div>

        {/* Footer URL */}
        <div
          style={{
            display: "flex",
            position: "absolute",
            bottom: 60,
            left: 80,
            fontSize: "24px",
            color: "#6c5ce7",
            fontFamily: "monospace",
            letterSpacing: "-0.01em",
          }}
        >
          agentenvoy.ai/meet/{resolved.slug}
        </div>
      </div>
    ),
    {
      ...size,
    }
  );
}
