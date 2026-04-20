/**
 * /mcp → /agents
 *
 * This route used to be a developer waitlist page ("Get notified when the
 * public API launches") with placeholder MCP Server + REST API cards
 * labeled "Coming Soon." Both surfaces have since shipped (MCP for real,
 * REST API was never real), and the live home for this material is the
 * /agents landing page.
 *
 * Keeping the route reachable — inbound links and the home-page
 * "Point your agent at it" CTA still pointed here — but funnelling all
 * traffic to /agents so there's one canonical surface to maintain.
 */
import { redirect } from "next/navigation";

export const metadata = {
  title: "For Agents | AgentEnvoy",
};

export default function MCPPage() {
  redirect("/agents");
}
