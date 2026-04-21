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
      "Produce a diagram of the paper's core method / system as a Mermaid flowchart (```mermaid fence, `flowchart TD` or `flowchart LR`). " +
      "Nodes should be concrete components / stages from the paper; edges should carry short labels describing what flows between them. " +
      "Aim for 6–15 nodes — enough to show the structure but not every detail. " +
      "Above the diagram, write one short paragraph explaining what the diagram depicts. " +
      "Below the diagram, also provide an ASCII-art version in a fenced code block using box-drawing characters (┌┐└┘│─→), so the flow is readable even without a Mermaid renderer.",
    icon: "◇",
  },
];
