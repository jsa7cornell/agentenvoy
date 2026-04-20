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

export interface AdminUser {
  id: string;
  email: string;
}

async function lookupAdmin(email: string | null | undefined): Promise<AdminUser | null> {
  if (!email) return null;
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true, userClass: true },
  });
  if (!user?.email || user.userClass !== "admin") return null;
  return { id: user.id, email: user.email };
}

function sessionEmail(
  session: Awaited<ReturnType<typeof getServerSession>>,
): string | null {
  const user = (session as { user?: { email?: string | null } } | null)?.user;
  return user?.email ?? null;
}

/** Use in server components — redirects to sign-in if not authenticated,
 *  404s if authenticated but not an admin. Returns the admin's email. */
export async function requireAdminPage(callbackUrl?: string): Promise<string> {
  return (await requireAdminContext(callbackUrl)).email;
}

/** Same as requireAdminPage but returns `{ id, email }`. Use when the caller
 *  needs the admin's User.id (e.g., for AdminAccessLog inserts). */
export async function requireAdminContext(callbackUrl?: string): Promise<AdminUser> {
  const session = await getServerSession(authOptions);
  const email = sessionEmail(session);
  if (!email) {
    redirect(`/api/auth/signin${callbackUrl ? `?callbackUrl=${encodeURIComponent(callbackUrl)}` : ""}`);
  }
  const admin = await lookupAdmin(email);
  if (!admin) notFound();
  return admin;
}

/** Use in API route handlers — returns false on failure (caller sends 404). */
export async function isAdminSession(): Promise<boolean> {
  const session = await getServerSession(authOptions);
  return (await lookupAdmin(sessionEmail(session))) !== null;
}
