/**
 * Next.js middleware — attaches the `Link: <...>; rel="agent-api"` header
 * to every `/meet/*` response so AI agents discovering a meeting URL can
 * follow the link rel to the MCP endpoint without a content sniff.
 *
 * Pattern follows RFC 5988 link relations. `rel="agent-api"` isn't an IANA
 * registered type (yet); we use it per the MCP community convention — any
 * crawler/agent that doesn't understand the rel simply ignores the header.
 *
 * Also emits `rel="service-doc"` pointing at `/llms.txt` for human-readable
 * orientation when an agent is poking around the link's surface.
 *
 * Runs on the Edge runtime (Next.js middleware default). No DB access here —
 * the header is purely static per URL, so this is a constant-time shim.
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function middleware(req: NextRequest) {
  const res = NextResponse.next();
  const origin = req.nextUrl.origin;
  // Primary discovery: the MCP endpoint itself. Agents should fetch
  // `/.well-known/mcp.json` for the full manifest; the Link header is the
  // "HTTP-level pointer" form that's cheap to emit on every /meet/* GET.
  res.headers.append(
    "Link",
    `<${origin}/api/mcp>; rel="agent-api"; type="application/json"`
  );
  res.headers.append(
    "Link",
    `<${origin}/.well-known/mcp.json>; rel="service-desc"; type="application/json"`
  );
  res.headers.append(
    "Link",
    `<${origin}/llms.txt>; rel="service-doc"; type="text/plain"`
  );
  return res;
}

export const config = {
  // Only /meet/* pages — those are the pages an agent is likely to land on
  // after being handed a URL. Don't emit on every API / asset / dashboard
  // route; nobody benefits from the noise.
  matcher: ["/meet/:path*"],
};
