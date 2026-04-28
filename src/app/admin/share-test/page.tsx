/**
 * /admin/share-test — playground for the mobile Web Share API + fallbacks.
 * Admin-gated; load on a phone (or DevTools mobile emulation over HTTPS) to
 * exercise the OS share sheet.
 */

import Link from "next/link";
import { requireAdminContext } from "@/lib/admin-auth";
import { logAdminAccess } from "@/lib/admin/access-log";
import { ShareTestClient } from "./share-test-client";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function AdminShareTestPage() {
  const admin = await requireAdminContext("/admin/share-test");
  await logAdminAccess({
    adminId: admin.id,
    path: "/admin/share-test",
    action: "list",
  });

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 p-6">
      <div className="max-w-2xl mx-auto">
        <div className="mb-6">
          <Link href="/admin" className="text-xs text-zinc-500 hover:text-zinc-300 transition">
            ← Admin
          </Link>
          <h1 className="text-2xl font-bold mt-2">Share-sheet test</h1>
          <p className="text-sm text-zinc-500 mt-1 leading-relaxed">
            Exercise <code className="text-xs bg-zinc-900 px-1 py-0.5 rounded">navigator.share</code>{" "}
            and the fallback channels (clipboard, SMS / mailto / WhatsApp / Telegram deep links, QR).
            The native sheet only opens on mobile browsers over HTTPS — desktop will show the &ldquo;not
            available&rdquo; state and you can poke at the fallbacks.
          </p>
        </div>

        <ShareTestClient />
      </div>
    </div>
  );
}
