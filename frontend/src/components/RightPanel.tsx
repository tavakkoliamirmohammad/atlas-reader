import { useEffect, useState } from "react";
import { useMatch } from "react-router-dom";
import { ChatPanel } from "./ChatPanel";
import { HighlightsPanel } from "./HighlightsPanel";
import { ReaderOnlyCta } from "./ReaderOnlyCta";
import { u } from "@/lib/api";

export function RightPanel() {
  const [ai, setAi] = useState<boolean | null>(null);
  // Only show the highlights section while a paper is open in the reader.
  const inReader = !!useMatch("/reader/:arxivId");
  useEffect(() => {
    fetch(u("/api/health"))
      .then((r) => r.json())
      .then((b) => setAi(!!b.ai))
      .catch(() => setAi(false));
  }, []);
  if (ai === null) return null;
  return (
    <div className="flex flex-col h-full min-h-0">
      {inReader && <HighlightsPanel />}
      <div className="flex-1 min-h-0">
        {ai ? <ChatPanel /> : <ReaderOnlyCta />}
      </div>
    </div>
  );
}
