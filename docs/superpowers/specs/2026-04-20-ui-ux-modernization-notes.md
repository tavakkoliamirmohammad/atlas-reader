# Atlas — UI/UX Modernization Notes

**Date:** 2026-04-20  
**Scope:** Visual/UX audit of the running app + component layer. No code changes.

---

## 1. Current Character

Atlas has a strong visual foundation: a deep near-black shell (`#08080d`), a palette-driven duo-tone accent system (`--ac1`/`--ac2`) that bleeds into aurora gradients, thoughtfully slim scrollbars, and a glass-panel aesthetic that avoids being pure frosted-glass kitsch. The typography is disciplined — Inter at 11–15px, tight tracking on uppercase labels, tabular-nums on scores. The three-column layout, keyboard-first navigation (j/k/Enter, Cmd+K, `[`/`]`), and streaming UI feel purposeful. What dates it: the center empty state ("Pick a paper") is placeholder-level copy with no visual weight; the left panel header has a heavy `text-[11px] uppercase tracking-wider` label but no typographic hierarchy at the "Daily digest" title level; focus rings are the browser default (not palette-matched); the right panel transitions between collapsed/expanded states with no spring or physicality; the `BuildProgressOverlay` is a raw mono log list that misses an opportunity to feel more intentional; and stat digits on the Streak pill are not optically sized for display. These are craft-layer misses on an otherwise strong skeleton.

---

## 2. Top 5 Recommendations

### 1. Palette-matched focus rings  
**Pain:** Browser default blue focus rings are jarring against every palette except the default cyan. A11y-correct but visually inconsistent.  
**Impact:** ★★★★★ **Effort:** ★

- Add `[data-focus-visible]` or a global `.focus-visible:focus-visible` rule in `globals.css` that uses `ring-[color:var(--ac1)]` with a `2px solid` outline and `3px` offset.
- Scope it with `html[data-palette]` so it switches automatically when `applyPalette()` updates `--ac1` on `:root`.
- Applies to all interactive elements: paper rows, chips, mode buttons, the composer textarea, command palette items, highlights swatches.
- Files: `frontend/src/styles/globals.css` (one rule block).
- The detail that makes it intentional: `outline-offset: 3px` so the ring hugs the element's border-radius without eating into it — matches the existing `ring-2 ring-[color:var(--ac1)]` convention already used on the active ThemePicker dot.

### 2. Spring-physics panel collapse  
**Pain:** Toggling the left/right panels is an instant CSS width-0 snap. There is no collapse animation at all — the panel just vanishes. This is the single most "desktop utility, not a crafted tool" feeling moment in the UI.  
**Impact:** ★★★★★ **Effort:** ★★

- Replace the bare `leftCollapsed` boolean with an animated width transition. In `App.tsx` (or wherever the panel grid is defined), apply `transition: width 280ms cubic-bezier(0.34,1.56,0.64,1)` — a spring curve with slight overshoot — to both side panels.
- When `leftCollapsed` is true, set `width: 0; overflow: hidden` on the left panel shell; when false restore `width: var(--left-w)`. Same for right panel with `--right-w`.
- The spring cubic-bezier (`0.34,1.56,0.64,1`) gives the panel a subtle "snap open / compress shut" feel that signals mechanical intent without being cartoonish.
- Inside the collapsed shell, preserve content in the DOM but set `visibility: hidden` after the animation completes (using a `transitionend` listener or a 300ms delay) so tab focus doesn't reach hidden content.
- Files: `App.tsx` or the main layout file, `globals.css` for the CSS variable and transition.
- The detail: use the same cubic-bezier already used for drawer patterns in Linear, Raycast, and Arc — readers will feel it as native even without naming why.

