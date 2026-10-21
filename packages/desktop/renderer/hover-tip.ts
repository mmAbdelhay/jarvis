// A hover tooltip for topbar controls. The native `title` tooltip is easy to
// miss inside the topbar's drag region, and a CSS ::after one would be cut
// off by the topbar's own `overflow: hidden`, so this draws one element on
// <body>, fixed under the control and kept inside the window. The text is
// read from data-tip at hover time, so a control that relabels itself (the
// keep-awake button) shows its current label.

export function attachHoverTip(target: HTMLElement): void {
  let tip: HTMLElement | undefined;

  const hide = (): void => {
    tip?.remove();
    tip = undefined;
  };

  target.addEventListener("mouseenter", () => {
    const text = target.dataset.tip;
    if (text === undefined || text === "") return;
    hide();
    tip = document.createElement("div");
    tip.className = "hover-tip";
    tip.setAttribute("role", "tooltip");
    tip.textContent = text;
    document.body.append(tip);
    const rect = target.getBoundingClientRect();
    const width = tip.offsetWidth;
    const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
    tip.style.left = `${left}px`;
    tip.style.top = `${rect.bottom + 6}px`;
  });
  target.addEventListener("mouseleave", hide);
  target.addEventListener("click", hide);
}
