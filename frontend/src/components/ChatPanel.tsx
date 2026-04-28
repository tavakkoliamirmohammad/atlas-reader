import { useEffect, useRef, useState } from "react";
import { useMatch } from "react-router-dom";
import { ChevronDown, ChevronRight, Trash2 } from "lucide-react";
import {
  type ChatMessage,
  type CodexModelInfo,
  type Paper,
  api,
  clearConversation,
  fetchConversations,
  getCodexModels,
  streamAsk,
  streamSummary,
} from "@/lib/api";
import { StreamingMessage } from "./StreamingMessage";
import { QuickActionChips } from "./QuickActionChips";
import { Glossary } from "./Glossary";
import { useUiStore, type ModelChoice } from "@/stores/ui-store";
import { usePodcastStore } from "@/stores/podcast-store";

const CLAUDE_MODEL_META: Record<ModelChoice, { label: string; tag: string }> = {
  opus:   { label: "Opus",   tag: "deepest"  },
  sonnet: { label: "Sonnet", tag: "balanced" },
  haiku:  { label: "Haiku",  tag: "fastest"  },
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

  // Fall back to the raw slug while options are still loading.
  const labelOf = (m: T): string => meta[m]?.label ?? m;
  const tagOf = (m: T): string => meta[m]?.tag ?? "";

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        aria-label="Model"
        aria-expanded={open}
        className="model-pill inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] hover:border-[color:var(--ac1-mid)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
      >
        <span className="w-1.5 h-1.5 rounded-full" style={{ background: "var(--ac1)" }} />
        <span>{labelOf(model)}</span>
        <svg width="9" height="9" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
          <path d="M3 4.5l3 3 3-3" />
        </svg>
      </button>
      {open && (
        <div
          className="absolute bottom-full left-0 mb-1.5 w-56 max-h-[55vh] overflow-y-auto rounded-xl backdrop-blur-md shadow-2xl z-30 divide-y divide-white/5"
          role="listbox"
          style={{
            background: "var(--surface-overlay)",
            border: "1px solid var(--surface-overlay-border)",
            color: "var(--surface-overlay-text)",
          }}
        >
          {options.map((m) => {
            const active = m === model;
            const description = tagOf(m);
            return (
              <button
                key={m}
                type="button"
                role="option"
                aria-selected={active}
                onClick={() => { onChange(m); setOpen(false); }}
                className={[
                  "w-full flex items-start gap-2 px-2.5 py-2 text-left",
                  "hover:bg-white/5 transition-colors cursor-pointer",
                  active ? "bg-[color:var(--ac1-soft)]" : "",
                ].join(" ")}
              >
                <span
                  className="mt-1 shrink-0 w-1 h-1 rounded-full"
                  style={{ background: active ? "var(--ac1)" : "rgb(100 116 139)" }}
                />
                <span className="flex-1 min-w-0 flex flex-col leading-tight">
                  <span
                    className={[
                      "text-[11px] truncate",
                      active ? "text-slate-100 font-medium" : "text-slate-200",
                    ].join(" ")}
                  >
                    {labelOf(m)}
                  </span>
                  {description && (
                    <span className="mt-1 text-[10px] leading-snug text-slate-400 break-words">
                      {description}
                    </span>
                  )}
                </span>
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

  const [tts_available, setTtsAvailable] = useState(true);
  const [paperTitle, setPaperTitle] = useState<string>("");

  // One-shot health check to detect whether the TTS sidecar is running.
  useEffect(() => {
    api.health().then((h) => setTtsAvailable(!!h.tts)).catch(() => {});
  }, []);

  // Fetch paper metadata so we can pass the title to the podcast store.
  useEffect(() => {
    if (!arxivId) return;
    api.paper(arxivId).then((p: Paper) => setPaperTitle(p.title)).catch(() => {});
  }, [arxivId]);

  // Discover codex models from `~/.codex/models_cache.json` via the backend.
  // Only fetched when codex is the active backend; the picker won't render
  // for any other state. If the persisted `codexModel` no longer appears in
  // the fetched list (model retired, fresh install, etc.), swap to the first
  // by codex's own priority order.
  const [codexModels, setCodexModels] = useState<CodexModelInfo[]>([]);
  useEffect(() => {
    if (backend !== "codex") return;
    let cancelled = false;
    getCodexModels()
      .then((list) => {
        if (cancelled || list.length === 0) return;
        setCodexModels(list);
        if (!list.some((m) => m.slug === codexModel)) {
          setCodexModel(list[0].slug);
        }
      })
      .catch(() => { /* picker just stays empty; user shouldn't reach here */ });
    return () => { cancelled = true; };
    // codexModel isn't a dep — we only want to re-fetch on backend switch,
    // and we read codexModel inside via the closure for the swap check.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend]);
  const summarizeRequestId = useUiStore((s) => s.summarizeRequestId);
  const askRequest = useUiStore((s) => s.askRequest);
  const pinnedQuote = useUiStore((s) => s.pinnedQuote);
  const clearPinnedQuote = useUiStore((s) => s.clearPinnedQuote);
  const chipsCollapsed = useUiStore((s) => s.chipsCollapsed);
  const toggleChipsCollapsed = useUiStore((s) => s.toggleChipsCollapsed);

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
    void send(askRequest.prompt, askRequest.displayLabel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [askRequest]);

  if (!arxivId) {
    return (
      <div className="flex items-center justify-center h-full text-slate-400 text-sm px-6 text-center">
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

  /**
   * @param overridePrompt — the full text sent to the LLM. When omitted, the
   *   textarea draft is used.
   * @param displayAs — optional short label to render as the user's chat
   *   bubble in place of the full prompt. Used by quick-action chips so the
   *   chat shows "Flow diagram" instead of the 8-line instruction block.
   *   The actual payload to the model is still `overridePrompt`.
   */
  async function send(overridePrompt?: string, displayAs?: string) {
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
    const userBubble = displayAs?.trim() || question;
    setMessages((m) => [
      ...m,
      { role: "user", content: userBubble },
      { role: "assistant", content: "", model: activeModel },
    ]);
    setStreaming(true);
    abortRef.current = new AbortController();
    try {
      await streamAsk(
        arxivId, question, historyForBackend,
        {
          onChunk: appendChunk,
          onDone: () => setStreaming(false),
          onError: (e) => { appendChunk(`\n\n[error: ${e}]`); setStreaming(false); },
        },
        abortRef.current.signal,
        backend === "claude" ? model : codexModel,
        backend,
        displayAs?.trim() || undefined,
      );
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

  function quickAsk(prompt: string, displayLabel?: string) {
    void send(prompt, displayLabel);
  }

  function handleListen(length: "short" | "medium" | "long") {
    if (!arxivId) return;
    void usePodcastStore.getState().generate({
      arxiv_id: arxivId,
      length,
      paperTitle: paperTitle || arxivId,
      backend,
      model: backend === "claude" ? model : codexModel,
    });
  }

  return (
    <div className="flex flex-col h-full">
      <Glossary arxivId={arxivId} />
      <div className="px-3 py-2.5">
        <div className="flex items-center justify-between mb-1.5">
          <button
            type="button"
            onClick={toggleChipsCollapsed}
            aria-expanded={!chipsCollapsed}
            aria-controls="chat-quick-actions"
            title={chipsCollapsed ? "Show quick actions" : "Hide quick actions"}
            className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider text-slate-400 hover:text-slate-200 cursor-pointer transition-colors focus-visible:outline-none focus-visible:text-slate-200"
          >
            {chipsCollapsed
              ? <ChevronRight size={11} aria-hidden />
              : <ChevronDown size={11} aria-hidden />}
            Quick actions
          </button>
          {messages.length > 0 && (
            <button
              type="button"
              onClick={clearHistory}
              disabled={streaming}
              aria-label="Clear chat history for this paper"
              title="Clear chat history"
              className="inline-flex items-center gap-1 text-[10px] text-slate-400 hover:text-rose-300 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors"
            >
              <Trash2 size={11} /> Clear
            </button>
          )}
        </div>
        {!chipsCollapsed && (
          <div id="chat-quick-actions">
            <QuickActionChips
              onSummarize={summarize}
              onQuickAsk={quickAsk}
              disabled={streaming}
              summarizeElapsedMs={
                summarizeStartedAt !== null ? nowMs - summarizeStartedAt : null
              }
              onListen={handleListen}
              listenDisabledReason={
                !tts_available
                  ? "TTS service offline. Run `atlas up` to start it."
                  : undefined
              }
            />
          </div>
        )}
      </div>
      <div
        className="flex-1 overflow-y-auto px-3 flex flex-col gap-2"
        style={{
          // Only the top fades — the bottom mask caused streaming text to
          // flicker as it stepped through a 24px opacity gradient on every
          // chunk. The input area below already provides visual separation.
          WebkitMaskImage:
            "linear-gradient(to bottom, transparent 0, black 40px, black 100%)",
          maskImage:
            "linear-gradient(to bottom, transparent 0, black 40px, black 100%)",
          paddingTop: 40,
          paddingBottom: 16,
          scrollPaddingBottom: 24,
        }}
      >
        {messages.length === 0 && !streaming && (
          <div className="text-xs text-slate-400 text-center mt-8">
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
            "glass-subtle flex flex-col gap-2 rounded-2xl px-3 pt-3 pb-2",
            "transition-[border-color,box-shadow] duration-200",
            "focus-within:border-[color:var(--ac1-mid)]",
            "focus-within:shadow-[inset_0_1px_0_var(--glass-rim),0_0_24px_-8px_var(--ac1-mid)]",
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
                className="text-slate-400 hover:text-slate-200 cursor-pointer"
              >
                ✕
              </button>
            </div>
          )}
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // Enter sends; Shift+Enter (or any IME composition) inserts a
              // newline. Cmd/Ctrl+Enter still sends as a power-user fallback.
              if (e.key !== "Enter") return;
              if (e.shiftKey || e.nativeEvent.isComposing) return;
              e.preventDefault();
              send();
            }}
            placeholder="Ask anything about this paper…"
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
                options={codexModels.map((m) => m.slug)}
                meta={Object.fromEntries(
                  codexModels.map((m) => [m.slug, { label: m.label, tag: m.description }]),
                ) as Record<string, { label: string; tag: string }>}
                onChange={setCodexModel}
                disabled={streaming || codexModels.length === 0}
              />
            )}
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-slate-400 hidden sm:inline">
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
