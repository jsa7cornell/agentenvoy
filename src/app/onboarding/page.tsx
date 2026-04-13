"use client";

import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { OnboardingChat } from "@/components/onboarding/onboarding-chat";

export default function OnboardingPage() {
  const { data: session, status } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (status === "unauthenticated") {
      router.push("/");
    } else if (status === "authenticated" && session?.user?.onboardingComplete) {
      router.push("/dashboard");
    }
  }, [status, session, router]);

  if (status === "loading") {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-muted text-sm">Loading...</div>
      </div>
    );
  }

  if (!session || session.user?.onboardingComplete) {
    return null;
  }

  return (
    <div className="flex-1 flex flex-col max-w-2xl mx-auto w-full min-h-0">
      <OnboardingChat />
    </div>
  );
}
