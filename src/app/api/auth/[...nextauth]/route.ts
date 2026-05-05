import NextAuth from "next-auth";
import { authOptions } from "@/lib/auth";

// Vercel preview deployments: use the stable branch URL (VERCEL_BRANCH_URL stays
// constant across commits; NEXTAUTH_URL must match the callback URL registered in
// Google Cloud Console). Without this, every new commit URL breaks OAuth and resets
// session cookies, forcing re-onboarding.
if (process.env.VERCEL_ENV !== "production") {
  const stableUrl = process.env.VERCEL_BRANCH_URL ?? process.env.VERCEL_URL;
  if (stableUrl) {
    process.env.NEXTAUTH_URL = `https://${stableUrl}`;
  }
}

const handler = NextAuth(authOptions);

export { handler as GET, handler as POST };
