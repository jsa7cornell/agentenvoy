/**
 * POST /api/account/delete — handler-shape tests.
 *
 * Asserts the route's auth, origin, and body validation; that Google's
 * revoke endpoint is invoked with the stored refresh/access tokens after
 * a successful DB transaction; and that a revoke failure does not block
 * the 200 response (best-effort contract).
 *
 * Real Prisma cascade behavior is covered by the integration test in
 * `src/__tests__/integration/account-delete.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next-auth", () => ({
  getServerSession: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  authOptions: {},
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    account: {
      findMany: vi.fn(),
    },
    negotiationSession: { updateMany: vi.fn() },
    sessionParticipant: { updateMany: vi.fn() },
    user: { delete: vi.fn() },
    routeError: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    $transaction: vi.fn(),
    $executeRaw: vi.fn().mockResolvedValue(0),
  },
}));

import { POST } from "@/app/api/account/delete/route";
import { getServerSession } from "next-auth";
import { prisma } from "@/lib/prisma";

const USER_ID = "user_abc";
const USER_EMAIL = "host@example.com";
const ORIGIN = "http://localhost:3000";

function makeRequest(init?: {
  origin?: string | null;
  body?: unknown;
  badJson?: boolean;
}): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (init?.origin !== null && init?.origin !== undefined) headers.set("origin", init.origin);
  else if (init?.origin === undefined) headers.set("origin", ORIGIN);
  const body = init?.badJson ? "not-json" : JSON.stringify(init?.body ?? { confirmEmail: USER_EMAIL });
  return new Request("http://localhost:3000/api/account/delete", {
    method: "POST",
    headers,
    body,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEXTAUTH_URL = "http://localhost:3000";
  (prisma.account.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (prisma.$transaction as ReturnType<typeof vi.fn>).mockResolvedValue([{}, {}, {}]);
});

describe("POST /api/account/delete — auth & validation", () => {
  it("rejects with 403 on missing origin", async () => {
    (getServerSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { id: USER_ID, email: USER_EMAIL },
    });
    const res = await POST(makeRequest({ origin: null }) as never);
    expect(res.status).toBe(403);
  });

  it("rejects with 403 on cross-origin", async () => {
    (getServerSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { id: USER_ID, email: USER_EMAIL },
    });
    const res = await POST(makeRequest({ origin: "https://evil.example" }) as never);
    expect(res.status).toBe(403);
  });

  it("accepts production origin matching NEXTAUTH_URL", async () => {
    process.env.NEXTAUTH_URL = "https://agentenvoy.ai";
    (getServerSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { id: USER_ID, email: USER_EMAIL },
    });
    const res = await POST(makeRequest({ origin: "https://agentenvoy.ai" }) as never);
    expect(res.status).toBe(200);
  });

  it("rejects with 401 when no session", async () => {
    (getServerSession as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res = await POST(makeRequest() as never);
    expect(res.status).toBe(401);
  });

  it("rejects with 400 on malformed JSON body", async () => {
    (getServerSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { id: USER_ID, email: USER_EMAIL },
    });
    const res = await POST(makeRequest({ badJson: true }) as never);
    expect(res.status).toBe(400);
  });

  it("rejects with 400 when confirmEmail does not match session email", async () => {
    (getServerSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { id: USER_ID, email: USER_EMAIL },
    });
    const res = await POST(
      makeRequest({ body: { confirmEmail: "different@example.com" } }) as never,
    );
    expect(res.status).toBe(400);
  });

  it("accepts case-insensitive email match", async () => {
    (getServerSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { id: USER_ID, email: USER_EMAIL },
    });
    const res = await POST(
      makeRequest({ body: { confirmEmail: USER_EMAIL.toUpperCase() } }) as never,
    );
    expect(res.status).toBe(200);
  });
});

describe("POST /api/account/delete — revocation", () => {
  it("calls Google revoke endpoint for each stored token after the tx", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
      new Response("", { status: 200 }),
    );
    (getServerSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { id: USER_ID, email: USER_EMAIL },
    });
    (prisma.account.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { refresh_token: "refresh_abc", access_token: "access_xyz" },
    ]);

    const txOrder: string[] = [];
    (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      txOrder.push("tx");
      return [{}, {}, {}];
    });
    fetchSpy.mockImplementation(async () => {
      txOrder.push("revoke");
      return new Response("", { status: 200 });
    });

    const res = await POST(makeRequest() as never);
    expect(res.status).toBe(200);
    const calledUrls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(calledUrls.some((u) => u.includes("oauth2.googleapis.com/revoke") && u.includes("refresh_abc"))).toBe(true);
    expect(calledUrls.some((u) => u.includes("access_xyz"))).toBe(true);
    // tx runs before any revoke call
    expect(txOrder[0]).toBe("tx");
    fetchSpy.mockRestore();
  });

  it("returns 200 even if token revocation fails (best-effort)", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockRejectedValue(new Error("network"));
    (getServerSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { id: USER_ID, email: USER_EMAIL },
    });
    (prisma.account.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { refresh_token: "refresh_abc", access_token: null },
    ]);

    const res = await POST(makeRequest() as never);
    expect(res.status).toBe(200);
    fetchSpy.mockRestore();
  });

  it("returns 500 and no revoke call when the transaction fails", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(new Response("", { status: 200 }));
    (getServerSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { id: USER_ID, email: USER_EMAIL },
    });
    (prisma.account.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { refresh_token: "refresh_abc" },
    ]);
    (prisma.$transaction as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("fk constraint"));

    const res = await POST(makeRequest() as never);
    expect(res.status).toBe(500);
    const revokeCalled = fetchSpy.mock.calls.some((c) => String(c[0]).includes("oauth2.googleapis.com/revoke"));
    expect(revokeCalled).toBe(false);
    fetchSpy.mockRestore();
  });
});
