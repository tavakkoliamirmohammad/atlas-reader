import { useEffect, useRef, useState } from "react";
import { useMatch } from "react-router-dom";
import { ChevronDown, ChevronRight, Trash2 } from "lucide-react";
import {
  type ChatMessage,
  type Paper,
  api,
  clearConversation,
  fetchConversations,
  streamAsk,
  streamSummary,
} from "@/lib/api";
import { StreamingMessage } from "./StreamingMessage";
import { QuickActionChips } from "./QuickActionChips";
import { Glossary } from "./Glossary";
import { BackendModelPicker, useCodexModels } from "./ModelPicker";
import { useUiStore } from "@/stores/ui-store";
import { useUiActionsStore } from "@/stores/ui-actions-store";
import { usePodcastStore } from "@/stores/podcast-store";

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

  const codexModels = useCodexModels(backend === "codex", codexModel, setCodexModel);
  const summarizeRequestId = useUiActionsStore((s) => s.summarizeRequestId);
  const askRequest = useUiActionsStore((s) => s.askRequest);
  const pinnedQuote = useUiActionsStore((s) => s.pinnedQuote);
  const clearPinnedQuote = useUiActionsStore((s) => s.clearPinnedQuote);
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
            <BackendModelPicker
              backend={backend}
              claudeModel={model}
              codexModel={codexModel}
              codexModels={codexModels}
              onClaudeChange={setModel}
              onCodexChange={setCodexModel}
              disabled={streaming}
            />
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
