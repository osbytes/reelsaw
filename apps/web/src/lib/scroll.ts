/**
 * Scroll `el` into view inside `viewport` only. Unlike Element.scrollIntoView this never touches
 * other scrollable ancestors (the page), which is what made the whole app jump.
 */
export function scrollWithin(viewport: HTMLElement, el: HTMLElement, opts: { block?: "center" | "nearest"; behavior?: ScrollBehavior } = {}) {
  const vr = viewport.getBoundingClientRect();
  const er = el.getBoundingClientRect();
  const offsetTop = er.top - vr.top + viewport.scrollTop;
  let target = viewport.scrollTop;
  if (opts.block === "center") target = offsetTop - viewport.clientHeight / 2 + el.offsetHeight / 2;
  else if (er.top < vr.top) target = offsetTop - 8;
  else if (er.bottom > vr.bottom) target = offsetTop - viewport.clientHeight + el.offsetHeight + 8;
  else return;
  // Instant by default: smooth scrolling is dropped by browsers in background tabs and under load,
  // which left the transcript stuck. A sentence-sized jump every few seconds reads fine.
  viewport.scrollTo({ top: Math.max(0, target), behavior: opts.behavior ?? "auto" });
}

export function isVisibleWithin(viewport: HTMLElement, el: HTMLElement, slack = 8) {
  const vr = viewport.getBoundingClientRect();
  const er = el.getBoundingClientRect();
  return er.top >= vr.top - slack && er.bottom <= vr.bottom + slack;
}
