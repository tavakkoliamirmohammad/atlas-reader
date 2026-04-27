import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Pause,
  Play,
  RefreshCw,
  X,
} from "lucide-react";
import { usePodcastStore } from "@/stores/podcast-store";

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function MiniAudioPlayer() {
  const current = usePodcastStore((s) => s.current);
  const generationState = usePodcastStore((s) => s.generationState);
  const progress = usePodcastStore((s) => s.progress);
  const error = usePodcastStore((s) => s.error);
  const position = usePodcastStore((s) => s.position);
  const isPlaying = usePodcastStore((s) => s.isPlaying);
  const setPosition = usePodcastStore((s) => s.setPosition);
  const setPlaying = usePodcastStore((s) => s.setPlaying);
  const regenerate = usePodcastStore((s) => s.regenerate);
  const close = usePodcastStore((s) => s.close);

  const audioRef = useRef<HTMLAudioElement>(null);
  const [transcriptOpen, setTranscriptOpen] = useState(false);

  // Sync audio src and rehydrate position when the URL changes.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !current?.url) return;
    // Seek to the persisted position once metadata is ready.
    const onLoadedMetadata = () => {
      audio.currentTime = position;
    };
    audio.addEventListener("loadedmetadata", onLoadedMetadata);
    return () => audio.removeEventListener("loadedmetadata", onLoadedMetadata);
    // position is intentionally excluded: we only want to restore once per src change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.url]);

  // Wire audio element events → store.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onTimeUpdate = () => setPosition(audio.currentTime);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onEnded = () => {
      setPlaying(false);
      setPosition(0);
    };

    audio.addEventListener("timeupdate", onTimeUpdate);
    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("ended", onEnded);
    return () => {
      audio.removeEventListener("timeupdate", onTimeUpdate);
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("ended", onEnded);
    };
  }, [setPosition, setPlaying]);

  function handlePlayPause() {
    const audio = audioRef.current;
    if (!audio) return;
    // Use the store's isPlaying flag as the source of truth for UI state,
    // since jsdom's HTMLMediaElement.paused doesn't update when play() is mocked.
    // In a real browser both stay in sync via the play/pause event listeners.
    if (!isPlaying) {
      audio.play().catch(() => {});
    } else {
      audio.pause();
    }
  }

  function handleScrubberChange(e: React.ChangeEvent<HTMLInputElement>) {
    const newValue = Number(e.target.value);
    if (audioRef.current) {
      audioRef.current.currentTime = newValue;
    }
    setPosition(newValue);
  }

  // State 1: idle with no current → render nothing.
  if (current === null && generationState === "idle") {
    return null;
  }

  // State 5: error.
  if (generationState === "error") {
    return (
      <div
        className="fixed bottom-0 left-0 right-0 z-40 bg-rose-950/95 backdrop-blur border-t border-rose-800/60"
        role="alert"
      >
        <div className="flex items-center gap-3 px-4 h-16 max-w-full">
          <div className="flex-1 min-w-0 text-sm text-rose-200 truncate">
            {error ? (
              <>
                <span className="font-medium">{error.phase}</span>
                {": "}
                {error.message}
              </>
            ) : (
              "An error occurred."
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => { if (current) void regenerate(); }}
              disabled={!current}
              aria-label="Try again"
              className="px-3 py-1.5 rounded-md text-xs font-medium bg-rose-800/60 hover:bg-rose-700/70 text-rose-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
            >
              Try again
            </button>
            <button
              type="button"
              onClick={close}
              aria-label="Dismiss"
              className="px-3 py-1.5 rounded-md text-xs font-medium bg-white/10 hover:bg-white/20 text-rose-200 transition-colors cursor-pointer"
            >
              Dismiss
            </button>
          </div>
        </div>
      </div>
    );
  }

  // State 2: scripting.
  if (generationState === "scripting") {
    return (
      <div
        className="fixed bottom-0 left-0 right-0 z-40 glass-elevated border-t border-[var(--glass-border)]"
        role="status"
        aria-live="polite"
      >
        <div className="flex items-center gap-3 px-4 h-16">
          <div className="flex-1 min-w-0">
            {current?.paperTitle && (
              <div className="text-xs text-slate-400 truncate mb-1">
                {current.paperTitle}
              </div>
            )}
            <div className="text-sm text-slate-200">Drafting script…</div>
            {/* Indeterminate shimmer progress bar */}
            <div className="mt-1.5 h-1 rounded-full bg-white/10 overflow-hidden">
              <div
                className="h-full rounded-full bg-gradient-to-r from-transparent via-[var(--ac1)] to-transparent animate-shimmer"
                style={{ width: "40%", animation: "shimmer 1.6s ease-in-out infinite" }}
              />
            </div>
          </div>
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className="shrink-0 p-1.5 rounded-md text-slate-400 hover:text-slate-200 hover:bg-white/10 transition-colors cursor-pointer"
          >
            <X size={16} />
          </button>
        </div>
      </div>
    );
  }

  // State 3: synthesizing.
  if (generationState === "synthesizing") {
    const ratio = progress.total_s_estimate > 0
      ? Math.min(1, Math.max(0, progress.synthesized_s / progress.total_s_estimate))
      : 0;

    return (
      <div
        className="fixed bottom-0 left-0 right-0 z-40 glass-elevated border-t border-[var(--glass-border)]"
        role="status"
        aria-live="polite"
      >
        <div className="flex items-center gap-3 px-4 h-16">
          <div className="flex-1 min-w-0">
            {current?.paperTitle && (
              <div className="text-xs text-slate-400 truncate mb-1">
                {current.paperTitle}
              </div>
            )}
            <div className="text-sm text-slate-200">
              Generating audio{" "}
              <span className="text-slate-400">
                · {formatTime(progress.synthesized_s)} of ~{formatTime(progress.total_s_estimate)}
              </span>
            </div>
            {/* Determinate progress bar */}
            <div className="mt-1.5 h-1 rounded-full bg-white/10 overflow-hidden">
              <div
                className="h-full rounded-full transition-[width] duration-300"
                style={{
                  width: `${ratio * 100}%`,
                  background: "var(--ac1)",
                }}
              />
            </div>
          </div>
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className="shrink-0 p-1.5 rounded-md text-slate-400 hover:text-slate-200 hover:bg-white/10 transition-colors cursor-pointer"
          >
            <X size={16} />
          </button>
        </div>
      </div>
    );
  }

  // State 4: ready — full player.
  if (generationState === "ready" && current) {
    const duration = current.duration_s ?? 0;

    return (
      <>
        {/* Hidden audio element */}
        <audio ref={audioRef} src={current.url} preload="metadata" />

        <div
          className="fixed bottom-0 left-0 right-0 z-40 glass-elevated border-t border-[var(--glass-border)]"
          role="region"
          aria-label="Podcast player"
        >
          <div className="flex items-center gap-3 px-4 h-[68px]">
            {/* Play / Pause */}
            <button
              type="button"
              onClick={handlePlayPause}
              aria-label={isPlaying ? "Pause" : "Play"}
              className="shrink-0 w-9 h-9 rounded-full flex items-center justify-center transition-all cursor-pointer hover:scale-105"
              style={{ background: "var(--ac1-soft)", color: "var(--ac1)" }}
            >
              {isPlaying
                ? <Pause size={16} fill="currentColor" />
                : <Play size={16} fill="currentColor" />
              }
            </button>

            {/* Title + meta + scrubber column */}
            <div className="flex-1 min-w-0 flex flex-col justify-center gap-0.5">
              {/* Title row */}
              <div className="flex items-baseline gap-2 min-w-0">
                <span className="text-sm text-slate-100 truncate font-medium">
                  {current.paperTitle}
                </span>
                <span className="shrink-0 text-[10px] text-slate-400 whitespace-nowrap">
                  {current.voice} · {current.model}
                </span>
              </div>

              {/* Scrubber + time */}
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  min={0}
                  max={duration}
                  step={1}
                  value={position}
                  onChange={handleScrubberChange}
                  aria-label="Seek"
                  className="flex-1 h-1 accent-[color:var(--ac1)] cursor-pointer"
                />
                <span className="shrink-0 text-[11px] text-slate-400 tabular-nums whitespace-nowrap">
                  {formatTime(position)} / {formatTime(duration)}
                </span>
              </div>
            </div>

            {/* Transcript toggle */}
            <button
              type="button"
              onClick={() => setTranscriptOpen((v) => !v)}
              aria-label={transcriptOpen ? "Hide transcript" : "Show transcript"}
              aria-expanded={transcriptOpen}
              data-testid="transcript-chevron"
              className="shrink-0 p-1.5 rounded-md text-slate-400 hover:text-slate-200 hover:bg-white/10 transition-colors cursor-pointer"
            >
              {transcriptOpen ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
            </button>

            {/* Regenerate */}
            <button
              type="button"
              onClick={() => void regenerate()}
              aria-label="Regenerate"
              className="shrink-0 p-1.5 rounded-md text-slate-400 hover:text-slate-200 hover:bg-white/10 transition-colors cursor-pointer"
            >
              <RefreshCw size={16} />
            </button>

            {/* Close */}
            <button
              type="button"
              onClick={close}
              aria-label="Close"
              className="shrink-0 p-1.5 rounded-md text-slate-400 hover:text-slate-200 hover:bg-white/10 transition-colors cursor-pointer"
            >
              <X size={16} />
            </button>
          </div>
        </div>
      </>
    );
  }

  // Fallback: shouldn't normally be reached, but render nothing.
  return null;
}
