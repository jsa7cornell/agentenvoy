"use client";

import { signIn, useSession } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, Suspense } from "react";

/**
 * Dev-only auto-login page.
 * /dev-login → signs in as the seed test user, redirects to /dashboard
 * /dev-login?to=/dashboard/availability → signs in, redirects to the given path
 *
 * In production the NEXT_PUBLIC_DEV_AUTH_SECRET won't exist and the
 * dev-credentials provider isn't registered, so this page is inert.
 */
function DevLoginInner() {
  const { status } = useSession();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [attempted, setAttempted] = useState(false);

  const destination = searchParams.get("to") || "/dashboard";

  useEffect(() => {
    if (status === "authenticated") {
      router.replace(destination);
      return;
    }
    if (status === "loading" || attempted) return;

    const secret = process.env.NEXT_PUBLIC_DEV_AUTH_SECRET;
    if (!secret) {
      setError("NEXT_PUBLIC_DEV_AUTH_SECRET not set — dev login unavailable.");
      return;
    }

    setAttempted(true);

    signIn("dev-credentials", {
      email: "testhost@agentenvoy.dev",
      secret,
      redirect: false,
    }).then((result) => {
      if (result?.ok) {
        // Mark the test user as calibrated so onboarding redirect is skipped
        fetch("/api/debug/onboarding-reset", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode: "calibrate" }),
        })
          .catch(() => {}) // best-effort
          .finally(() => router.replace(destination));
      } else {
        setError(`Sign-in failed: ${result?.error || "unknown error"}`);
      }
    }).catch((err) => {
      setError(`Sign-in error: ${err.message}`);
    });
  }, [status, router, attempted, destination]);

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-surface">
        <div className="text-center">
          <p className="text-red-400 text-sm">{error}</p>
          <p className="text-muted text-xs mt-2">This page only works in development.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-surface">
      <div className="text-muted text-sm">Signing in as test user...</div>
    </div>
  );
}

export default function DevLoginPage() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center bg-surface"><div className="text-muted text-sm">Loading...</div></div>}>
      <DevLoginInner />
    </Suspense>
  );
}
