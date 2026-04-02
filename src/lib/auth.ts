import { NextAuthOptions } from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "./prisma";

export const authOptions: NextAuthOptions = {
  adapter: PrismaAdapter(prisma) as NextAuthOptions["adapter"],
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
      authorization: {
        params: {
          scope:
            "openid email profile https://www.googleapis.com/auth/calendar.events",
          access_type: "offline",
          prompt: "consent",
        },
      },
    }),
  ],
  callbacks: {
    async session({ session, user }) {
      if (session.user) {
        session.user.id = user.id;
        // Fetch meetSlug for the user
        const dbUser = await prisma.user.findUnique({
          where: { id: user.id },
          select: { meetSlug: true },
        });
        session.user.meetSlug = dbUser?.meetSlug ?? null;
      }
      return session;
    },
    async signIn() {
      // Account tokens are saved automatically by PrismaAdapter
      return true;
    },
  },
  session: {
    strategy: "database",
    maxAge: 7 * 24 * 60 * 60, // 7 days
    updateAge: 24 * 60 * 60,  // refresh session token every 24 hours
  },
  pages: {
    signIn: "/",
    error: "/",
  },
  events: {
    async createUser({ user }) {
      // Generate a default meetSlug from the user's name or email
      const base = user.name
        ? user.name.toLowerCase().replace(/[^a-z0-9]/g, "")
        : user.email?.split("@")[0] ?? "user";
      let slug = base;
      let counter = 1;
      while (await prisma.user.findUnique({ where: { meetSlug: slug } })) {
        slug = `${base}${counter}`;
        counter++;
      }
      await prisma.user.update({
        where: { id: user.id },
        data: { meetSlug: slug },
      });
    },
  },
};
