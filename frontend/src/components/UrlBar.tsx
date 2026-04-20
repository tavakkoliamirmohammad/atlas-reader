import { useState } from "react";
import { Plus } from "lucide-react";
import { parseArxivId } from "@/lib/arxiv-id";

type Props = { onSubmit: (arxivId: string) => void };

export function UrlBar({ onSubmit }: Props) {
  const [value, setValue] = useState("");
  function submit(e: React.FormEvent) {
    e.preventDefault();
    const id = parseArxivId(value);
    if (id) {
      onSubmit(id);
      setValue("");
    }
  }
  return (
    <form
      onSubmit={submit}
      className="mx-3 mt-2 mb-1 flex items-center gap-2 px-2.5 py-2 rounded-[10px] bg-white/[0.04] border border-white/5"
    >
      <Plus size={14} className="text-[color:var(--ac1)]" />
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Paste arXiv URL or paper ID..."
        className="flex-1 bg-transparent border-0 outline-none text-xs text-slate-300 placeholder:text-slate-500"
      />
      <button
        type="submit"
        className="px-2 py-0.5 rounded-md text-xs font-semibold cursor-pointer"
        style={{ background: "var(--user-grad)", color: "var(--user-ink)" }}
      >
        Open
      </button>
    </form>
  );
}
