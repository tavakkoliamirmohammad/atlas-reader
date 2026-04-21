import { useEffect, useRef, useState } from "react";
import { useMatch } from "react-router-dom";
import { Trash2 } from "lucide-react";
import {
  type ChatMessage,
  CODEX_MODEL_OPTIONS,
  clearConversation,
  fetchConversations,
  streamAsk,
  streamSummary,
} from "@/lib/api";
import { StreamingMessage } from "./StreamingMessage";
import { QuickActionChips } from "./QuickActionChips";
import { Glossary } from "./Glossary";
import { useUiStore, type CodexModel, type ModelChoice } from "@/stores/ui-store";

const CLAUDE_MODEL_META: Record<ModelChoice, { label: string; tag: string }> = {
  opus:   { label: "Opus",   tag: "deepest"  },
  sonnet: { label: "Sonnet", tag: "balanced" },
  haiku:  { label: "Haiku",  tag: "fastest"  },
};

const CODEX_MODEL_META: Record<CodexModel, { label: string; tag: string }> = {
  "gpt-5.4":            { label: "GPT-5.4",           tag: "current"  },
  "gpt-5.4-mini":       { label: "GPT-5.4 mini",      tag: "smaller"  },
  "gpt-5.3-codex":      { label: "GPT-5.3 Codex",     tag: "codex"    },
  "gpt-5.2":            { label: "GPT-5.2",           tag: "long-run" },
  "gpt-5.2-codex":      { label: "GPT-5.2 Codex",     tag: "codex"    },
  "gpt-5.1-codex-max":  { label: "GPT-5.1 Codex Max", tag: "reasoning"},
  "gpt-5.1-codex-mini": { label: "GPT-5.1 Codex mini",tag: "cheap"    },
};

type GenericPickerProps<T extends string> = {
  model: T;
  options: T[];
  meta: Record<T, { label: string; tag: string }>;
  onChange: (m: T) => void;
  disabled?: boolean;
};

