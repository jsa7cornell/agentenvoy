/**
 * Shared admin auth helper. Call at the top of any server component or API
 * route that should be restricted to the admin account.
 *
 * Returns the session email on success; calls notFound() (server component)
 * or returns null (API route) otherwise. We 404 instead of 401 so the
 * existence of /admin/* routes is not revealed to non-admins.
 */

import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { notFound, redirect } from "next/navigation";

export const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "jsa7cornell@gmail.com";

/** Use in server components — redirects to sign-in if not authenticated,
 *  404s if authenticated but wrong account. */
export async function requireAdminPage(callbackUrl?: string): Promise<string> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    redirect(`/api/auth/signin${callbackUrl ? `?callbackUrl=${encodeURIComponent(callbackUrl)}` : ""}`);
  }
  if (session.user.email !== ADMIN_EMAIL) notFound();
  return session.user.email;
}

/** Use in API route handlers — returns false on failure (caller sends 404). */
export async function isAdminSession(): Promise<boolean> {
  const session = await getServerSession(authOptions);
  return session?.user?.email === ADMIN_EMAIL;
}
