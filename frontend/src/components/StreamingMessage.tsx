import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import type { AnyModel, ModelChoice } from "@/lib/api";

type Props = {
  role: "user" | "assistant";
  content: string;
  isStreaming?: boolean;
  model?: AnyModel;
};

// Per-Claude-model pill colors; Codex models share one palette below since
// they're all the same provider.
const CLAUDE_PILL_STYLE: Record<ModelChoice, React.CSSProperties> = {
  opus:   { color: "#c4b5fd", background: "rgba(139,92,246,0.12)", border: "1px solid rgba(139,92,246,0.28)" },
  sonnet: { color: "#67e8f9", background: "rgba(34,211,238,0.12)", border: "1px solid rgba(34,211,238,0.28)" },
  haiku:  { color: "#fcd34d", background: "rgba(251,191,36,0.12)", border: "1px solid rgba(251,191,36,0.28)" },
};

const CODEX_PILL_STYLE: React.CSSProperties = {
  color: "#86efac",
  background: "rgba(34,197,94,0.12)",
  border: "1px solid rgba(34,197,94,0.28)",
};

function isClaudeModel(m: string): m is ModelChoice {
  return m === "opus" || m === "sonnet" || m === "haiku";
}

function pillStyle(model: AnyModel): React.CSSProperties {
  return isClaudeModel(model) ? CLAUDE_PILL_STYLE[model] : CODEX_PILL_STYLE;
}

function pillLabel(model: AnyModel): string {
  if (isClaudeModel(model)) {
    return model[0].toUpperCase() + model.slice(1);
  }
  // Codex model IDs look like "gpt-5.4" / "gpt-5.1-codex-mini". Make them
  // readable: "GPT-5.4", "GPT-5.1-Codex-Mini".
  return model
    .split("-")
    .map((part, i) => {
      if (i === 0 && part === "gpt") return "GPT";
      if (part === "codex") return "Codex";
      if (part === "mini") return "Mini";
      if (part === "max") return "Max";
      return part;
    })
    .join("-");
}

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

  // Track elapsed seconds while the "Thinking" placeholder is visible. We
  // record a start timestamp when showLoading flips to true, then tick at 1Hz.
  // Below 3s we show a plain "Thinking" (avoids flicker on fast responses);
  // from 3s we append the count, and from 15s we add a reassurance note that
  // Opus can legitimately take a while.
  const [elapsed, setElapsed] = useState(0);
  const startedAtRef = useRef<number | null>(null);
  useEffect(() => {
    if (!showLoading) {
      startedAtRef.current = null;
      setElapsed(0);
      return;
    }
    startedAtRef.current = Date.now();
    setElapsed(0);
    const id = window.setInterval(() => {
      if (startedAtRef.current !== null) {
        setElapsed(Math.floor((Date.now() - startedAtRef.current) / 1000));
      }
    }, 1000);
    return () => window.clearInterval(id);
  }, [showLoading]);

  // Model-aware thinking label. We always name the running model once elapsed
  // crosses the 3s anti-flicker threshold so the user can verify which model
  // is actually generating the response at a glance.
  const modelName = model ? pillLabel(model) : null;
  let thinkingLabel = "Thinking";
  if (showLoading && elapsed >= 3) {
    const base = modelName
      ? `Thinking ${elapsed}s · ${modelName}`
      : `Thinking ${elapsed}s`;
    thinkingLabel =
      elapsed >= 15 && model === "opus"
        ? `${base} can take a moment`
        : base;
  }

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
          <div className="mb-1.5">
            <span
              className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider"
              style={pillStyle(model)}
              title={`Response from ${pillLabel(model)}`}
            >
              <span
                aria-hidden
                className="inline-block w-1.5 h-1.5 rounded-full"
                style={{ background: pillStyle(model).color }}
              />
              {pillLabel(model)}
            </span>
          </div>
        )}
        {showLoading ? (
          <span className="inline-flex items-center gap-2 text-slate-400 text-xs">
            <span
              className="inline-block w-3 h-3 rounded-full border-2 border-current border-t-transparent animate-spin"
              aria-hidden
            />
            <span>{thinkingLabel}</span>
            <span className="inline-flex gap-0.5">
              <span className="w-1 h-1 rounded-full bg-current animate-bounce" style={{ animationDelay: "0ms" }} />
              <span className="w-1 h-1 rounded-full bg-current animate-bounce" style={{ animationDelay: "150ms" }} />
              <span className="w-1 h-1 rounded-full bg-current animate-bounce" style={{ animationDelay: "300ms" }} />
            </span>
          </span>
        ) : isUser ? (
          content
        ) : (
          <div className={isStreaming ? "is-streaming" : undefined}>
            <ReactMarkdown
              remarkPlugins={[remarkGfm, remarkMath]}
              rehypePlugins={[rehypeKatex]}
            >
              {isStreaming ? sanitizeStreamingMarkdown(content) : content}
            </ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  );
}
