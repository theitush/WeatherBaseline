// Shared chart-tooltip positioning. The tooltip is position:fixed (viewport
// coords), so it can run off-screen when a hovered point sits near an edge.
// placeTooltip puts it up-and-to-the-right of the cursor by default, then flips
// to the left and/or pushes it inward only when the preferred side would
// overflow — so a tooltip is always fully visible regardless of where the point
// is. Call it AFTER setting the tooltip's html, so its measured size is final.

const PAD = 8; // min gap kept between the tooltip and the viewport edge

export function placeTooltip(
  node: HTMLElement | null,
  event: { clientX: number; clientY: number }
): void {
  if (!node) return;
  const { width: tw, height: th } = node.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  let left = event.clientX + 12;
  if (left + tw + PAD > vw) left = event.clientX - 12 - tw; // flip to the left
  left = Math.max(PAD, Math.min(left, vw - tw - PAD));

  let top = event.clientY - 28;
  top = Math.max(PAD, Math.min(top, vh - th - PAD));

  node.style.left = left + 'px';
  node.style.top = top + 'px';
}
