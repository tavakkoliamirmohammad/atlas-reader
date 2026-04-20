type Props = { ai: boolean | null };

export function AiStatusPill({ ai }: Props) {
  const off = ai === false;
  const label = ai === null ? "AI: checking…" : ai ? "AI: connected" : "AI: offline";
  return (
    <div className={[
      "flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs",
      "bg-white/[0.04] border border-white/5",
      off ? "text-slate-400" : "text-slate-300",
    ].join(" ")}>
      <span
        className="w-[7px] h-[7px] rounded-full"
        style={off
          ? { background: "#6b7280" }
          : { background: "#10b981", boxShadow: "0 0 10px #10b981" }}
      />
      <span>{label}</span>
    </div>
  );
}
