import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import {
  type ChatMessage,
  fetchConversations,
  streamAsk,
  streamSummary,
} from "@/lib/api";
import { StreamingMessage } from "./StreamingMessage";
import { QuickActionChips } from "./QuickActionChips";

export function ChatPanel() {
  const { arxivId } = useParams<{ arxivId: string }>();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [draft, setDraft] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!arxivId) return;
    fetchConversations(arxivId).then(setMessages).catch(() => setMessages([]));
    return () => { abortRef.current?.abort(); };
  }, [arxivId]);

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

  async function send() {
    if (!arxivId || !draft.trim() || streaming) return;
    const question = draft.trim();
    const historyForBackend = messages;
    setDraft("");
    setMessages((m) => [...m, { role: "user", content: question }, { role: "assistant", content: "" }]);
    setStreaming(true);
    abortRef.current = new AbortController();
    try {
      await streamAsk(arxivId, question, historyForBackend, {
        onChunk: appendChunk,
        onDone: () => setStreaming(false),
        onError: (e) => { appendChunk(`\n\n[error: ${e}]`); setStreaming(false); },
      }, abortRef.current.signal);
    } catch (e) {
      setStreaming(false);
    }
  }

  async function summarize() {
    if (!arxivId || streaming) return;
    setMessages((m) => [...m, { role: "assistant", content: "" }]);
    setStreaming(true);
    abortRef.current = new AbortController();
    try {
      await streamSummary(arxivId, {
        onChunk: appendChunk,
        onDone: () => setStreaming(false),
        onError: (e) => { appendChunk(`\n\n[error: ${e}]`); setStreaming(false); },
      }, abortRef.current.signal);
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
            isStreaming={streaming && i === messages.length - 1 && m.role === "assistant"}
          />
        ))}
      </div>
      <div className="px-3 py-2.5 border-t border-white/5">
        <div className="flex items-end gap-1.5 bg-white/[0.04] border border-white/5 rounded-xl px-2.5 py-1.5 focus-within:border-[color:var(--ac1-mid)]">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); }
            }}
            placeholder="Ask anything about this paper... (Cmd+Enter to send)"
            disabled={streaming}
            rows={2}
            className="flex-1 bg-transparent border-0 outline-none text-[13px] text-slate-200 placeholder:text-slate-500 resize-none disabled:opacity-50"
          />
          <button
            onClick={send}
            disabled={streaming || !draft.trim()}
            className="px-2.5 py-1 rounded-md text-[12px] font-semibold disabled:opacity-50 cursor-pointer transition-all hover:translate-y-[-1px]"
            style={{ background: "var(--user-grad)", color: "var(--user-ink)" }}
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
