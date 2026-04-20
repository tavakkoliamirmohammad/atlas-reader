import { Command } from "cmdk";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useUiStore, type ReadingMode } from "@/stores/ui-store";
import { PALETTES } from "@/lib/theme";

type Paper = { arxiv_id: string; title: string };

type Props = { open: boolean; onClose: () => void; onSearch?: () => void };

export function CommandPalette({ open, onClose, onSearch }: Props) {
  const [papers, setPapers] = useState<Paper[]>([]);
  const navigate = useNavigate();
  const setPalette = useUiStore((s) => s.setPalette);
  const setReadingMode = useUiStore((s) => s.setReadingMode);

  useEffect(() => {
    if (!open) return;
    fetch("/api/digest").then((r) => r.json()).then((b) => setPapers(b.papers ?? [])).catch(() => setPapers([]));
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