function GenericModelPicker<T extends string>({
  model, options, meta, onChange, disabled,
}: GenericPickerProps<T>) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        aria-label="Model"
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] text-slate-300 bg-white/[0.04] border border-white/5 hover:border-[color:var(--ac1-mid)] hover:text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
      >
        <span className="w-1.5 h-1.5 rounded-full" style={{ background: "var(--ac1)" }} />
        <span>{meta[model].label}</span>
        <svg width="9" height="9" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
          <path d="M3 4.5l3 3 3-3" />
        </svg>
      </button>
      {open && (
        <div
          className="absolute bottom-full left-0 mb-1.5 w-44 rounded-xl backdrop-blur-md shadow-2xl overflow-hidden z-30"
          role="listbox"
          style={{
            background: "var(--surface-overlay)",
            border: "1px solid var(--surface-overlay-border)",
            color: "var(--surface-overlay-text)",
          }}
        >
          {options.map((m) => {
            const active = m === model;
            return (
              <button
                key={m}
                type="button"
                role="option"
                aria-selected={active}
                onClick={() => { onChange(m); setOpen(false); }}
                className={[
                  "w-full flex items-center justify-between px-3 py-2 text-left text-[12px]",
                  "hover:bg-white/5 transition-colors cursor-pointer",
                  active ? "bg-[color:var(--ac1-soft)]" : "",
                ].join(" ")}
              >
                <span className="flex items-center gap-2">
                  <span
                    className="w-1.5 h-1.5 rounded-full"
                    style={{ background: active ? "var(--ac1)" : "rgb(100 116 139)" }}
                  />
                  <span className={active ? "text-slate-100 font-medium" : "text-slate-300"}>
                    {meta[m].label}
                  </span>
                </span>
                <span className="text-[10px] text-slate-500">{meta[m].tag}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function ChatPanel() {
  // useMatch climbs the URL directly, so this works even though ChatPanel
  // lives outside the <Routes> block (where useParams would return empty).
  const match = useMatch("/reader/:arxivId");
  const arxivId = match?.params.arxivId;
  // Single ephemeral conversation in React state. Per user privacy preference,
  // no chat history is persisted anywhere — switching papers wipes it.
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [draft, setDraft] = useState("");
  const [summarizeStartedAt, setSummarizeStartedAt] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const abortRef = useRef<AbortController | null>(null);
  const model = useUiStore((s) => s.model);
  const setModel = useUiStore((s) => s.setModel);
  const codexModel = useUiStore((s) => s.codexModel);
  const setCodexModel = useUiStore((s) => s.setCodexModel);
  const backend = useUiStore((s) => s.backend);
  const summarizeRequestId = useUiStore((s) => s.summarizeRequestId);
  const askRequest = useUiStore((s) => s.askRequest);
  const pinnedQuote = useUiStore((s) => s.pinnedQuote);
  const clearPinnedQuote = useUiStore((s) => s.clearPinnedQuote);

  // On paper switch, hydrate the chat from the persisted history for the
  // new paper. The backend writes each turn after streaming completes, so
  // closing the tab / switching papers / restarting the container all
  // resume the thread where the user left off.
  useEffect(() => {
    if (!arxivId) return;
    let cancelled = false;
    setMessages([]);
    fetchConversations(arxivId)
      .then((history) => { if (!cancelled) setMessages(history); })
      .catch(() => { /* empty state is fine */ });
    return () => {
      cancelled = true;
      abortRef.current?.abort();
    };
  }, [arxivId]);

  async function clearHistory() {
    if (!arxivId || streaming) return;
    const ok = window.confirm(
      "Clear this paper's chat history? This can't be undone.",
    );
    if (!ok) return;
    try {
      await clearConversation(arxivId);
      setMessages([]);
    } catch {
      // Fail-soft: keep local state as-is if the server rejected.
    }
  }

  // Clear the summarize elapsed-timer the moment streaming stops.
  useEffect(() => {
    if (!streaming && summarizeStartedAt !== null) {
      setSummarizeStartedAt(null);
    }
  }, [streaming, summarizeStartedAt]);

  // Tick at 1Hz while a summarize is in flight so the chip can show live seconds.
  useEffect(() => {
    if (summarizeStartedAt === null) return;
    setNowMs(Date.now());
    const iv = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(iv);
  }, [summarizeStartedAt]);

  // External summarize trigger — fires when command-palette or `s` shortcut
  // increments summarizeRequestId. Skip the initial 0 so we don't auto-fire.
  useEffect(() => {
    if (!arxivId || streaming) return;
    if (summarizeRequestId === 0) return;
    void summarize();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summarizeRequestId]);

  // External ask trigger — sends the prompt directly (no draft round-trip).
  useEffect(() => {
    if (!arxivId || streaming) return;
    if (!askRequest) return;
    void send(askRequest.prompt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [askRequest]);

  if (!arxivId) {
    return (
      <div className="flex items-center justify-center h-full text-slate-500 text-sm px-6 text-center">
        Open a paper to start chatting.
      </div>
    );
  }

  function appendChunk(chunk: string) {
    setMessages((prev) => {
      const copy = [...prev];
      const last = copy[copy.length - 1];
      if (last && last.role === "assistant") {
        copy[copy.length - 1] = { ...last, content: last.content + chunk };
      } else {
        copy.push({ role: "assistant", content: chunk });
      }
      return copy;
    });
  }

  async function send(overridePrompt?: string) {
    const typed = (overridePrompt ?? draft).trim();
    if (!arxivId || streaming) return;
    if (!typed && !pinnedQuote) return;
    const question = pinnedQuote
      ? `> ${pinnedQuote.text.replace(/\n/g, "\n> ")}\n\n${typed}`.trim()
      : typed;
    if (!question) return;
    const historyForBackend = messages;
    setDraft("");
    clearPinnedQuote();
    const activeModel = backend === "claude" ? model : codexModel;
    setMessages((m) => [
      ...m,
      { role: "user", content: question },
      { role: "assistant", content: "", model: activeModel },
    ]);
    setStreaming(true);
    abortRef.current = new AbortController();
    try {
      await streamAsk(arxivId, question, historyForBackend, {
        onChunk: appendChunk,
        onDone: () => setStreaming(false),
        onError: (e) => { appendChunk(`\n\n[error: ${e}]`); setStreaming(false); },
      }, abortRef.current.signal, backend === "claude" ? model : codexModel, backend);
    } catch {
      setStreaming(false);
    }
  }

  async function summarize() {
    if (!arxivId || streaming) return;
    const activeModel = backend === "claude" ? model : codexModel;
    setMessages((m) => [...m, { role: "assistant", content: "", model: activeModel }]);
    setStreaming(true);
    setSummarizeStartedAt(Date.now());
    abortRef.current = new AbortController();
    try {
      await streamSummary(arxivId, {
        onChunk: appendChunk,
        onDone: () => setStreaming(false),
        onError: (e) => { appendChunk(`\n\n[error: ${e}]`); setStreaming(false); },
      }, abortRef.current.signal, backend === "claude" ? model : codexModel, backend);
    } catch (e) {
      setStreaming(false);
    }
  }

  function quickAsk(prompt: string) {
    void send(prompt);
  }

  return (
    <div className="flex flex-col h-full">
      <Glossary arxivId={arxivId} />
      <div className="px-3 py-2.5 border-b border-white/5">
        <div className="flex items-center justify-between mb-1.5">
          <div className="text-[10px] uppercase tracking-wider text-slate-500">
            Quick actions
          </div>
          {messages.length > 0 && (
            <button
              type="button"
              onClick={clearHistory}
              disabled={streaming}
              aria-label="Clear chat history for this paper"
              title="Clear chat history"
              className="inline-flex items-center gap-1 text-[10px] text-slate-500 hover:text-rose-300 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors"
            >
              <Trash2 size={11} /> Clear
            </button>
          )}
        </div>
        <QuickActionChips
          onSummarize={summarize}
          onQuickAsk={quickAsk}
          disabled={streaming}
          summarizeElapsedMs={
            summarizeStartedAt !== null ? nowMs - summarizeStartedAt : null
          }
        />
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-3 flex flex-col gap-2">
        {messages.length === 0 && !streaming && (
          <div className="text-xs text-slate-500 text-center mt-8">
            Tip:{" "}
            <kbd className="px-1 py-px border border-white/10 rounded font-mono text-[10px]">⌘↵</kbd>{" "}
            send ·{" "}
            <kbd className="px-1 py-px border border-white/10 rounded font-mono text-[10px]">s</kbd>{" "}
            summarize ·{" "}
            <kbd className="px-1 py-px border border-white/10 rounded font-mono text-[10px]">Esc</kbd>{" "}
            stop
          </div>
        )}
        {messages.map((m, i) => (
          <StreamingMessage
            key={i}
            role={m.role as "user" | "assistant"}
            content={m.content}
            model={m.model}
            isStreaming={streaming && i === messages.length - 1 && m.role === "assistant"}
          />
        ))}
      </div>
      <div className="px-3 pb-3 pt-2">
        <div
          className={[
            "flex flex-col gap-2 bg-white/[0.04] border rounded-2xl px-3 pt-3 pb-2",
            "transition-colors duration-200",
            "border-white/5 focus-within:border-[color:var(--ac1-mid)]",
            "focus-within:shadow-[0_0_24px_-8px_var(--ac1-mid)]",
          ].join(" ")}
        >
          {pinnedQuote && (
            <div
              className="rounded-lg bg-white/[0.04] border border-[color:var(--ac1-mid)] px-3 py-2 flex items-start gap-2"
              role="note"
              aria-label="Quote pinned for next question"
            >
              <span
                className="mt-0.5 w-1 self-stretch rounded-full"
                style={{ background: "var(--ac1)" }}
                aria-hidden
              />
              <div className="flex-1 min-w-0">
                <div className="text-[10px] uppercase tracking-wider text-slate-400 mb-0.5">
                  Asking about · p.{pinnedQuote.page}
                </div>
                <div
                  className="text-[12px] text-slate-200 leading-snug overflow-hidden"
                  style={{
                    display: "-webkit-box",
                    WebkitLineClamp: 3,
                    WebkitBoxOrient: "vertical",
                  }}
                  title={pinnedQuote.text}
                >
                  {pinnedQuote.text}
                </div>
              </div>
              <button
                type="button"
                onClick={clearPinnedQuote}
                aria-label="Remove pinned quote"
                className="text-slate-500 hover:text-slate-200 cursor-pointer"
              >
                ✕
              </button>
            </div>
          )}
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); }
            }}
            placeholder="Ask anything about this paper..."
            disabled={streaming}
            rows={3}
            className="bg-transparent border-0 outline-none text-[13px] leading-relaxed text-slate-100 placeholder:text-slate-500 resize-none disabled:opacity-50 min-h-[60px] max-h-[200px]"
          />
          <div className="flex items-center justify-between gap-2">
            {backend === "claude" ? (
              <GenericModelPicker
                model={model}
                options={["opus", "sonnet", "haiku"] as ModelChoice[]}
                meta={CLAUDE_MODEL_META}
                onChange={setModel}
                disabled={streaming}
              />
            ) : (
              <GenericModelPicker
                model={codexModel}
                options={CODEX_MODEL_OPTIONS}
                meta={CODEX_MODEL_META}
                onChange={setCodexModel}
                disabled={streaming}
              />
            )}
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-slate-500 hidden sm:inline">
                <kbd className="px-1 py-px border border-white/10 rounded font-mono text-[9px]">⌘</kbd>
                <kbd className="ml-0.5 px-1 py-px border border-white/10 rounded font-mono text-[9px]">↵</kbd>
              </span>
              <button
                onClick={streaming ? () => abortRef.current?.abort() : () => send()}
                disabled={!streaming && !draft.trim() && !pinnedQuote}
                aria-label={streaming ? "Stop" : "Send"}
                title={streaming ? "Stop generating" : "Send"}
                className={[
                  "h-8 w-8 rounded-full flex items-center justify-center",
                  "disabled:opacity-30 disabled:cursor-not-allowed",
                  "cursor-pointer transition-all duration-200",
                  streaming
                    ? "hover:scale-110 shadow-[0_0_16px_rgba(244,63,94,0.45)]"
                    : (draft.trim() || pinnedQuote)
                    ? "hover:scale-110 shadow-[0_0_16px_var(--ac1-mid)]"
                    : "",
                ].join(" ")}
                style={{
                  background: streaming
                    ? "rgba(244,63,94,0.18)"
                    : (draft.trim() || pinnedQuote)
                    ? "var(--user-grad)"
                    : "rgba(255,255,255,0.06)",
                  color: streaming
                    ? "rgb(251 113 133)"
                    : (draft.trim() || pinnedQuote)
                    ? "var(--user-ink)"
                    : "rgb(148 163 184)",
                  border: streaming ? "1px solid rgba(244,63,94,0.35)" : undefined,
                }}
              >
                {streaming ? (
                  <span className="block w-2.5 h-2.5 rounded-sm bg-current" aria-hidden />
                ) : (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                       strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M5 12l14 0M13 6l6 6-6 6" />
                  </svg>
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
