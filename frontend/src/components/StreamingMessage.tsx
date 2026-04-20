import { useEffect, useRef } from "react";

type Props = {
  role: "user" | "assistant";
  content: string;
  isStreaming?: boolean;
};

export function StreamingMessage({ role, content, isStreaming }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [content]);

  const isUser = role === "user";
  return (
    <div ref={ref} className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={[
          "max-w-[90%] rounded-xl px-3 py-2 text-[13px] leading-relaxed whitespace-pre-wrap",
          isUser
            ? "text-[color:var(--user-ink)] font-medium"
            : "bg-white/[0.04] border border-white/5 text-slate-200",
        ].join(" ")}
        style={isUser ? { background: "var(--user-grad)" } : undefined}
      >
        {content || (isStreaming ? <span className="opacity-60">...</span> : null)}
        {isStreaming && content && (
          <span className="inline-block ml-1 w-1.5 h-3 bg-current opacity-50 align-middle animate-pulse" />
        )}
      </div>
    </div>
  );
}
