type Props = { ai: boolean | null };

/**
 * Minimal AI status indicator — a single glowing dot, sized to match the
 * other top-bar icon buttons. The full text label lives in the tooltip so
 * the top bar stays uncluttered.
 */
export function AiStatusPill({ ai }: Props) {
  const off = ai === false;
  const pending = ai === null;
  const label = pending ? "Checking AI backend…" : off ? "AI offline" : "AI connected";
  const color = pending ? "#64748b" : off ? "#6b7280" : "#10b981";
  const glow = off || pending ? "none" : "0 0 8px #10b981";
  return (
    <span
      role="status"
      aria-label={label}
      title={label}
      className="inline-flex items-center justify-center w-7 h-7"
    >
      <span
        aria-hidden
        className="w-2 h-2 rounded-full"
        style={{ background: color, boxShadow: glow }}
      />
    </span>
  );
}
