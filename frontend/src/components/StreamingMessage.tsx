import { useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";

type Props = {
  role: "user" | "assistant";
  content: string;
  isStreaming?: boolean;
  model?: "opus" | "sonnet" | "haiku";
};

/**
 * Strip trailing incomplete markdown markers so a partial token like `**B`
 * doesn't render as literal `**B` mid-stream. Only used while `isStreaming`
 * is true; once the stream finishes we render the full content unmodified.
 *
 * Examples:
 *   "rides**"            -> "rides"          (unmatched bold)
 *   "Hello **B"          -> "Hello "         (open bold + partial)
 *   "tap `print"         -> "tap "           (open inline code)
 *   "see [docs"          -> "see "           (open link label)
 *   "$x = "              -> ""               (open inline math)
 *   "fully **closed**"   -> "fully **closed**" (unchanged)
 */
function sanitizeStreamingMarkdown(content: string): string {
  let s = content;

  // 1) Unclosed link label: strip from the unmatched `[` onward.
  //    We walk from the end and find the last `[` with no `]` after it.
  const lastOpen = s.lastIndexOf("[");
  if (lastOpen !== -1 && s.indexOf("]", lastOpen) === -1) {
    s = s.slice(0, lastOpen);
  }

  // 2) Math delimiters. Handle $$ first (display math), then single $.
  //    Count occurrences; if odd, trim everything from the last delimiter on.
  const dollarPairs = (s.match(/\$\$/g) ?? []).length;
  if (dollarPairs % 2 === 1) {
    s = s.slice(0, s.lastIndexOf("$$"));
  } else {
    // Single-$ count excludes the $$ pairs we just verified are balanced.
    const singles = (s.match(/(?<!\$)\$(?!\$)/g) ?? []).length;
    if (singles % 2 === 1) {
      // Find the last lone $ (not part of $$).
      let idx = -1;
      for (let i = s.length - 1; i >= 0; i--) {
        if (s[i] === "$" && s[i - 1] !== "$" && s[i + 1] !== "$") {
          idx = i;
          break;
        }
      }
      if (idx !== -1) s = s.slice(0, idx);
    }
  }

  // 3) Backticks (inline code). Count single ` (excluding ``` fences); if odd,
  //    trim from the last unmatched one onward.
  const fenceCount = (s.match(/```/g) ?? []).length;
  // Strip fences from a working copy so inner ticks don't get miscounted.
  // Then if outer ticks are odd, the user is mid-fence: leave it (safer to keep
  // the fenced block visible than to wipe a partial code sample).
  if (fenceCount % 2 === 0) {
    const singleTicks = (s.match(/(?<!`)`(?!`)/g) ?? []).length;
    if (singleTicks % 2 === 1) {
      // Find the last lone backtick.
      let idx = -1;
      for (let i = s.length - 1; i >= 0; i--) {
        if (s[i] === "`" && s[i - 1] !== "`" && s[i + 1] !== "`") {
          idx = i;
          break;
        }
      }
      if (idx !== -1) s = s.slice(0, idx);
    }
  }

  // 4) Strikethrough (~~). Count pairs; if odd, trim the trailing unmatched ~~.
  const tildePairs = (s.match(/~~/g) ?? []).length;
  if (tildePairs % 2 === 1) {
    s = s.slice(0, s.lastIndexOf("~~"));
  }

  // 5) Bold (**). Same idea — count pairs, trim if unmatched.
  const starPairs = (s.match(/\*\*/g) ?? []).length;
  if (starPairs % 2 === 1) {
    s = s.slice(0, s.lastIndexOf("**"));
  }

  // 6) Italic single * (after stripping all ** pairs from the count).
  //    Count lone * (not adjacent to another *); if odd, trim the last one.
  const loneStars = (s.match(/(?<!\*)\*(?!\*)/g) ?? []).length;
  if (loneStars % 2 === 1) {
    let idx = -1;
    for (let i = s.length - 1; i >= 0; i--) {
      if (s[i] === "*" && s[i - 1] !== "*" && s[i + 1] !== "*") {
        idx = i;
        break;
      }
    }
    if (idx !== -1) s = s.slice(0, idx);
  }

  // 7) Italic single _ (same logic). Note: don't touch __ (used for bold).
  const loneUnders = (s.match(/(?<!_)_(?!_)/g) ?? []).length;
  if (loneUnders % 2 === 1) {
    let idx = -1;
    for (let i = s.length - 1; i >= 0; i--) {
      if (s[i] === "_" && s[i - 1] !== "_" && s[i + 1] !== "_") {
        idx = i;
        break;
      }
    }
    if (idx !== -1) s = s.slice(0, idx);
  }

  return s;
}

export function StreamingMessage({ role, content, isStreaming, model }: Props) {
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
        {!isUser && model && (
          <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">
            via {model}
          </div>
        )}
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
              {isStreaming ? sanitizeStreamingMarkdown(content) : content}
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
