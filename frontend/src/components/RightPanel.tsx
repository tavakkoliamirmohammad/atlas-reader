import { useEffect, useState } from "react";
import { ChatPanel } from "./ChatPanel";
import { ReaderOnlyCta } from "./ReaderOnlyCta";

export function RightPanel() {
  const [ai, setAi] = useState<boolean | null>(null);
  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then((b) => setAi(!!b.ai))
      .catch(() => setAi(false));
  }, []);
  if (ai === null) return null;
  return ai ? <ChatPanel /> : <ReaderOnlyCta />;
}
