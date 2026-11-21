const AT_END = 2;

export function layout(heights) {
  const tops = [];
  let total = 0;
  for (const height of heights) {
    tops.push(total);
    total += height;
  }
  return { tops, total };
}

export function maxTop({ tops, total }, viewport, anchor = -1) {
  const room = anchor >= 0 ? tops[anchor] + viewport : 0;
  return Math.max(0, Math.max(total, room) - viewport);
}

export function settle({ top, follow }, content, viewport, anchor = -1) {
  if (follow === "anchor" && anchor >= 0) {
    if (content.total - content.tops[anchor] <= viewport) return { top: content.tops[anchor], follow };
    follow = "end";
  }
  const max = maxTop(content, viewport);
  if (follow === "end" || follow === "anchor") return { top: max, follow: "end" };
  return { top: Math.max(0, Math.min(top, max)), follow };
}

export function wheel({ top, follow }, dy, content, viewport) {
  const max = maxTop(content, viewport);
  const next = Math.max(0, Math.min(top - dy, max));
  if (next >= max - AT_END) return { top: max, follow: dy > 0 && max > 0 ? "free" : "end" };
  return { top: next, follow: dy > 0 || follow === "free" ? "free" : follow };
}

export function resized({ top, follow }, rowTop, delta) {
  return follow === "free" && rowTop < top ? { top: top + delta, follow } : { top, follow };
}

export function visibleRange({ tops }, heights, top, viewport, overscan = 400) {
  let first = 0;
  while (first < tops.length - 1 && tops[first] + heights[first] < top - overscan) first += 1;
  let end = first;
  while (end < tops.length && tops[end] < top + viewport + overscan) end += 1;
  return { first, end };
}

const MIN_THUMB = 24;
export function thumb(top, total, viewport) {
  if (total <= viewport + 1) return null;
  const size = Math.max(MIN_THUMB, (viewport * viewport) / total);
  return { size, offset: (top / (total - viewport)) * (viewport - size) };
}

export function dragged(from, dy, total, viewport) {
  const bar = thumb(from, total, viewport);
  if (!bar) return { top: 0, follow: "end" };
  const max = total - viewport;
  const top = Math.max(0, Math.min(from + (dy * max) / (viewport - bar.size), max));
  return { top, follow: top >= max - AT_END ? "end" : "free" };
}

export function trackPressed(y, total, viewport) {
  const bar = thumb(0, total, viewport);
  return bar ? dragged(0, y - bar.size / 2, total, viewport) : { top: 0, follow: "end" };
}
