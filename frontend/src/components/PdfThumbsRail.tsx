type Props = {
  pageCount: number;
  current: number;
  onJump: (page: number) => void;
};

export function PdfThumbsRail({ pageCount, current, onJump }: Props) {
  return (
    <div className="border-r border-white/5 px-1.5 py-3 flex flex-col items-center gap-2 overflow-y-auto">
      {Array.from({ length: pageCount }, (_, i) => i + 1).map((n) => (
        <button
          key={n}
          onClick={() => onJump(n)}
          aria-label={`Page ${n}`}
          className={[
            "w-[42px] h-[56px] rounded-md bg-[#f5f5f7] transition-all relative overflow-hidden",
            n === current ? "opacity-100 ring-2 ring-[color:var(--ac1)] shadow-[0_0_22px_var(--ac1-mid)]" : "opacity-50 hover:opacity-80",
          ].join(" ")}
        >
          <span className="absolute bottom-0.5 left-1/2 -translate-x-1/2 text-[8px] text-slate-700">{n}</span>
        </button>
      ))}
    </div>
  );
}
