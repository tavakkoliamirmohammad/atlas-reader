import { useEffect, useMemo, useState } from "react";

// We deliberately don't import a concrete `PluginRegistry` type from
// @embedpdf because the PDF reader currently uses a same-origin <iframe>;
// the rail is wired through a permissive prop so we can swap in the real
// EmbedPDF registry later without touching this file.
type PluginRegistryLike = {
  pluginsReady?: () => Promise<void>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getPlugin?: (id: string) => any;
};

type SectionMarker = {
  title: string;
  pageIndex: number; // zero-based
  depth: number;
};

type Props = {
  /**
   * Registry returned from PDFViewer's `onReady`. Pass `null` if the underlying
   * PDF surface doesn't expose page/outline APIs (e.g. plain <iframe>) — the
   * rail then renders as a static decoration.
   */
  registry: PluginRegistryLike | null;
};

// Flatten a (possibly nested) bookmark tree into a list of markers with a
// resolved zero-based page index. Bookmarks whose target we can't resolve to a
// page are dropped — we only want markers we can actually navigate to.
function flattenBookmarks(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  nodes: any[] | undefined,
  depth = 0,
  out: SectionMarker[] = [],
): SectionMarker[] {
  if (!nodes) return out;
  for (const node of nodes) {
    const pageIndex = resolveBookmarkPage(node);
    if (pageIndex != null && typeof node?.title === "string") {
      out.push({ title: node.title, pageIndex, depth });
    }
    if (node?.children?.length) {
      flattenBookmarks(node.children, depth + 1, out);
    }
  }
  return out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function resolveBookmarkPage(node: any): number | null {
  const target = node?.target;
  if (!target) return null;
  if (target.type === "destination" && typeof target.destination?.pageIndex === "number") {
    return target.destination.pageIndex;
  }
  if (
    target.type === "action" &&
    target.action &&
    typeof target.action.destination?.pageIndex === "number"
  ) {
    return target.action.destination.pageIndex;
  }
  return null;
}

export function ReadingProgressRail({ registry }: Props) {
  const [activeDocId, setActiveDocId] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [markers, setMarkers] = useState<SectionMarker[]>([]);
  const [hovered, setHovered] = useState<number | null>(null);

  // Track active document (document-manager plugin).
  useEffect(() => {
    if (!registry) return;
    let unsub: undefined | (() => void);
    let cancelled = false;

    const wire = async () => {
      try {
        await registry.pluginsReady?.();
      } catch {
        /* noop */
      }
      if (cancelled) return;

      const dm = registry.getPlugin?.("document-manager");
      const cap = dm?.provides?.();
      if (!cap) return;

      const initial: string | null = cap.getActiveDocumentId?.() ?? null;
      if (initial) setActiveDocId(initial);

      if (typeof cap.onActiveDocumentChanged === "function") {
        unsub = cap.onActiveDocumentChanged(
          (evt: { currentDocumentId: string | null }) => {
            setActiveDocId(evt?.currentDocumentId ?? null);
          },
        );
      }
    };

    wire();
    return () => {
      cancelled = true;
      unsub?.();
    };
  }, [registry]);

  // Track scroll / page changes for the active document.
  useEffect(() => {
    if (!registry || !activeDocId) return;
    let unsub: undefined | (() => void);
    let cancelled = false;

    const wire = async () => {
      try {
        await registry.pluginsReady?.();
      } catch {
        /* noop */
      }
      if (cancelled) return;

      const scroll = registry.getPlugin?.("scroll");
      const cap = scroll?.provides?.();
      if (!cap) return;

      // Seed initial values.
      try {
        const total = cap.getTotalPages?.() ?? 0;
        const cur = cap.getCurrentPage?.() ?? 1;
        setTotalPages(total);
        setCurrentPage(cur);
      } catch {
        /* noop */
      }

      if (typeof cap.onPageChange === "function") {
        unsub = cap.onPageChange(
          (evt: { documentId: string; pageNumber: number; totalPages: number }) => {
            if (evt.documentId !== activeDocId) return;
            setCurrentPage(evt.pageNumber);
            setTotalPages(evt.totalPages);
          },
        );
      }
    };

    wire();
    return () => {
      cancelled = true;
      unsub?.();
    };
  }, [registry, activeDocId]);

  // Load bookmarks (outline) for the active document.
  useEffect(() => {
    if (!registry || !activeDocId) {
      setMarkers([]);
      return;
    }
    let cancelled = false;

    const load = async () => {
      try {
        await registry.pluginsReady?.();
      } catch {
        /* noop */
      }
      if (cancelled) return;

      const bookmark = registry.getPlugin?.("bookmark");
      const cap = bookmark?.provides?.();
      if (!cap?.forDocument) {
        setMarkers([]);
        return;
      }
      try {
        const task = cap.forDocument(activeDocId).getBookmarks();
        const result = await task.toPromise();
        if (cancelled) return;
        const flat = flattenBookmarks(result?.bookmarks).slice(0, 60);
        setMarkers(flat);
      } catch {
        if (!cancelled) setMarkers([]);
      }
    };

    load();
    return () => {
      cancelled = true;
    };
  }, [registry, activeDocId]);

  const handleJump = (pageIndex: number) => {
    if (!registry || !activeDocId) return;
    const scroll = registry.getPlugin?.("scroll");
    const cap = scroll?.provides?.();
    if (!cap?.forDocument) return;
    try {
      cap.forDocument(activeDocId).scrollToPage({
        pageNumber: pageIndex + 1,
        behavior: "smooth",
      });
    } catch {
      /* noop */
    }
  };

  const progress = useMemo(() => {
    if (totalPages <= 1) return totalPages === 1 ? 100 : 0;
    const ratio = (currentPage - 1) / (totalPages - 1);
    return Math.max(0, Math.min(1, ratio)) * 100;
  }, [currentPage, totalPages]);

  // Worst-case: no registry. Render the rail as a quiet static decoration.
  const isStatic = !registry;

  return (
    <div
      className="absolute left-1.5 top-3 bottom-3 z-10 pointer-events-none"
      style={{ width: 14 }}
      aria-hidden={isStatic || totalPages === 0}
    >
      <div className="relative h-full w-[3px] mx-auto rounded-full bg-white/5 overflow-visible">
        {/* Filled portion */}
        <div
          className="absolute left-0 right-0 top-0 rounded-full bg-gradient-to-b from-[var(--ac1)] to-[var(--ac2)] transition-[height] duration-300 ease-out"
          style={{
            height: `${isStatic ? 0 : progress}%`,
            boxShadow:
              "0 0 6px rgba(var(--ac1-rgb), 0.55), 0 0 14px rgba(var(--ac2-rgb), 0.25)",
          }}
        />

        {/* Markers */}
        {!isStatic &&
          totalPages > 1 &&
          markers.map((m, i) => {
            const denom = totalPages - 1;
            const top = denom > 0 ? (m.pageIndex / denom) * 100 : 0;
            const clamped = Math.max(0, Math.min(100, top));
            const reached = m.pageIndex + 1 <= currentPage;
            const isHovered = hovered === i;
            return (
              <button
                key={`${m.pageIndex}-${i}`}
                type="button"
                onClick={() => handleJump(m.pageIndex)}
                onMouseEnter={() => setHovered(i)}
                onMouseLeave={() => setHovered((cur) => (cur === i ? null : cur))}
                onFocus={() => setHovered(i)}
                onBlur={() => setHovered((cur) => (cur === i ? null : cur))}
                className="pointer-events-auto absolute -translate-y-1/2 -translate-x-1/2 left-1/2"
                style={{ top: `${clamped}%` }}
                aria-label={`Jump to ${m.title} (page ${m.pageIndex + 1})`}
                title={m.title}
              >
                <span
                  className="block rounded-full transition-all duration-150"
                  style={{
                    width: m.depth === 0 ? 7 : 5,
                    height: m.depth === 0 ? 7 : 5,
                    background: reached
                      ? "linear-gradient(180deg, var(--ac1), var(--ac2))"
                      : "rgba(255,255,255,0.45)",
                    boxShadow: isHovered
                      ? "0 0 0 2px rgba(255,255,255,0.18), 0 0 8px rgba(var(--ac1-rgb),0.7)"
                      : reached
                        ? "0 0 6px rgba(var(--ac1-rgb),0.55)"
                        : "0 0 0 1px rgba(255,255,255,0.15)",
                    transform: isHovered ? "scale(1.35)" : "scale(1)",
                  }}
                />
                {isHovered && (
                  <span
                    className="absolute left-[14px] top-1/2 -translate-y-1/2 whitespace-nowrap rounded-md px-2 py-1 text-[11px] leading-none text-white/90 ring-1 ring-white/10 backdrop-blur-md"
                    style={{
                      background: "rgba(20,22,30,0.85)",
                      maxWidth: 280,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    <span className="opacity-60 mr-1">p.{m.pageIndex + 1}</span>
                    {m.title}
                  </span>
                )}
              </button>
            );
          })}
      </div>
    </div>
  );
}

export default ReadingProgressRail;
