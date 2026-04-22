import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import type { AnyModel, ModelChoice } from "@/lib/api";
import { MermaidDiagram } from "./MermaidDiagram";

type Props = {
  role: "user" | "assistant";
  content: string;
  isStreaming?: boolean;
  model?: AnyModel;
};

function isClaudeModel(m: string): m is ModelChoice {
  return m === "opus" || m === "sonnet" || m === "haiku";
}

// Per-model pill class. Colors are defined in globals.css so they can flip
// per app mode — the pastel tints that read on a dark backdrop turn into
// unreadable tonal blurs on light, so each palette has two variants.
function pillClass(model: AnyModel): string {
  if (isClaudeModel(model)) return `msg-pill msg-pill-${model}`;
  return "msg-pill msg-pill-codex";
}

/**
 * Swap `<code class="language-mermaid">…</code>` code blocks for an inline
 * MermaidDiagram render. Falls back to the default rendering for every
 * other language. While the response is still streaming we skip Mermaid
 * rendering — partial source fails to parse.
 */
function markdownComponents(isStreaming: boolean): Components {
  return {
    code({ className, children, ...props }) {
      const isMermaid = typeof className === "string"
        && className.indexOf("language-mermaid") !== -1;
      if (isMermaid && !isStreaming) {
        return <MermaidDiagram code={String(children).replace(/\n$/, "")} />;
      }
      return (
        <code className={className} {...props}>
          {children as ReactNode}
        </code>
      );
    },
  };
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

function StreamingMessageImpl({ role, content, isStreaming, model }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  // Keep-latest-visible while streaming. We coalesce back-to-back chunks into
  // a single rAF, but we MUST reset the pending flag in the cleanup path —
  // otherwise React cancels the in-flight rAF before its callback runs, the
  // flag stays `true` forever, and every subsequent effect returns early
  // without scheduling a new scroll. Net effect: text streams into the DOM
  // but the viewport never follows, making it look like the bubble is empty.
  const scrollPendingRef = useRef(false);
  useEffect(() => {
    if (scrollPendingRef.current) return;
    scrollPendingRef.current = true;
    const raf = requestAnimationFrame(() => {
      scrollPendingRef.current = false;
      ref.current?.scrollIntoView({ block: "end" });
    });
    return () => {
      cancelAnimationFrame(raf);
      scrollPendingRef.current = false;
    };
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
              className={`${pillClass(model)} inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider`}
              title={`Response from ${pillLabel(model)}`}
            >
              <span
                aria-hidden
                className="msg-pill-dot inline-block w-1.5 h-1.5 rounded-full"
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
          <StreamedMarkdown content={content} isStreaming={!!isStreaming} />
        )}
      </div>
    </div>
  );
}

/**
 * Wraps ReactMarkdown so we can memoize on `(content, isStreaming)` —
 * siblings re-rendering (e.g. a new chunk in the LAST message) no longer
 * force finished messages to re-parse their entire markdown tree.
 *
 * Also memoizes the `components` map so ReactMarkdown doesn't see a fresh
 * Components object each render and rebuild its internal renderer.
 */
const StreamedMarkdown = memo(
  function StreamedMarkdown({
    content,
    isStreaming,
  }: {
    content: string;
    isStreaming: boolean;
  }) {
    const components = useMemo(
      () => markdownComponents(isStreaming),
      [isStreaming],
    );
    const text = isStreaming ? sanitizeStreamingMarkdown(content) : content;
    return (
      <div className={isStreaming ? "is-streaming" : undefined}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkMath]}
          rehypePlugins={[rehypeKatex]}
          components={components}
        >
          {text}
        </ReactMarkdown>
      </div>
    );
  },
);

/**
 * Re-render the bubble only when content, streaming state, model, or role
 * actually changes. Without this, every chunk in the *latest* message
 * re-renders every prior message too — each one re-parsing its own markdown
 * and re-running katex, which is the second-largest source of streaming
 * jank after the scroll mask.
 */
export const StreamingMessage = memo(
  StreamingMessageImpl,
  (prev, next) =>
    prev.role === next.role &&
    prev.content === next.content &&
    prev.isStreaming === next.isStreaming &&
    prev.model === next.model,
);
