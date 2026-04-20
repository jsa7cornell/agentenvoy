/**
 * Shared admin auth helper. Call at the top of any server component or API
 * route that should be restricted to admin accounts.
 *
 * Authoritative gate: User.userClass === "admin" (F1 of the feedback-loops
 * proposal, 2026-04-20). ADMIN_EMAIL env-var match stays as a 24-48h
 * fallback so the first post-migration deploy can verify the new gate
 * works before removing the env path in the next PR.
 *
 * Returns the session email on success; calls notFound() (server component)
 * or returns false (API route) otherwise. We 404 instead of 401 so the
 * existence of /admin/* routes is not revealed to non-admins.
 */

import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { notFound, redirect } from "next/navigation";

export const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "jsa7cornell@gmail.com";

/**
 * Core admin check. Returns true if the email belongs to an admin, false
 * otherwise (including null/undefined email). userClass is the authoritative
 * gate; the env-var match is a fallback that will be removed in the next PR
 * once the migration has been verified in prod.
 */
async function isAdminByEmail(email: string | null | undefined): Promise<boolean> {
  if (!email) return false;

  const user = await prisma.user.findUnique({
    where: { email },
    select: { userClass: true },
  });
  if (user?.userClass === "admin") return true;

  // 24-48h env-var fallback. Remove in the very next PR.
  return email.toLowerCase() === ADMIN_EMAIL.toLowerCase();
}

function sessionEmail(
  session: Awaited<ReturnType<typeof getServerSession>>,
): string | null {
  const user = (session as { user?: { email?: string | null } } | null)?.user;
  return user?.email ?? null;
}

/** Use in server components — redirects to sign-in if not authenticated,
 *  404s if authenticated but not an admin. */
export async function requireAdminPage(callbackUrl?: string): Promise<string> {
  const session = await getServerSession(authOptions);
  const email = sessionEmail(session);
  if (!email) {
    redirect(`/api/auth/signin${callbackUrl ? `?callbackUrl=${encodeURIComponent(callbackUrl)}` : ""}`);
  }
  if (!(await isAdminByEmail(email))) notFound();
  return email;
}

/** Use in API route handlers — returns false on failure (caller sends 404). */
export async function isAdminSession(): Promise<boolean> {
  const session = await getServerSession(authOptions);
  return isAdminByEmail(sessionEmail(session));
}
