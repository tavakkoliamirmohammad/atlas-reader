import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink:        "rgb(var(--ink) / <alpha-value>)",
        ac1:        "rgb(var(--ac1-rgb) / <alpha-value>)",
        ac2:        "rgb(var(--ac2-rgb) / <alpha-value>)",
        "ac1-soft":   "var(--ac1-soft)",
        "ac1-mid":    "var(--ac1-mid)",
        "ac1-strong": "var(--ac1-strong)",
        "ac2-soft":   "var(--ac2-soft)",
      },
      fontFamily: {
        sans:   ["Inter", "system-ui", "sans-serif"],
        mono:   ["'JetBrains Mono'", "ui-monospace", "monospace"],
        serif:  ["Charter", "'Iowan Old Style'", "Georgia", "serif"],
      },
      keyframes: {
        drift:  { "0%": { transform: "translate(0,0) scale(1)" }, "100%": { transform: "translate(-3%,4%) scale(1.05)" } },
        fadeUp: { "0%": { opacity: "0", transform: "translateY(8px)" }, "100%": { opacity: "1", transform: "translateY(0)" } },
      },
      animation: {
        drift:  "drift 20s ease-in-out infinite alternate",
        fadeUp: "fadeUp .5s cubic-bezier(.2,.8,.2,1) both",
      },
    },
  },
  plugins: [],
};

export default config;
