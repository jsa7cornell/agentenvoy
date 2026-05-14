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
import { SeriesPage } from "@/components/SeriesPage/SeriesPage";
import { fetchSeriesPageProps } from "@/lib/series-page-props";

interface PageProps {
  params: Promise<{ host: string; slug: string }>;
}

export default async function SeriesRoute({ params }: PageProps) {
  const { host, slug } = await params;
  const data = await fetchSeriesPageProps(host, slug);
  if (!data) notFound();
  return <SeriesPage {...data} />;
}
