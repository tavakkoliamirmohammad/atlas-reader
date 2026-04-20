import { useEffect, useRef, useState } from "react";

const STORAGE_KEY = "atlas:right-w";
const MIN_W = 280;
const MAX_W = 640;
const DEFAULT_W = 320;

/** Read+clamp a stored width, returning a CSS px string. Pure so it's safe in SSR/tests. */
function loadStoredWidth(): number {
  if (typeof window === "undefined") return DEFAULT_W;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_W;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n)) return DEFAULT_W;
    return Math.min(MAX_W, Math.max(MIN_W, n));
  } catch {
    return DEFAULT_W;
  }
}

/** Apply a width to both the CSS var and persist it. */
function applyWidth(px: number) {
  const clamped = Math.min(MAX_W, Math.max(MIN_W, px));
  document.documentElement.style.setProperty("--right-w", `${clamped}px`);
  try {
    window.localStorage.setItem(STORAGE_KEY, String(clamped));
  } catch {
    /* private mode: silently ignore */
  }
  return clamped;
}

/** Initialize the CSS var from storage on first import (so the panel paints
 * at the correct width on first frame, before this component mounts). */
if (typeof document !== "undefined") {
  document.documentElement.style.setProperty(
    "--right-w",
    `${loadStoredWidth()}px`,
  );
}

/**
 * A 6px-wide drag handle pinned to the LEFT edge of the right aside.
 * Drag horizontally to resize; the panel width is clamped to [280, 640]px
 * and persisted to localStorage under `atlas:right-w`.
 */
export function RightPanelResizer() {
  const [dragging, setDragging] = useState(false);
  const startRef = useRef<{ x: number; w: number } | null>(null);

  useEffect(() => {
    // Re-sync on mount in case the early script wasn't reached (e.g. tests).
    applyWidth(loadStoredWidth());
  }, []);

  useEffect(() => {
    if (!dragging) return;
    function onMove(e: MouseEvent) {
      if (!startRef.current) return;
      // Right panel grows when dragging LEFT (x decreases), so subtract dx.
      const dx = e.clientX - startRef.current.x;
      applyWidth(startRef.current.w - dx);
    }
    function onUp() {
      setDragging(false);
      startRef.current = null;
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    // Prevent text selection / iframe focus stealing while dragging.
    const prevUserSelect = document.body.style.userSelect;
    const prevCursor = document.body.style.cursor;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = prevUserSelect;
      document.body.style.cursor = prevCursor;
    };
  }, [dragging]);

  function onMouseDown(e: React.MouseEvent) {
    e.preventDefault();
    const cur = Number.parseInt(
      getComputedStyle(document.documentElement).getPropertyValue("--right-w"),
      10,
    );
    startRef.current = {
      x: e.clientX,
      w: Number.isFinite(cur) ? cur : DEFAULT_W,
    };
    setDragging(true);
  }

  function onDoubleClick() {
    // Reset to default on double-click — useful escape hatch.
    applyWidth(DEFAULT_W);
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize right panel"
      onMouseDown={onMouseDown}
      onDoubleClick={onDoubleClick}
      className={[
        "absolute top-0 left-0 h-full w-[6px] -translate-x-1/2 z-20",
        "cursor-col-resize group",
        // Subtle vertical line, brighter on hover or while dragging.
        "before:content-[''] before:absolute before:top-0 before:bottom-0 before:left-1/2",
        "before:w-px before:-translate-x-1/2 before:transition-colors",
        dragging
          ? "before:bg-[color:var(--ac1-mid)]"
          : "before:bg-transparent group-hover:before:bg-white/15",
      ].join(" ")}
    />
  );
}
