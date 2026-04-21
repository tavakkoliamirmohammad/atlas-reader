// Shared prompt constants used by both the chat-panel QuickActionChips and the
// command-palette "Actions" section. Keeping these in one place makes sure a
// user sees the exact same prompt text no matter how they trigger it.
export type QuickPrompt = {
  label: string;
  prompt: string;
  icon: string;
};

export const QUICK_PROMPTS: QuickPrompt[] = [
  {
    label: "Key contributions",
    prompt: "What are the key contributions of this paper, in 3-5 bullet points?",
    icon: "★",
  },
  {
    label: "Compare to prior work",
    prompt:
      "How does this paper compare to closely related prior work? Cite the papers it positions against.",
    icon: "≈",
  },
  {
    label: "Open questions",
    prompt:
      "What are the most interesting open questions or future-work directions this paper raises?",
    icon: "?",
  },
  {
    label: "Reproduce setup",
    prompt:
      "Walk me through the exact setup needed to reproduce the main result: hardware, dataset, baselines, command lines if available.",
    icon: "⚙",
  },
  {
    label: "Flow diagram",
    prompt:
      "Respond with ONLY the following, nothing else:\n" +
      "1. One short paragraph (≤ 3 sentences) describing the system's flow.\n" +
      "2. A single ```mermaid fenced block containing a `flowchart TD` or `flowchart LR` graph. " +
      "Nodes = concrete components/stages from the paper; edges carry short labels. " +
      "Aim for 6–15 nodes.\n\n" +
      "Do NOT narrate what you are doing, do NOT restate the question, do NOT add a closing. " +
      "Start with the paragraph, end after the closing ``` of the mermaid block.",
    icon: "◇",
  },
];
