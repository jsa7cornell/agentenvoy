/**
 * Shared admin auth helper. Call at the top of any server component or API
 * route that should be restricted to admin accounts.
 *
 * Gate: User.userClass === "admin" (F1 of the feedback-loops proposal).
 *
 * Returns the session email on success; calls notFound() (server component)
 * or returns false (API route) otherwise. We 404 instead of 401 so the
 * existence of /admin/* routes is not revealed to non-admins.
 */

import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { notFound, redirect } from "next/navigation";

async function isAdminByEmail(email: string | null | undefined): Promise<boolean> {
  if (!email) return false;
  const user = await prisma.user.findUnique({
    where: { email },
    select: { userClass: true },
  });
  return user?.userClass === "admin";
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
