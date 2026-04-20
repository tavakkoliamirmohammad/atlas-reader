import { useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";

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
  const showLoading = isStreaming && !content;

  return (
    <div ref={ref} className={`flex fade-up ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={[
          "max-w-[90%] rounded-xl px-3 py-2 text-[13px] leading-relaxed",
          isUser
            ? "text-[color:var(--user-ink)] font-medium whitespace-pre-wrap"
            : "bg-white/[0.04] border border-white/5 text-slate-200 markdown-body",
        ].join(" ")}
        style={isUser ? { background: "var(--user-grad)" } : undefined}
      >
        {showLoading ? (
          <span className="inline-flex items-center gap-2 text-slate-400 text-xs">
            <span
              className="inline-block w-3 h-3 rounded-full border-2 border-current border-t-transparent animate-spin"
              aria-hidden
            />
            <span>Thinking</span>
            <span className="inline-flex gap-0.5">
              <span className="w-1 h-1 rounded-full bg-current animate-bounce" style={{ animationDelay: "0ms" }} />
              <span className="w-1 h-1 rounded-full bg-current animate-bounce" style={{ animationDelay: "150ms" }} />
              <span className="w-1 h-1 rounded-full bg-current animate-bounce" style={{ animationDelay: "300ms" }} />
            </span>
          </span>
        ) : isUser ? (
          content
        ) : (
          <>
            <ReactMarkdown
              remarkPlugins={[remarkGfm, remarkMath]}
              rehypePlugins={[rehypeKatex]}
            >
              {content}
            </ReactMarkdown>
            {isStreaming && (
              <span
                className="inline-block ml-1 w-1.5 h-3 bg-current opacity-60 align-middle animate-pulse"
                aria-hidden
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}
