import { FAQ_SECTIONS, FAQ_LAST_UPDATED, PIPELINE_DIAGRAM } from "@/content/faq-calendar";

export const metadata = {
  title: "How Scheduling Works | AgentEnvoy",
  description: "Learn how Envoy manages your calendar, scores availability, and coordinates meetings.",
};

export default function FaqPage() {
  return (
    <div className="min-h-screen bg-[#0a0a0f] text-zinc-100">
      <div className="max-w-3xl mx-auto px-6 py-16">
        <h1 className="text-3xl font-bold mb-2">How Scheduling Works</h1>
        <p className="text-sm text-zinc-500 mb-12">Last updated: {FAQ_LAST_UPDATED}</p>

        <div className="space-y-12">
          {/* Pipeline diagram */}
          <section className="border border-zinc-800 rounded-2xl p-8 bg-zinc-900/50">
            <h2 className="text-xl font-bold text-zinc-100 mb-4">The Availability Pipeline</h2>
            <p className="text-sm text-zinc-400 mb-4">
              Envoy builds your availability from two sources, scores every slot, then applies
              per-event context. The widget and chat always see the same data.
            </p>
            <pre className="text-xs text-zinc-400 bg-zinc-950 rounded-lg p-4 overflow-x-auto leading-relaxed font-mono">
              {PIPELINE_DIAGRAM}
            </pre>
          </section>

          {/* Score scale visual */}
          <section className="border border-zinc-800 rounded-2xl p-8 bg-zinc-900/50">
            <h2 className="text-xl font-bold text-zinc-100 mb-4">Protection Score Scale</h2>
            <p className="text-sm text-zinc-400 mb-4">
              Every 30-minute slot gets a score. Lower = more available. Guests only see scores 2 and below.
            </p>
            <div className="space-y-1.5">
              {[
                { score: -2, label: "Exclusive", desc: "ONLY these times available", color: "bg-indigo-900/50 text-indigo-300 border-indigo-800" },
                { score: -1, label: "Preferred", desc: "Offer these first", color: "bg-green-900/50 text-green-300 border-green-800" },
                { score: 0, label: "Free", desc: "Declined invites, volunteered time", color: "bg-green-900/50 text-green-300 border-green-800" },
                { score: 1, label: "Open", desc: "Empty business hours", color: "bg-emerald-900/40 text-emerald-300 border-emerald-800" },
                { score: 2, label: "Soft hold", desc: "Focus Time, tentative small meetings", color: "bg-amber-900/50 text-amber-300 border-amber-800" },
                { score: 3, label: "Friction", desc: "Tentative meetings, recurring 1:1s", color: "bg-orange-900/40 text-orange-300 border-orange-800", hidden: true },
                { score: 4, label: "Protected", desc: "Confirmed meetings, blocked windows", color: "bg-red-900/30 text-red-300 border-red-800", hidden: true },
                { score: 5, label: "Immovable", desc: "Flights, legal, sacred items", color: "bg-red-900/50 text-red-200 border-red-800", hidden: true },
              ].map((s) => (
                <div
                  key={s.score}
                  className={`flex items-center gap-3 px-3 py-2 rounded-lg border text-sm ${s.color}`}
                >
                  <span className="font-mono font-bold w-6 text-right">{s.score}</span>
                  <span className="font-semibold w-24">{s.label}</span>
                  <span className="text-xs opacity-80 flex-1">{s.desc}</span>
                  {s.hidden && (
                    <span className="text-[10px] uppercase tracking-wider opacity-60">hidden from guests</span>
                  )}
                </div>
              ))}
            </div>
          </section>

          {/* FAQ sections */}
          {FAQ_SECTIONS.map((section) => (
            <section key={section.title}>
              <h2 className="text-xl font-bold text-zinc-100 mb-6">{section.title}</h2>
              <div className="space-y-6">
                {section.items.map((item) => (
                  <div
                    key={item.question}
                    className="border border-zinc-800 rounded-xl p-6 bg-zinc-900/30"
                  >
                    <h3 className="text-base font-semibold text-zinc-100 mb-3">
                      {item.question}
                    </h3>
                    <p className="text-sm text-zinc-400 leading-relaxed whitespace-pre-line">
                      {item.answer}
                    </p>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>

        {/* Back link */}
        <div className="mt-16 pt-8 border-t border-zinc-800">
          <a
            href="/"
            className="text-sm text-zinc-500 hover:text-zinc-300 transition"
          >
            &larr; Back to AgentEnvoy
          </a>
        </div>
      </div>
    </div>
  );
}
