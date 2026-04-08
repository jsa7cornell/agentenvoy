import { FAQ_SECTIONS, FAQ_LAST_UPDATED, FAQ_HERO } from "@/content/faq-calendar";
import { PublicHeader } from "@/components/public-header";

export const metadata = {
  title: "How It Works | AgentEnvoy",
  description:
    "Learn how Envoy uses contextual awareness to negotiate the best meeting times — for one-on-ones, groups, and everything in between.",
};

export default function FaqPage() {
  return (
    <div className="min-h-screen bg-[#0a0a0f] text-zinc-100">
      <PublicHeader />

      {/* Hero */}
      <div className="max-w-3xl mx-auto px-6 pt-16 pb-12">
        <h1 className="text-3xl font-bold mb-3">{FAQ_HERO.headline}</h1>
        <p className="text-base text-zinc-400 leading-relaxed max-w-2xl">
          {FAQ_HERO.subline}
        </p>
        <p className="text-xs text-zinc-600 mt-4">Last updated: {FAQ_LAST_UPDATED}</p>
      </div>

      {/* Section nav */}
      <div className="max-w-3xl mx-auto px-6 pb-8">
        <nav className="flex flex-wrap gap-2">
          {FAQ_SECTIONS.map((section) => (
            <a
              key={section.id}
              href={`#${section.id}`}
              className="text-xs px-3 py-1.5 rounded-full border border-zinc-800 text-zinc-400 hover:text-zinc-200 hover:border-zinc-600 transition"
            >
              {section.title}
            </a>
          ))}
        </nav>
      </div>

      {/* Awareness layers visual */}
      <div className="max-w-3xl mx-auto px-6 pb-12">
        <div className="border border-zinc-800 rounded-2xl overflow-hidden">
          {[
            {
              label: "Layer 1",
              title: "Calendar",
              desc: "Google Calendar events, synced in real-time",
              color: "border-emerald-800 bg-emerald-950/30",
              accent: "text-emerald-400",
            },
            {
              label: "Layer 2",
              title: "Preferences",
              desc: "General habits, blocked windows, current context",
              color: "border-indigo-800 bg-indigo-950/30",
              accent: "text-indigo-400",
            },
            {
              label: "Layer 3",
              title: "Event Context",
              desc: "Per-invite rules, VIP treatment, exclusive slots",
              color: "border-amber-800 bg-amber-950/30",
              accent: "text-amber-400",
            },
          ].map((layer, i) => (
            <div
              key={i}
              className={`px-6 py-4 border-b last:border-b-0 ${layer.color}`}
            >
              <div className="flex items-baseline gap-3">
                <span className={`text-[10px] uppercase tracking-widest font-bold ${layer.accent}`}>
                  {layer.label}
                </span>
                <span className="text-sm font-semibold text-zinc-100">{layer.title}</span>
              </div>
              <p className="text-xs text-zinc-400 mt-1">{layer.desc}</p>
            </div>
          ))}
          <div className="px-6 py-3 bg-zinc-900/50 text-center">
            <span className="text-xs text-zinc-500">
              Each layer builds on the last. More context = smarter availability.
            </span>
          </div>
        </div>
      </div>

      {/* FAQ sections */}
      <div className="max-w-3xl mx-auto px-6 pb-20 space-y-16">
        {FAQ_SECTIONS.map((section) => (
          <section key={section.id} id={section.id} className="scroll-mt-20">
            <h2 className="text-xl font-bold text-zinc-100 mb-2">{section.title}</h2>
            {section.intro && (
              <p className="text-sm text-zinc-400 mb-6 leading-relaxed">{section.intro}</p>
            )}
            <div className="space-y-5">
              {section.items.map((item) => (
                <div
                  key={item.question}
                  className="border border-zinc-800 rounded-xl p-5 bg-zinc-900/30"
                >
                  <h3 className="text-sm font-semibold text-zinc-100 mb-2">
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
    </div>
  );
}
