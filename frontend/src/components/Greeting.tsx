import { useEffect, useState } from "react";
import { u } from "@/lib/api";

function timeOfDay(): "morning" | "afternoon" | "evening" | "night" {
  const h = new Date().getHours();
  if (h < 5)  return "night";
  if (h < 12) return "morning";
  if (h < 17) return "afternoon";
  if (h < 22) return "evening";
  return "night";
}

export function Greeting({ name }: { name?: string }) {
  const [fresh, setFresh] = useState<number | null>(null);
  useEffect(() => {
    fetch(u("/api/health"))
      .then((r) => r.json())
      .then((body) => setFresh(body.papers_today ?? null))
      .catch(() => setFresh(null));
  }, []);

  const tod = timeOfDay();
  const greet =
    tod === "morning"   ? "Good morning" :
    tod === "afternoon" ? "Good afternoon" :
    tod === "evening"   ? "Good evening" :
                          "Working late";

  return (
    <div className="text-sm text-slate-300">
      <span className="font-medium text-slate-100">{name ? `${greet}, ${name}` : greet}</span>
      {fresh !== null && fresh > 0 && (
        <span className="text-slate-400">
          {" "}· <span className="text-slate-200">{fresh}</span> fresh paper{fresh === 1 ? "" : "s"} ready
        </span>
      )}
    </div>
  );
}
