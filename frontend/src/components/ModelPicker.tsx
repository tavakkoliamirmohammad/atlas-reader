import { useEffect, useRef, useState } from "react";
import { type CodexModelInfo, getCodexModels } from "@/lib/api";
import { type ModelChoice } from "@/stores/ui-store";

export const CLAUDE_MODEL_META: Record<ModelChoice, { label: string; tag: string }> = {
  opus:   { label: "Opus",   tag: "deepest"  },
  sonnet: { label: "Sonnet", tag: "balanced" },
  haiku:  { label: "Haiku",  tag: "fastest"  },
};

const CLAUDE_OPTIONS: ModelChoice[] = ["opus", "sonnet", "haiku"];

type GenericPickerProps<T extends string> = {
  model: T;
  options: T[];
  meta: Record<T, { label: string; tag: string }>;
  onChange: (m: T) => void;
  disabled?: boolean;
};

/**
 * Pure presentational picker. Closes on outside click, falls back to the raw
 * slug when meta hasn't loaded yet. Generic so the same component drives the
 * three Claude aliases AND the dynamic codex model list.
 */
export function GenericModelPicker<T extends string>({
  model, options, meta, onChange, disabled,
}: GenericPickerProps<T>) {
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

  const labelOf = (m: T): string => meta[m]?.label ?? m;
  const tagOf = (m: T): string => meta[m]?.tag ?? "";

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        aria-label="Model"
        aria-expanded={open}
        className="model-pill inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] hover:border-[color:var(--ac1-mid)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
      >
        <span className="w-1.5 h-1.5 rounded-full" style={{ background: "var(--ac1)" }} />
        <span>{labelOf(model)}</span>
        <svg width="9" height="9" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
          <path d="M3 4.5l3 3 3-3" />
        </svg>
      </button>
      {open && (
        <div
          className="absolute bottom-full left-0 mb-1.5 w-56 max-h-[55vh] overflow-y-auto rounded-xl backdrop-blur-md shadow-2xl z-30 divide-y divide-white/5"
          role="listbox"
          style={{
            background: "var(--surface-overlay)",
            border: "1px solid var(--surface-overlay-border)",
            color: "var(--surface-overlay-text)",
          }}
        >
          {options.map((m) => {
            const active = m === model;
            const description = tagOf(m);
            return (
              <button
                key={m}
                type="button"
                role="option"
                aria-selected={active}
                onClick={() => { onChange(m); setOpen(false); }}
                className={[
                  "w-full flex items-start gap-2 px-2.5 py-2 text-left",
                  "hover:bg-white/5 transition-colors cursor-pointer",
                  active ? "bg-[color:var(--ac1-soft)]" : "",
                ].join(" ")}
              >
                <span
                  className="mt-1 shrink-0 w-1 h-1 rounded-full"
                  style={{ background: active ? "var(--ac1)" : "rgb(100 116 139)" }}
                />
                <span className="flex-1 min-w-0 flex flex-col leading-tight">
                  <span
                    className={[
                      "text-[11px] truncate",
                      active ? "text-slate-100 font-medium" : "text-slate-200",
                    ].join(" ")}
                  >
                    {labelOf(m)}
                  </span>
                  {description && (
                    <span className="mt-1 text-[10px] leading-snug text-slate-400 break-words">
                      {description}
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * Discover codex models from `~/.codex/models_cache.json` via the backend.
 * Only fetches when codex is the active backend. If the persisted slug no
 * longer appears in the list (model retired, fresh install, etc.), swap to
 * the first by codex's own priority order.
 *
 * `currentSlug` is read once at fetch time via a ref, so a slug change
 * doesn't re-trigger the fetch — only a backend toggle does.
 */
export function useCodexModels(
  active: boolean,
  currentSlug: string,
  onAutoSwap: (slug: string) => void,
): CodexModelInfo[] {
  const [list, setList] = useState<CodexModelInfo[]>([]);
  const slugRef = useRef(currentSlug);
  slugRef.current = currentSlug;
  const onAutoSwapRef = useRef(onAutoSwap);
  onAutoSwapRef.current = onAutoSwap;

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    getCodexModels()
      .then((fetched) => {
        if (cancelled || fetched.length === 0) return;
        setList(fetched);
        if (!fetched.some((m) => m.slug === slugRef.current)) {
          onAutoSwapRef.current(fetched[0].slug);
        }
      })
      .catch(() => { /* picker stays empty; user shouldn't reach here */ });
    return () => { cancelled = true; };
  }, [active]);

  return list;
}

type BackendModelPickerProps = {
  backend: "claude" | "codex";
  claudeModel: ModelChoice;
  codexModel: string;
  onClaudeChange: (m: ModelChoice) => void;
  onCodexChange: (slug: string) => void;
  codexModels: CodexModelInfo[];
  disabled?: boolean;
};

/**
 * Backend-aware wrapper: renders the Claude picker (3 stable aliases) or
 * the codex picker (dynamic from cache) based on `backend`. Lets the parent
 * stay agnostic about which dropdown is on screen.
 */
export function BackendModelPicker({
  backend, claudeModel, codexModel,
  onClaudeChange, onCodexChange, codexModels, disabled,
}: BackendModelPickerProps) {
  if (backend === "claude") {
    return (
      <GenericModelPicker
        model={claudeModel}
        options={CLAUDE_OPTIONS}
        meta={CLAUDE_MODEL_META}
        onChange={onClaudeChange}
        disabled={disabled}
      />
    );
  }
  const codexMeta = Object.fromEntries(
    codexModels.map((m) => [m.slug, { label: m.label, tag: m.description }]),
  ) as Record<string, { label: string; tag: string }>;
  return (
    <GenericModelPicker
      model={codexModel}
      options={codexModels.map((m) => m.slug)}
      meta={codexMeta}
      onChange={onCodexChange}
      disabled={disabled || codexModels.length === 0}
    />
  );
}
