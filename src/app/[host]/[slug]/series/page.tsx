/**
 * /[host]/[slug]/series — Series page route stub (PR4).
 *
 * Returns notFound() in all environments until PR2 wires the data layer
 * (Prisma queries to assemble SeriesPageProps from host + slug).
 *
 * Import of SeriesPage is intentional — it connects the module graph and
 * lets TypeScript validate the component interface at build time without
 * rendering any unfinished UI to real users.
 *
 * TODO PR2: replace notFound() with real data fetch:
 *   const data = await fetchSeriesPageProps(host, slug);
 *   if (!data) notFound();
 *   return <SeriesPage {...data} />;
 */

import { notFound } from "next/navigation";
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { SeriesPage } from "@/components/SeriesPage/SeriesPage";

interface PageProps {
  params: Promise<{ host: string; slug: string }>;
}

export default async function SeriesRoute({ params }: PageProps) {
  // Consume params to satisfy the async server component contract.
  // Will be used in PR2 for the real data fetch.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _params = await params;

  // Stub: notFound() in all environments until PR2 wires data.
  // Dev harness is at /dev/meeting-card (Series page section).
  notFound();
}
