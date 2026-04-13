"use client";

interface QuickReplyOption {
  number: number;
  label: string;
  value: string;
}

interface QuickRepliesProps {
  options: QuickReplyOption[];
  onSelect: (value: string, label: string) => void;
  disabled?: boolean;
}

export function QuickReplies({ options, onSelect, disabled }: QuickRepliesProps) {
  return (
    <div className="flex flex-col gap-1.5 mt-1">
      {options.map((opt) => (
        <button
          key={opt.value}
          onClick={() => onSelect(opt.value, opt.label)}
          disabled={disabled}
          className="text-left text-sm px-3.5 py-2.5 rounded-xl border border-indigo-500/20 bg-indigo-500/5 hover:bg-indigo-500/15 hover:border-indigo-500/40 text-primary transition disabled:opacity-40 disabled:cursor-default"
        >
          <span className="text-indigo-400 font-semibold mr-2">{opt.number}.</span>
          {opt.label}
        </button>
      ))}
    </div>
  );
}
