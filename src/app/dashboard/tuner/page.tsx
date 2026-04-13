"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function TunerRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/dashboard/availability");
  }, [router]);
  return null;
}
