// Thread status engine — computes dynamic status labels for thread cards

interface StatusInput {
  status: string;           // "active" | "proposed" | "agreed" | "cancelled" | "escalated" | "expired"
  inviteeName?: string | null;
  lastMessageRole?: string | null;  // "administrator" | "guest" | "system"
  guestEmail?: string | null;
}

interface StatusResult {
  label: string;    // e.g. "Waiting for Sarah"
  color: string;    // "amber" | "purple" | "green" | "orange" | "red" | "gray"
}

export function computeThreadStatus(input: StatusInput): StatusResult {
  const name = input.inviteeName || input.guestEmail || "invitee";

  if (input.status === "agreed") return { label: "Confirmed", color: "green" };
  if (input.status === "expired") return { label: "Expired", color: "gray" };
  if (input.status === "escalated") return { label: "Needs your input", color: "red" };
  if (input.status === "cancelled") return { label: "Cancelled", color: "red" };
  if (input.status === "proposed") return { label: `Waiting for ${name}`, color: "amber" };

  // Active status — depends on last message
  if (!input.lastMessageRole) return { label: `Waiting for ${name}`, color: "amber" };
  if (input.lastMessageRole === "administrator") return { label: `Waiting for ${name}`, color: "amber" };
  if (input.lastMessageRole === "guest") return { label: `${name} responded`, color: "purple" };

  return { label: "In progress", color: "purple" };
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