### 3. Anchored "Pick a paper" empty state with text-balance  
**Pain:** The center viewport shows "Pick a paper / Click any paper in the list, or paste an arXiv URL." in `font-medium` and `text-sm`. At ~600px wide it wraps awkwardly; there is no visual mass to anchor it; and the copy is purely instructional (a developer's first draft).  
**Impact:** ★★★★☆ **Effort:** ★

- Replace the copy with something Atlas-flavored: a large optical-size heading (e.g., `text-4xl font-extrabold tracking-tight text-white/8` — barely-there watermark) that says "No paper open" or a domain-specific phrase, with a smaller line for the action hint below.
- Add `text-wrap: balance` (CSS `text-wrap: balance`) on the subtitle line so it never orphans a single word. File: wherever the empty state JSX lives (the center column in `App.tsx` or a dedicated `EmptyCenter` component).
- Introduce a faint icon — the `Book` or `FileText` from lucide-react already in the bundle — sized at ~64px, `opacity-[0.06]`, centered above the text. Gives the eye something to land on before the copy.
- Files: `App.tsx` center column empty-state JSX. One small component or inline JSX block.
- The detail: the watermark heading at `text-white/8` creates depth without adding decoration — it's invisible until the eye adapts, then it's always there.

### 4. Tabular-numeric, optically-sized stat display in Streak  
**Pain:** "1-day streak · 6 papers" renders in a standard `text-xs` span. The numbers feel like inline prose digits — not like a reading dashboard's stats. On a display with a dense topbar, these blend into metadata noise.  
**Impact:** ★★★★☆ **Effort:** ★

- In `Streak.tsx`, wrap each numeric value (`s.streak_days`, `s.total_papers`) in a `<span>` with `font-variant-numeric: tabular-nums; font-feature-settings: "tnum" 1, "lnum" 1` applied via a Tailwind utility class (`tabular-nums` already exists) and bump the number's `font-size` to `text-sm font-semibold` while keeping the label at `text-xs font-normal text-slate-400`. This splits the "number" from the "unit" typographically.
- Add `font-feature-settings: "lnum" 1` (lining numerals) in `globals.css` on `body` so Inter renders numbers on the baseline instead of old-style (Inter supports this natively).
- Files: `Streak.tsx`, optionally `globals.css`.
- The detail: the visual split between a larger numeral and a smaller label is how every modern dashboard (Linear, Vercel analytics, GitHub stats) signals "this number matters." It costs zero layout space.

### 5. View Transition API between digest and reader routes  
**Pain:** Clicking a paper in the left panel is a hard React Router swap — the center column jumps from "Pick a paper" to a loading PDF card instantly. It reads like a plain SPA navigation rather than moving between two meaningful states of the same tool.  
**Impact:** ★★★★☆ **Effort:** ★★

- Wrap React Router's `navigate()` call in `document.startViewTransition(() => navigate(...))` in `PaperList.tsx` (the `onKeyDown` handler and the `<Link>` click). The View Transition API is supported in Chrome 111+ / Safari 18+ and degrades silently.
- Add a minimal CSS rule in `globals.css`:
  ```css
  ::view-transition-old(root) { animation: 120ms ease-out both atlas-fade-up reverse; }
  ::view-transition-new(root) { animation: 160ms ease-out both atlas-fade-up; }
  ```
  The `atlas-fade-up` keyframe already exists in globals.css — no new code.
- The center PDF card and right panel content transition in on paper open, giving the feeling that the reader "arrives" rather than appearing.
- Files: `PaperList.tsx` (`navigate()` calls and `<Link>` onClick), `globals.css` (4 lines of `::view-transition` CSS).
- The detail: because both panels are outside the transition scope, only the center content cross-fades — which is exactly the right semantic: "you changed papers, not the whole app."

---

## 3. Ten Smaller Recommendations

**3.1 Section markers back on the reading rail**  
`ReadingProgressRail.tsx` has the full section-marker implementation wrapped in `{false && ...}`. Re-enable it and enable pointer-events on the rail. Sections from the PDF outline appear as dots the user can click to jump. Cost: delete the `false &&`. Files: `ReadingProgressRail.tsx`.

**3.2 `content-visibility: auto` on paper rows**  
`PaperList.tsx` renders all rows in the DOM at once. Add `content-visibility: auto; contain-intrinsic-size: 0 48px` to `.pdf-page` class or paper row wrapper. For a 30-paper list this halves paint cost. Files: `globals.css` or a Tailwind class in `PaperRow.tsx`.

**3.3 Auto-growing textarea in ChatPanel**  
The composer textarea is fixed at `rows={3}` with `max-h-[200px]`. It doesn't grow as the user types — a regression from every modern chat UI (Claude.ai, ChatGPT). Use `field-sizing: content` (Chrome 123+) with a JS fallback (`scrollHeight` sync on input). Files: `ChatPanel.tsx`.

**3.4 Palette-tinted text selection in the PDF**  
`globals.css` hardcodes `rgba(34, 211, 238, 0.35)` for `::selection` inside `.pdf-text-layer`. When the user switches to the rose or amber palette, selection still shows cyan. Replace with `rgba(var(--ac1-rgb), 0.35)`. Files: `globals.css` (two lines: `::selection`, `::-moz-selection`).

**3.5 Kbd styling unification**  
`ShortcutsOverlay.tsx`, `ChatPanel.tsx`, `HighlightsPanel.tsx`, and `Footer.tsx` each have slightly different `<kbd>` padding/border-radius combos (some `rounded`, some `rounded-md`, varying `px-1`/`px-1.5`/`px-2` amounts). Extract a `.kbd` global class in `globals.css` so all keyboard hints render identically. Files: `globals.css`, then search-replace kbd classes across components.

**3.6 Glossary empty state copy**  
"No terms yet — click Build glossary to extract." is functional but dry. Replace with "No domain terms indexed yet" + a small build button below rather than above. Keeps the signal clear and feels less like a tooltip. Files: `Glossary.tsx`.

**3.7 Tier label icons as SVG, not emoji**  
`PaperList.tsx` uses `🔥`, `⭐`, `📄` as tier icons rendered via `aria-hidden` spans. Emoji render differently across OS (macOS, iOS, some Linux). Replace with lucide-react equivalents: `Flame` (already imported in `Streak.tsx`), `Star`, `FileText` — sized at 12px, colored with `meta.color`. Files: `PaperList.tsx`.

**3.8 Toolbar auto-hide grace zone**  
`PdfPage.tsx` hides the floating toolbar after 1500ms (`HIDE_AFTER_MS`). When the user moves the mouse toward the toolbar from the PDF body, there's a brief period where the pointer is in-transit and the toolbar vanishes before they arrive. Add a `pointer-events: none` ghost hit-area (invisible `div`, same bounding rect as the toolbar) that resets the hide timer on `mouseenter`. Files: `PdfPage.tsx`.

**3.9 Model pill uppercase tracking on StreamingMessage**  
`StreamingMessage.tsx` renders the model label (`opus`, `sonnet`, `haiku`) as lowercase in the pill. The `uppercase tracking-wider` convention used on tier labels and section headers elsewhere should apply here too — makes the model pill read as a badge, not metadata overflow. Files: `StreamingMessage.tsx` (the pill `<span>` already has `uppercase tracking-wider` — verify it's not getting overridden by the outer container styles).

**3.10 Highlight clipboard-banner accessible color**  
`HighlightsPanel.tsx` shows "Filled from clipboard — ⌘Z to undo, or click Cancel" in `text-amber-300/80`. At 80% opacity on the dark panel background (`rgba(18,18,28,0.55)`), this amber fails WCAG 4.5:1 contrast at small sizes. Raise opacity to full (`text-amber-300`) and add `font-medium`. Files: `HighlightsPanel.tsx`.

---

## 4. Anti-List — Considered and Rejected

**Animated aurora drift speed change.** The aurora already drifts at 20s with `alternate` easing. Slowing it further is imperceptible; speeding it up competes with the streaming caret and is distracting. The current value is well-calibrated — leave it.

**Per-section collapsible panels in the right panel (Glossary, Highlights, Chat as tabs).** Tempting because the right panel is tall. Rejected because the current accordion pattern (Glossary + Highlights as collapsible sections above a flex-1 ChatPanel) is already the correct density model — tabbing would hide the glossary/highlights during active chat, which is exactly the moment the user wants them visible.

**Pagination or virtual list for paper rows.** With a typical digest of 20–40 papers, full DOM rendering is fine. `content-visibility: auto` (rec 3.2) handles the paint cost without the complexity of a virtual scroller. Rejected as over-engineering.

**Sticky "current paper" header in the left panel.** When scrolled, the active paper's title could pin to the top of the paper list. Rejected because the active row already has a visible left-border accent and the list is short enough that the paper is never far from view. Adding a sticky header would duplicate content.

**Replacing BuildProgressOverlay with a toast/notification strip.** The current full-screen overlay is appropriate for a blocking operation (you can't read papers while the digest is fetching). A toast would imply non-blocking. The overlay is correct for the UX model — the copy and mono-log styling are what need improvement, not the overlay pattern itself.
