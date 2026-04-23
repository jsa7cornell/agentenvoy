// Thread status engine — computes dynamic status labels for thread cards

interface StatusInput {
  status: string; // "active" | "proposed" | "agreed" | "cancelled" | "escalated" | "expired"
  // retained for call-site compatibility — no longer used in label computation
  inviteeNames?: string[];
  inviteeName?: string | null;
  lastMessageRole?: string | null;
  guestEmail?: string | null;
}

interface StatusResult {
  label: string;    // e.g. "Waiting for Sarah"
  color: string;    // "amber" | "purple" | "green" | "orange" | "red" | "gray"
}

export function computeThreadStatus(input: StatusInput): StatusResult {
  if (input.status === "agreed") return { label: "Confirmed", color: "green" };
  if (input.status === "expired") return { label: "Expired", color: "gray" };
  if (input.status === "cancelled") return { label: "Cancelled", color: "red" };

  // All in-progress states (active, proposed, escalated) → "Active"
  return { label: "Active", color: "amber" };
}

// Group event status — aggregates across participants
export interface GroupParticipant {
  name: string;
  status: string; // "pending" | "active" | "agreed" | "declined"
}

export function computeGroupThreadStatus(
  participants: GroupParticipant[],
  sessionStatus: string
): StatusResult {
  if (sessionStatus === "agreed") return { label: "Confirmed", color: "green" };
  if (sessionStatus === "cancelled") return { label: "Cancelled", color: "red" };

  const total = participants.length;
  const agreed = participants.filter((p) => p.status === "agreed").length;
  const active = participants.filter((p) => p.status === "active").length;
  const pending = participants.filter((p) => p.status === "pending").length;
  const responded = agreed + active;

  if (agreed === total) return { label: "Ready to confirm", color: "green" };
  if (responded > 0 && pending > 0) {
    const pendingNames = participants
      .filter((p) => p.status === "pending")
      .map((p) => p.name);
    const waitingFor = pendingNames.length <= 2 ? pendingNames.join(" and ") : `${pendingNames.length} people`;
    return { label: `${responded}/${total} responded · Waiting for ${waitingFor}`, color: "amber" };
  }
  if (responded > 0) return { label: `${responded}/${total} responded`, color: "purple" };

  return { label: `0/${total} responded`, color: "amber" };
}
