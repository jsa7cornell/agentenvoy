"use client";

interface SimulatedDealRoomProps {
  data: Record<string, unknown>;
}

/** Mock deal room card shown during the simulation phase of onboarding */
export function SimulatedDealRoom({ data }: SimulatedDealRoomProps) {
  const name = (data.name as string) || "Sam";
  const topic = (data.topic as string) || "Meeting";
  const duration = (data.duration as number) || 30;
  const format = (data.format as string) || "video";
  const slug = (data.slug as string) || "you";
  const slots = (data.slots as Array<{ start: string; end: string; score: number }>) || [];

  const formatLabel =
    format === "phone" ? "Phone call" : format === "video" ? "Video" : format === "in-person" ? "In-person" : "TBD";

  // Show 3 sample time slots
  const sampleSlots = slots.slice(0, 3).map((s) => {
    const d = new Date(s.start);
    return d.toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  });

  return (
    <div className="bg-surface-inset/50 border border-indigo-500/20 rounded-xl p-4 max-w-sm">
      {/* Header */}
      <div className="flex items-start justify-between mb-3">
        <div>
          <div className="text-sm font-semibold text-primary">
            {topic} — {name}
          </div>
          <div className="text-xs text-muted mt-0.5">
            {duration} min · {formatLabel}
          </div>
        </div>
        <div className="px-2 py-0.5 bg-indigo-500/10 text-indigo-400 text-[10px] font-medium rounded-full">
          Preview
        </div>
      </div>

      {/* Sample availability */}
      {sampleSlots.length > 0 && (
        <div className="mb-3">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted mb-1.5">
            Available times
          </div>
          <div className="flex flex-col gap-1">
            {sampleSlots.map((slot, i) => (
              <div
                key={i}
                className="text-xs text-primary bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-3 py-1.5"
              >
                {slot}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Simulated link */}
      <div className="bg-black/5 dark:bg-white/5 rounded-lg px-3 py-2 flex items-center gap-2">
        <code className="text-[10px] text-indigo-400 truncate flex-1">
          agentenvoy.ai/meet/{slug}/abc123
        </code>
        <div className="px-2 py-0.5 bg-indigo-600/20 text-indigo-400 text-[10px] rounded cursor-default">
          Copy
        </div>
      </div>
    </div>
  );
}
