// Thread status engine — computes dynamic status labels for thread cards

interface StatusInput {
  status: string;           // "active" | "agreed" | "escalated" | "expired"
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

  // Active status — depends on last message
  if (!input.lastMessageRole) return { label: `Waiting for ${name}`, color: "amber" };
  if (input.lastMessageRole === "administrator") return { label: `Waiting for ${name}`, color: "amber" };
  if (input.lastMessageRole === "guest") return { label: `${name} responded`, color: "purple" };

  return { label: "In progress", color: "purple" };
}
