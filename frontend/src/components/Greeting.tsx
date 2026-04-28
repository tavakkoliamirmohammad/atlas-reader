function timeOfDay(): "morning" | "afternoon" | "evening" | "night" {
  const h = new Date().getHours();
  if (h < 5)  return "night";
  if (h < 12) return "morning";
  if (h < 17) return "afternoon";
  if (h < 22) return "evening";
  return "night";
}

export function Greeting({ name }: { name?: string }) {
  const tod = timeOfDay();
  const greet =
    tod === "morning"   ? "Good morning" :
    tod === "afternoon" ? "Good afternoon" :
    tod === "evening"   ? "Good evening" :
                          "Working late";

  return (
    <div className="text-sm text-slate-300">
      <span className="font-medium text-slate-100">{name ? `${greet}, ${name}` : greet}</span>
    </div>
  );
}
