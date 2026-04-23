import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { u } from "@/lib/api";

/**
 * Full-screen overlay shown when the user's local Atlas backend is not
 * reachable from the browser.
 *
 * Atlas is deliberately per-user: the UI loads from a CDN (or same origin in
 * dev/bundled mode) but talks to the user's own `localhost:8765`. When that's
 * not running, nothing works — so instead of a blank page, we tell the user
 * exactly what to do.
 *
 * Polls `/api/health` every {@link POLL_INTERVAL_MS}. While "checking" (no
 * decision yet) we render nothing so first paint isn't flashed over by a
 * doom-panel. Re-renders auto-dismiss once the backend returns 200.
 */

const POLL_INTERVAL_MS = 4000;
const FETCH_TIMEOUT_MS = 3000;

type Status = "checking" | "online" | "offline";

async function probeBackend(): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(u("/api/health"), { signal: ctrl.signal });
    return r.ok;
  } catch {
    return false;
  } finally {
    window.clearTimeout(timer);
  }
}

export function BackendOfflineOverlay() {
  const [status, setStatus] = useState<Status>("checking");
  const [attempt, setAttempt] = useState(0);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;

    const tick = async () => {
      const ok = await probeBackend();
      if (cancelled) return;
      setStatus(ok ? "online" : "offline");
      setAttempt((n) => n + 1);
    };

    tick();
    const id = window.setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [nonce]);

  if (status !== "offline") return null;

  return createPortal(
    <div
      role="alertdialog"
      aria-modal="true"
      aria-label="Atlas backend unreachable"
      className="fixed inset-0 z-[1200] flex items-center justify-center bg-black/85 backdrop-blur-md fade-up"
    >
      <div className="glass-elevated max-w-md rounded-2xl px-6 py-5 text-zinc-100">
        <div className="mb-1 flex items-center gap-2 text-[11px] uppercase tracking-wider text-rose-300">
          <span
            className="inline-block h-1.5 w-1.5 rounded-full bg-rose-400 shadow-[0_0_6px_#fb7185]"
            aria-hidden
          />
          Atlas offline
        </div>
        <div className="mb-3 text-lg font-medium leading-snug">
          Start Atlas on your machine
        </div>
        <p className="mb-4 text-[12.5px] leading-relaxed text-zinc-300">
          This page loads from the web, but talks to Atlas running on your
          own machine so your AI stays private to you. Open a terminal and
          run:
        </p>
        <pre
          className="mb-4 select-all rounded-lg border border-white/5 bg-black/50 px-3 py-2 font-mono text-[12px] text-emerald-300"
          aria-label="Command to start Atlas"
        >
          atlas up
        </pre>
        <p className="mb-4 text-[11px] leading-relaxed text-zinc-500">
          Expecting the backend at{" "}
          <code className="rounded bg-white/5 px-1 py-px font-mono text-[10.5px]">
            {window.location.origin}
          </code>
          . This banner hides automatically once it's reachable (checking
          every {Math.round(POLL_INTERVAL_MS / 1000)}s).
        </p>
        <div className="flex items-center justify-between gap-3">
          <span className="text-[10.5px] uppercase tracking-wider text-zinc-500">
            attempts: {attempt}
          </span>
          <button
            type="button"
            onClick={() => {
              setStatus("checking");
              setNonce((n) => n + 1);
            }}
            className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-[12px] text-zinc-100 hover:bg-white/[0.08] hover:border-[color:var(--ac1-mid)] cursor-pointer transition-colors"
          >
            Check now
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
