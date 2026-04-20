import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { searchPapers, type SearchResult } from "@/lib/api";

type Props = { open: boolean; onClose: () => void };

const ALLOWED_TAGS = new Set(["mark"]);

/**
 * Render an FTS5 snippet that contains <mark>...</mark> tags as React nodes.
 * Strips any other HTML for safety.
 */
function renderSnippet(snippet: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  const re = /<\/?([a-zA-Z]+)>/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let inMark = false;
  let buffer = "";

  const flush = (key: number) => {
    if (!buffer) return;
    if (inMark) {
      parts.push(
        <mark
          key={`m-${key}`}
          className="rounded bg-[var(--accent-fg)]/30 px-0.5 text-[var(--accent-fg)]"
        >
          {buffer}
        </mark>,
      );
    } else {
      parts.push(<span key={`t-${key}`}>{buffer}</span>);
    }
    buffer = "";
  };

  while ((match = re.exec(snippet)) !== null) {
    buffer += snippet.slice(last, match.index);
    const tag = match[1].toLowerCase();
    const closing = match[0].startsWith("</");
    if (ALLOWED_TAGS.has(tag)) {
      flush(match.index);
      inMark = !closing;
    } else {
      buffer += match[0];
    }
    last = match.index + match[0].length;
  }
  buffer += snippet.slice(last);
  flush(snippet.length);
  return parts;
}

export function SearchPalette({ open, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  // Remember which element was focused so we can restore focus on close —
  // otherwise focus falls back to <body> and keyboard users lose their place.
  const priorFocusRef = useRef<HTMLElement | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (open) {
      priorFocusRef.current = document.activeElement as HTMLElement | null;
      setQuery("");
      setResults([]);
      setActive(0);
      requestAnimationFrame(() => inputRef.current?.focus());
      return () => {
        const prior = priorFocusRef.current;
        if (prior && typeof prior.focus === "function" && document.contains(prior)) {
          prior.focus();
        }
      };
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (!q) {
      setResults([]);
      setLoading(false);
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    const t = setTimeout(() => {
      searchPapers(q, 20, ctrl.signal)
        .then((r) => {
          setResults(r);
          setActive(0);
        })
        .catch((e) => {
          if ((e as Error).name !== "AbortError") setResults([]);
        })
        .finally(() => setLoading(false));
    }, 120);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [query, open]);

  const select = useMemo(
    () => (r: SearchResult) => {
      navigate(`/reader/${r.arxiv_id}`);
      onClose();
    },
    [navigate, onClose],
  );

  if (!open) return null;

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, Math.max(0, results.length - 1)));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const r = results[active];
      if (r) select(r);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 backdrop-blur-sm pt-[12vh]"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Search papers"
      onKeyDown={onKeyDown}
    >
      <div
        className="w-[min(720px,94vw)] overflow-hidden rounded-2xl border border-white/10 bg-zinc-900/95 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-zinc-500"
            aria-hidden
          >
            <circle cx="11" cy="11" r="7" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search papers (title, authors, abstract)..."
            className="flex-1 bg-transparent text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
          />
          <span className="text-[10px] uppercase tracking-wider text-zinc-500">
            {loading ? "..." : results.length ? `${results.length}` : ""}
          </span>
        </div>

        <ul
          ref={listRef}
          className="max-h-[60vh] overflow-y-auto p-2"
          role="listbox"
          aria-label="Search results"
        >
          {results.length === 0 && query.trim() && !loading ? (
            <li className="p-4 text-sm text-zinc-500">No matches.</li>
          ) : null}

          {results.length === 0 && !query.trim() ? (
            <li className="p-4 text-sm text-zinc-500">
              Type to search across all cached papers.
            </li>
          ) : null}

          {results.map((r, i) => {
            const selected = i === active;
            return (
              <li key={r.arxiv_id} role="option" aria-selected={selected}>
                <button
                  type="button"
                  onMouseEnter={() => setActive(i)}
                  onClick={() => select(r)}
                  className={[
                    "w-full rounded px-3 py-2 text-left transition-colors",
                    selected ? "bg-white/10" : "hover:bg-white/5",
                  ].join(" ")}
                >
                  <div className="flex items-baseline gap-2">
                    <span className="font-semibold text-zinc-100">{r.title}</span>
                    <span className="ml-auto shrink-0 font-mono text-xs text-zinc-500">
                      {r.arxiv_id}
                    </span>
                  </div>
                  <div className="truncate text-xs text-zinc-400">{r.authors}</div>
                  {r.snippet ? (
                    <div className="mt-1 text-xs leading-snug text-zinc-300">
                      {renderSnippet(r.snippet)}
                    </div>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>

        <div className="flex items-center justify-between border-t border-white/10 px-4 py-2 text-[10px] text-zinc-500">
          <span>
            <kbd className="rounded bg-zinc-800 px-1 py-0.5">/</kbd> open
            <span className="mx-2">|</span>
            <kbd className="rounded bg-zinc-800 px-1 py-0.5">Up</kbd>{" "}
            <kbd className="rounded bg-zinc-800 px-1 py-0.5">Down</kbd> navigate
            <span className="mx-2">|</span>
            <kbd className="rounded bg-zinc-800 px-1 py-0.5">Enter</kbd> open paper
          </span>
          <span>
            <kbd className="rounded bg-zinc-800 px-1 py-0.5">Esc</kbd> close
          </span>
        </div>
      </div>
    </div>
  );
}
