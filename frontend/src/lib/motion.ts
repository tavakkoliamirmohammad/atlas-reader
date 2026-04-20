export function installMotionAttribute() {
  if (typeof document === "undefined") return;
  const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
  const apply = () => { document.documentElement.dataset.motion = mq.matches ? "off" : "on"; };
  apply();
  mq.addEventListener("change", apply);
}
