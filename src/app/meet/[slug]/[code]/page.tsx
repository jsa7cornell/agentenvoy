"use client";

import { useParams } from "next/navigation";
import { DealRoom } from "@/components/deal-room";

export default function ContextualMeetPage() {
  const params = useParams();
  const slug = params.slug as string;
  const code = params.code as string;

  return <DealRoom slug={slug} code={code} />;
}
