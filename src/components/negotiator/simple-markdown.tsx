"use client";

// Lightweight markdown renderer — handles bold, bullets, headers, line breaks.
// No external deps. Good enough for LLM summary output.

interface SimpleMarkdownProps {
  content: string;
  className?: string;
}

export function SimpleMarkdown({ content, className = "" }: SimpleMarkdownProps) {
  const lines = content.split("\n");

  const parsed = lines.map((line, i) => {
    // Empty line = spacer
    if (line.trim() === "") return <div key={i} className="h-2" />;

    // Headers
    if (line.startsWith("### ")) return <p key={i} className="font-semibold text-sm mt-2">{renderInline(line.slice(4))}</p>;
    if (line.startsWith("## "))  return <p key={i} className="font-semibold text-sm mt-2">{renderInline(line.slice(3))}</p>;
    if (line.startsWith("# "))   return <p key={i} className="font-semibold text-sm mt-2">{renderInline(line.slice(2))}</p>;

    // Bullet
    if (line.startsWith("- ") || line.startsWith("* ")) {
      return (
        <div key={i} className="flex gap-2 text-sm leading-relaxed">
          <span className="mt-1 shrink-0 w-1 h-1 rounded-full bg-current opacity-60 translate-y-[6px]" />
          <span>{renderInline(line.slice(2))}</span>
        </div>
      );
    }

    // Normal paragraph line
    return <p key={i} className="text-sm leading-relaxed">{renderInline(line)}</p>;
  });

  return <div className={`space-y-0.5 ${className}`}>{parsed}</div>;
}

// Render inline bold/italic within a line
function renderInline(text: string): React.ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**"))
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("*") && part.endsWith("*"))
      return <em key={i}>{part.slice(1, -1)}</em>;
    return part;
  });
}
