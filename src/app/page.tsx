"use client";

import { signIn, useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { LogoIcon } from "@/components/logo";

export default function Home() {
  const { status } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (status === "authenticated") {
      router.push("/dashboard");
    }
  }, [status, router]);

  return (
    <div className="min-h-screen bg-[#0a0a0f] flex flex-col items-center justify-center px-4">
      {/* Background gradient */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,#1a1a2e_0%,#0a0a0f_70%)]" />

      <div className="relative z-10 text-center max-w-2xl">
        <div className="flex items-center justify-center gap-4 mb-2">
          <LogoIcon size={64} className="text-indigo-400" />
          <div className="flex items-baseline">
            <h1 className="text-7xl md:text-8xl font-black tracking-tight bg-gradient-to-r from-indigo-400 via-purple-300 to-indigo-400 bg-clip-text text-transparent animate-[shimmer_3s_ease_infinite] bg-[length:200%_200%]">
              AgentEnvoy
            </h1>
            <span className="text-5xl md:text-6xl font-light text-indigo-400/40 tracking-tight">.ai</span>
          </div>
        </div>

        <p className="mt-10 text-xl md:text-2xl font-light text-zinc-400 leading-relaxed">
          From <span className="text-zinc-200 font-medium">scheduling meetings</span> to{" "}
          <span className="text-zinc-200 font-medium">navigating proposals</span> — your
          AI negotiates so you don&apos;t have to.
        </p>

        <div className="mt-10 flex flex-col sm:flex-row gap-4 justify-center">
          <button
            onClick={() => signIn("google", { callbackUrl: "/dashboard" })}
            className="px-8 py-4 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-lg font-semibold transition shadow-lg shadow-indigo-500/20 flex items-center justify-center gap-3"
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24">
              <path
                fill="currentColor"
                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
              />
              <path
                fill="currentColor"
                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
              />
              <path
                fill="currentColor"
                d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
              />
              <path
                fill="currentColor"
                d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
              />
            </svg>
            Sign in with Google
          </button>

          <a
            href="/demo.html"
            className="px-8 py-4 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-xl text-lg font-semibold transition border border-zinc-700"
          >
            Watch Demo
          </a>
        </div>

        <div className="mt-16 flex gap-8 md:gap-12 justify-center">
          {[
            { icon: "📅", label: "Calendar" },
            { icon: "📋", label: "RFPs" },
            { icon: "🤖", label: "Agent-native" },
            { icon: "🔗", label: "API-first" },
          ].map((feat) => (
            <div key={feat.label} className="text-center">
              <div className="text-2xl mb-1">{feat.icon}</div>
              <div className="text-xs text-zinc-500">{feat.label}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
