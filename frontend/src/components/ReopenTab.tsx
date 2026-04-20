import { useUiStore } from "@/stores/ui-store";
import { ChevronLeft, ChevronRight } from "lucide-react";

type Props = { side: "left" | "right" };

export function ReopenTab({ side }: Props) {
  const toggle = useUiStore((s) => side === "left" ? s.toggleLeft : s.toggleRight);
  const Icon = side === "left" ? ChevronRight : ChevronLeft;
  return (
    <button
      type="button"
      aria-label={`Reopen ${side} panel`}
      onClick={toggle}
      className={[
        "absolute top-1/2 -translate-y-1/2 z-20",
        "w-[18px] h-[60px] flex items-center justify-center",
        "bg-[rgba(18,18,28,0.85)] backdrop-blur-md border border-white/10 text-slate-400",
        "hover:text-white hover:border-[color:var(--ac1-mid)]",
        side === "left" ? "left-0 rounded-r-lg" : "right-0 rounded-l-lg",
      ].join(" ")}
    >
      <Icon size={14} />
    </button>
  );
}
