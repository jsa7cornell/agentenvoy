"use client";

import { useParams } from "next/navigation";
import { DealRoom } from "@/components/deal-room";

export default function GenericMeetPage() {
  const params = useParams();
  const slug = params.slug as string;

  return <DealRoom slug={slug} />;
}
