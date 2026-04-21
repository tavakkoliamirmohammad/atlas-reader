import { Command } from "cmdk";
import { useEffect, useRef, useState } from "react";
import { useMatch, useNavigate } from "react-router-dom";
import { useUiStore, type ReadingMode } from "@/stores/ui-store";
import { PALETTES } from "@/lib/theme";
import { QUICK_PROMPTS } from "@/lib/quick-prompts";

type Paper = { arxiv_id: string; title: string };

type Props = {
  open: boolean;
  onClose: () => void;
  onSearch?: () => void;
  onShowShortcuts?: () => void;
};

export function CommandPalette({ open, onClose, onSearch, onShowShortcuts }: Props) {
  const [papers, setPapers] = useState<Paper[]>([]);
  const navigate = useNavigate();
  const setPalette = useUiStore((s) => s.setPalette);
  const setReadingMode = useUiStore((s) => s.setReadingMode);
  const cycleReadingMode = useUiStore((s) => s.cycleReadingMode);
  const toggleLeft = useUiStore((s) => s.toggleLeft);
  const toggleRight = useUiStore((s) => s.toggleRight);
  const requestSummarize = useUiStore((s) => s.requestSummarize);
  const requestAsk = useUiStore((s) => s.requestAsk);

  // Gate paper-scoped actions on whether the user is currently viewing a paper.
  const readerMatch = useMatch("/reader/:arxivId");
  const currentArxivId = readerMatch?.params.arxivId;

  // Remember which element was focused so we can restore it on close — otherwise
  // focus falls back to <body> and keyboard users lose their place.
  const priorFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    priorFocusRef.current = document.activeElement as HTMLElement | null;
    fetch("/api/digest").then((r) => r.json()).then((b) => setPapers(b.papers ?? [])).catch(() => setPapers([]));
    return () => {
      const prior = priorFocusRef.current;
      if (prior && typeof prior.focus === "function" && document.contains(prior)) {
        prior.focus();
      }
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 backdrop-blur-sm pt-[15vh]"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-[min(640px,92vw)] overflow-hidden rounded-2xl border border-white/10 bg-zinc-900/95 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <Command label="Command palette" className="flex flex-col">
          <Command.Input
            autoFocus
            placeholder="Type a command or search..."
            className="border-b border-white/10 bg-transparent px-4 py-3 text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
          />
          <Command.List className="max-h-[400px] overflow-y-auto p-2">
            <Command.Empty className="p-4 text-sm text-zinc-500">No results.</Command.Empty>

            <Command.Group heading="Actions">
              <Command.Item
                value="summarize this paper"
                disabled={!currentArxivId}
                onSelect={() => {
                  if (!currentArxivId) return;
                  requestSummarize();
                  onClose();
                }}
                className="cursor-pointer rounded px-2 py-2 text-sm text-zinc-200 aria-selected:bg-white/10 data-[disabled=true]:cursor-not-allowed data-[disabled=true]:opacity-40"
              >
                Summarize this paper
                <span className="ml-2 font-mono text-xs text-zinc-500">s</span>
              </Command.Item>
              {QUICK_PROMPTS.map((q) => (
                <Command.Item
                  key={q.label}
                  value={`ask ${q.label}`}
                  disabled={!currentArxivId}
                  onSelect={() => {
                    if (!currentArxivId) return;
                    requestAsk(q.prompt, q.displayLabel);
                    onClose();
                  }}
                  className="cursor-pointer rounded px-2 py-2 text-sm text-zinc-200 aria-selected:bg-white/10 data-[disabled=true]:cursor-not-allowed data-[disabled=true]:opacity-40"
                >
                  <span aria-hidden className="mr-2 text-zinc-500">{q.icon}</span>
                  Ask: {q.label}
                </Command.Item>
              ))}
              <Command.Item
                value="search papers full text"
                onSelect={() => {
                  if (onSearch) onSearch();
                  else onClose();
                }}
                className="cursor-pointer rounded px-2 py-2 text-sm text-zinc-200 aria-selected:bg-white/10"
              >
                Search papers (full text)
                <span className="ml-2 font-mono text-xs text-zinc-500">/</span>
              </Command.Item>
              <Command.Item
                value="toggle left panel"
                onSelect={() => { toggleLeft(); onClose(); }}
                className="cursor-pointer rounded px-2 py-2 text-sm text-zinc-200 aria-selected:bg-white/10"
              >
                Toggle left panel
                <span className="ml-2 font-mono text-xs text-zinc-500">[</span>
              </Command.Item>
              <Command.Item
                value="toggle right panel"
                onSelect={() => { toggleRight(); onClose(); }}
                className="cursor-pointer rounded px-2 py-2 text-sm text-zinc-200 aria-selected:bg-white/10"
              >
                Toggle right panel
                <span className="ml-2 font-mono text-xs text-zinc-500">]</span>
              </Command.Item>
              <Command.Item
                value="toggle reading mode cycle"
                onSelect={() => { cycleReadingMode(); onClose(); }}
                className="cursor-pointer rounded px-2 py-2 text-sm text-zinc-200 aria-selected:bg-white/10"
              >
                Toggle reading mode (light → sepia → dark)
              </Command.Item>
              <Command.Item
                value="open shortcuts overlay help"
                onSelect={() => {
                  if (onShowShortcuts) onShowShortcuts();
                  else onClose();
                }}
                className="cursor-pointer rounded px-2 py-2 text-sm text-zinc-200 aria-selected:bg-white/10"
              >
                Open Shortcuts overlay
                <span className="ml-2 font-mono text-xs text-zinc-500">?</span>
              </Command.Item>
            </Command.Group>

            <Command.Group heading="Papers">
              {papers.slice(0, 30).map((p) => (
                <Command.Item
                  key={p.arxiv_id}
                  value={`open ${p.title} ${p.arxiv_id}`}
                  onSelect={() => { navigate(`/reader/${p.arxiv_id}`); onClose(); }}
                  className="flex cursor-pointer items-center gap-2 rounded px-2 py-2 text-sm text-zinc-200 aria-selected:bg-white/10"
                >
                  <span className="truncate">{p.title}</span>
                  <span className="ml-auto font-mono text-xs text-zinc-500">{p.arxiv_id}</span>
                </Command.Item>
              ))}
            </Command.Group>

            <Command.Group heading="Themes">
              {PALETTES.map((p) => (
                <Command.Item
                  key={p.id}
                  value={`switch theme ${p.name}`}
                  onSelect={() => { setPalette(p.id); onClose(); }}
                  className="cursor-pointer rounded px-2 py-2 text-sm text-zinc-200 aria-selected:bg-white/10"
                >
                  Switch theme: {p.name}
                </Command.Item>
              ))}
            </Command.Group>

            <Command.Group heading="Reading mode">
              {(["light", "sepia", "dark"] as ReadingMode[]).map((m) => (
                <Command.Item
                  key={m}
                  value={`reading mode ${m}`}
                  onSelect={() => { setReadingMode(m); onClose(); }}
                  className="cursor-pointer rounded px-2 py-2 text-sm text-zinc-200 aria-selected:bg-white/10"
                >
                  Reading mode: {m}
                </Command.Item>
              ))}
            </Command.Group>
          </Command.List>
        </Command>
      </div>
    </div>
  );
}
