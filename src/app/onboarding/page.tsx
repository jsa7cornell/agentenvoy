"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Onboarding now lives in the dashboard feed. Redirect any old links. */
export default function OnboardingPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/dashboard");
  }, [router]);
  return null;
}
