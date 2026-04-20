import { useEffect, useRef, useState } from "react";
import { useMatch } from "react-router-dom";
import {
  type ChatMessage,
  type Thread,
  createThread,
  fetchThreads,
  streamAsk,
  streamSummary,
} from "@/lib/api";
import { StreamingMessage } from "./StreamingMessage";
import { QuickActionChips } from "./QuickActionChips";
import { Glossary } from "./Glossary";
import { useUiStore, type ModelChoice } from "@/stores/ui-store";

const DEFAULT_THREAD_ID = 1;

const MODEL_META: Record<ModelChoice, { label: string; tag: string }> = {
  opus:   { label: "Opus",   tag: "deepest"  },
  sonnet: { label: "Sonnet", tag: "balanced" },
  haiku:  { label: "Haiku",  tag: "fastest"  },
};

function ModelPicker({
  model, onChange, disabled,
}: { model: ModelChoice; onChange: (m: ModelChoice) => void; disabled?: boolean }) {
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
        <span>{MODEL_META[model].label}</span>
        <svg width="9" height="9" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
          <path d="M3 4.5l3 3 3-3" />
        </svg>
      </button>
      {open && (
        <div
          className="absolute bottom-full left-0 mb-1.5 w-44 rounded-xl bg-zinc-900/95 backdrop-blur-md border border-white/10 shadow-2xl overflow-hidden z-30"
          role="listbox"
        >
          {(["opus", "sonnet", "haiku"] as ModelChoice[]).map((m) => {
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
                    {MODEL_META[m].label}
                  </span>
                </span>
                <span className="text-[10px] text-slate-500">{MODEL_META[m].tag}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ThreadTabs({
  threads, activeId, onSwitch, onNew, disabled,
}: {
  threads: Thread[];
  activeId: number;
  onSwitch: (id: number) => void;
  onNew: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-end gap-0.5 px-3 pt-1.5 border-b border-white/5 overflow-x-auto">
      {threads.map((t) => {
        const active = t.id === activeId;
        const truncated = t.title.length > 18 ? t.title.slice(0, 17) + "\u2026" : t.title;
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => onSwitch(t.id)}
            disabled={disabled}
            title={t.title}
            aria-selected={active}
            role="tab"
            className={[
              "px-2.5 py-1 text-[11px] font-medium whitespace-nowrap cursor-pointer",
              "transition-colors disabled:opacity-40 disabled:cursor-not-allowed",
              "border-b-2",
              active
                ? "text-slate-100 border-[color:var(--ac1-mid)]"
                : "text-slate-500 border-transparent hover:text-slate-300",
            ].join(" ")}
          >
            {truncated}
          </button>
        );
      })}
      <button
        type="button"
        onClick={onNew}
        disabled={disabled}
        aria-label="New conversation"
        title="New conversation"
        className="px-2 py-1 text-[11px] font-semibold text-slate-400 hover:text-slate-100 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed border-b-2 border-transparent"
      >
        + New
      </button>
    </div>
  );
}

export function ChatPanel() {
  // useMatch climbs the URL directly, so this works even though ChatPanel
  // lives outside the <Routes> block (where useParams would return empty).
  const match = useMatch("/reader/:arxivId");
  const arxivId = match?.params.arxivId;
  // Per-thread message lists. Ephemeral: lives only in React state.
  // Switching tabs swaps which list is shown; switching papers clears them all.
  const [messagesByThread, setMessagesByThread] = useState<Record<number, ChatMessage[]>>({
    [DEFAULT_THREAD_ID]: [],
  });
  const [threads, setThreads] = useState<Thread[]>([
    { id: DEFAULT_THREAD_ID, arxiv_id: "", title: "Conversation", created_at: null },
  ]);
  const [activeThreadId, setActiveThreadId] = useState<number>(DEFAULT_THREAD_ID);
  const [streaming, setStreaming] = useState(false);
  const [draft, setDraft] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const model = useUiStore((s) => s.model);
  const setModel = useUiStore((s) => s.setModel);

  const messages = messagesByThread[activeThreadId] ?? [];

  // On paper switch: wipe ephemeral messages, load thread list, default to thread 1.
  // Per user privacy preference, no chat history is persisted anywhere.
  useEffect(() => {
    if (!arxivId) return;
    setMessagesByThread({ [DEFAULT_THREAD_ID]: [] });
    setActiveThreadId(DEFAULT_THREAD_ID);
    fetchThreads(arxivId)
      .then((ts) => {
        setThreads(ts.length ? ts : [
          { id: DEFAULT_THREAD_ID, arxiv_id: arxivId, title: "Conversation", created_at: null },
        ]);
      })
      .catch(() => {
        setThreads([
          { id: DEFAULT_THREAD_ID, arxiv_id: arxivId, title: "Conversation", created_at: null },
        ]);
      });
    return () => { abortRef.current?.abort(); };
  }, [arxivId]);

  if (!arxivId) {
    return (
      <div className="flex items-center justify-center h-full text-slate-500 text-sm px-6 text-center">
        Open a paper to start chatting.
      </div>
    );
  }

  function setMessagesForActive(updater: (prev: ChatMessage[]) => ChatMessage[]) {
    setMessagesByThread((all) => {
      const prev = all[activeThreadId] ?? [];
      return { ...all, [activeThreadId]: updater(prev) };
    });
  }

  function appendChunk(chunk: string) {
    setMessagesForActive((prev) => {
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

  async function send() {
    if (!arxivId || !draft.trim() || streaming) return;
    const question = draft.trim();
    const historyForBackend = messages;
    const threadIdAtSend = activeThreadId;
    setDraft("");
    setMessagesForActive((m) => [
      ...m,
      { role: "user", content: question },
      { role: "assistant", content: "", model },
    ]);
    setStreaming(true);
    abortRef.current = new AbortController();
    try {
      await streamAsk(arxivId, question, historyForBackend, {
        onChunk: appendChunk,
        onDone: () => setStreaming(false),
        onError: (e) => { appendChunk(`\n\n[error: ${e}]`); setStreaming(false); },
      }, abortRef.current.signal, model, threadIdAtSend);
    } catch (e) {
      setStreaming(false);
    }
  }

  async function summarize() {
    if (!arxivId || streaming) return;
    setMessagesForActive((m) => [...m, { role: "assistant", content: "", model }]);
    setStreaming(true);
    abortRef.current = new AbortController();
    try {
      await streamSummary(arxivId, {
        onChunk: appendChunk,
        onDone: () => setStreaming(false),
        onError: (e) => { appendChunk(`\n\n[error: ${e}]`); setStreaming(false); },
      }, abortRef.current.signal, model);
    } catch (e) {
      setStreaming(false);
    }
  }

  function quickAsk(prompt: string) {
    setDraft(prompt);
    setTimeout(() => {
      send();
    }, 0);
  }

  async function newThread() {
    if (!arxivId || streaming) return;
    const nextNumber = threads.length + 1;
    const title = `Conversation ${nextNumber}`;
    try {
      const t = await createThread(arxivId, title);
      setThreads((prev) => [...prev, t]);
      setMessagesByThread((all) => ({ ...all, [t.id]: [] }));
      setActiveThreadId(t.id);
    } catch {
      // Fail silently; the user can retry.
    }
  }

  function switchThread(id: number) {
    if (id === activeThreadId || streaming) return;
    abortRef.current?.abort();
    setActiveThreadId(id);
    setMessagesByThread((all) => (all[id] ? all : { ...all, [id]: [] }));
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-white/5">
        <div
          className="w-[30px] h-[30px] rounded-lg flex items-center justify-center text-sm font-bold"
          style={{ background: "var(--user-grad)", color: "var(--user-ink)", boxShadow: "0 0 18px var(--ac1-mid)" }}
        >
          C
        </div>
        <div className="font-semibold text-[15px] text-slate-100">Ask about this paper</div>
      </div>
      <Glossary arxivId={arxivId} />
      <ThreadTabs
        threads={threads}
        activeId={activeThreadId}
        onSwitch={switchThread}
        onNew={newThread}
        disabled={streaming}
      />
      <div className="px-3 py-2.5 border-b border-white/5">
        <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1.5">Quick actions</div>
        <QuickActionChips onSummarize={summarize} onQuickAsk={quickAsk} disabled={streaming} />
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-3 flex flex-col gap-2">
        {messages.length === 0 && !streaming && (
          <div className="text-xs text-slate-500 text-center mt-8">
            Click ⚡ Summarize for a structured deep summary,<br />or ask anything about the paper below.
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
            <ModelPicker model={model} onChange={setModel} disabled={streaming} />
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-slate-500 hidden sm:inline">
                <kbd className="px-1 py-px border border-white/10 rounded font-mono text-[9px]">⌘</kbd>
                <kbd className="ml-0.5 px-1 py-px border border-white/10 rounded font-mono text-[9px]">↵</kbd>
              </span>
              <button
                onClick={send}
                disabled={streaming || !draft.trim()}
                aria-label="Send"
                className={[
                  "h-8 w-8 rounded-full flex items-center justify-center",
                  "disabled:opacity-30 disabled:cursor-not-allowed",
                  "cursor-pointer transition-all duration-200",
                  draft.trim() && !streaming
                    ? "hover:scale-110 shadow-[0_0_16px_var(--ac1-mid)]"
                    : "",
                ].join(" ")}
                style={{
                  background: draft.trim() && !streaming ? "var(--user-grad)" : "rgba(255,255,255,0.06)",
                  color: draft.trim() && !streaming ? "var(--user-ink)" : "rgb(148 163 184)",
                }}
              >
                {streaming ? (
                  <span className="block w-2 h-2 rounded-sm bg-current" aria-hidden />
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
