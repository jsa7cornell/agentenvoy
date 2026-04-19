/**
 * MESSAGE_ROLE_DISPATCH — style lookup + pure sender-line computation for
 * deal-room messages. Pure .ts so unit tests can import without touching
 * the JSX-bearing deal-room.tsx.
 *
 * Banner micro-spec §"Component changes": this file is the searchable
 * anchor (`MESSAGE_ROLE_DISPATCH`) for adding a new role or metadata.kind.
 *
 * Precedent: `system` + `metadata.kind === "host_update"` (commit 91fa4e8)
 * opts out of the bubble render entirely — helper returns null, caller
 * renders an inline ✓ summary. External-agent messages keep the bubble,
 * just tinted violet per §1.
 */

import { firstName } from "@/lib/mcp/principal";

export type RoleStyleOpts = {
  isGuest: boolean;
  isHost: boolean;
};

export type RoleStyle = {
  /** Tailwind classes for the bubble (background, border, text). */
  bubble: string;
  /** Tailwind class for the sender-label color. */
  labelColor: string;
  /** Whether the bubble is right-aligned (host/guest) or left-aligned. */
  rightAligned: boolean;
};

export function getRoleStyles(
  role: string,
  metadataKind: string | undefined,
  opts: RoleStyleOpts,
): RoleStyle | null {
  // System messages with structured metadata kinds can opt out of the
  // bubble render entirely — see the `host_update` inline branch in
  // deal-room.tsx's render loop.
  if (role === "system" && metadataKind === "host_update") return null;

  if (role === "external_agent") {
    // Banner micro-spec §1: violet, left-aligned, parallel to guest.
    return {
      bubble:
        "bg-violet-50 border border-violet-200 text-violet-900 rounded-bl-sm dark:bg-violet-900/30 dark:border-violet-700/40 dark:text-violet-100",
      labelColor: "text-violet-500 dark:text-violet-300",
      rightAligned: false,
    };
  }

  if (role === "host") {
    return {
      bubble: "bg-purple-600 text-white rounded-br-sm",
      labelColor: "text-white/60",
      rightAligned: true,
    };
  }
  if (role === "guest") {
    return {
      bubble: "bg-indigo-600 text-white rounded-br-sm",
      labelColor: "text-white/60",
      rightAligned: true,
    };
  }
  if (role === "system") {
    return {
      bubble:
        "bg-emerald-900/30 border border-emerald-800 text-emerald-200 rounded-lg",
      labelColor: "text-emerald-400",
      rightAligned: false,
    };
  }
  if (role === "guest_envoy") {
    // guest_envoy color follows team affiliation, viewer-relative:
    //   logged-in guest viewer → blue (your team)
    //   host viewer            → purple (counterparty)
    //   anonymous fallback     → neutral
    const bubble = opts.isGuest
      ? "bg-blue-900/30 border border-blue-800 text-blue-100 rounded-bl-sm"
      : opts.isHost
        ? "bg-purple-900/30 border border-purple-800 text-purple-100 rounded-bl-sm"
        : "bg-surface-secondary border border-DEFAULT text-primary rounded-bl-sm";
    const labelColor = opts.isGuest
      ? "text-blue-300"
      : opts.isHost
        ? "text-purple-300"
        : "text-emerald-400";
    return { bubble, labelColor, rightAligned: false };
  }

  // Default (administrator and anything else): neutral left bubble.
  return {
    bubble:
      "bg-surface-secondary border border-DEFAULT text-primary rounded-bl-sm",
    labelColor: "text-emerald-400",
    rightAligned: false,
  };
}

/**
 * Pure-data computation of the external-agent sender line per banner
 * micro-spec §1. Three metadata-shape fallbacks:
 *   - principal missing  → "{clientName}"
 *   - clientName missing → "External agent" (tooltip shows clientType)
 *   - both present       → "{clientName} · for {firstName(principal.name)}"
 *
 * Tooltip includes the full principal name (ephemeral UI, not logged) so a
 * host hovering the badge sees who the agent is acting for.
 */
export function computeExternalAgentSender(
  metadata: Record<string, unknown> | null | undefined,
): { headline: string; tooltip: string } {
  const meta = (metadata ?? {}) as Record<string, unknown>;
  const clientName =
    typeof meta.clientName === "string" && meta.clientName.trim()
      ? meta.clientName.trim()
      : null;
  const clientType =
    typeof meta.clientType === "string" && meta.clientType.trim()
      ? meta.clientType.trim()
      : null;
  const principal =
    meta.principal && typeof meta.principal === "object"
      ? (meta.principal as Record<string, unknown>)
      : null;
  const principalName =
    principal && typeof principal.name === "string" ? principal.name : null;
  const principalFirst = firstName(principalName);

  const tooltipParts: string[] = [];
  if (clientName) tooltipParts.push(clientName);
  if (clientType) tooltipParts.push(`(${clientType})`);
  if (principalName) tooltipParts.push(`for ${principalName}`);
  tooltipParts.push("Posted by an external agent using this meeting URL.");
  const tooltip = tooltipParts.join(" — ");

  const headline = !clientName
    ? "External agent"
    : principalFirst
      ? `${clientName} · for ${principalFirst}`
      : clientName;

  return { headline, tooltip };
}
