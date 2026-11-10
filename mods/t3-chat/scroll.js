// Where the conversation is scrolled to. The chat scrolls itself (rows placed by their heights,
// as the T3 mods' list.js does) because Herdr's lists either can't be scrolled from code or can't
// be asked where they are, and following a reply as it is written needs both.
// Checked by `node scroll.test.mjs`.
//
// follow: "end" keeps the latest in view; "anchor" holds a just-sent message at the top while its
// reply fits under it; "free" is the person reading back. The wheel decides between end and free,
// as in T3's timeline: leaving the end frees it, coming back to the end follows again.

const AT_END = 2; // px from the end that still count as at the end

// Each row's top, and the whole height.
export function layout(heights) {
  const tops = [];
  let total = 0;
  for (const height of heights) {
    tops.push(total);
    total += height;
  }
  return { tops, total };
}

// The furthest the content scrolls. Anchored, there is room under the reply for the sent message
// to sit at the top (T3 gives the last turn the viewport's height).
export function maxTop({ tops, total }, viewport, anchor = -1) {
  const room = anchor >= 0 ? tops[anchor] + viewport : 0;
  return Math.max(0, Math.max(total, room) - viewport);
}

// Where the view is this frame. Anchored: at the sent message, until its reply outgrows the
// viewport; then it follows the end.
export function settle({ top, follow }, content, viewport, anchor = -1) {
  if (follow === "anchor" && anchor >= 0) {
    if (content.total - content.tops[anchor] <= viewport) return { top: content.tops[anchor], follow };
    follow = "end";
  }
  const max = maxTop(content, viewport);
  if (follow === "end" || follow === "anchor") return { top: max, follow: "end" };
  return { top: Math.max(0, Math.min(top, max)), follow };
}

// The wheel moved by dy (positive: back, towards the start).
export function wheel({ top, follow }, dy, content, viewport) {
  const max = maxTop(content, viewport);
  const next = Math.max(0, Math.min(top - dy, max));
  if (next >= max - AT_END) return { top: max, follow: dy > 0 && max > 0 ? "free" : "end" };
  return { top: next, follow: dy > 0 || follow === "free" ? "free" : follow };
}

// A row's height became known or changed by delta: while reading back, what is on screen stays
// put when the row is above it.
export function resized({ top, follow }, rowTop, delta) {
  return follow === "free" && rowTop < top ? { top: top + delta, follow } : { top, follow };
}

// The rows to draw: those touching the viewport, and `overscan` px either side.
export function visibleRange({ tops }, heights, top, viewport, overscan = 400) {
  let first = 0;
  while (first < tops.length - 1 && tops[first] + heights[first] < top - overscan) first += 1;
  let end = first;
  while (end < tops.length && tops[end] < top + viewport + overscan) end += 1;
  return { first, end };
}

// The scrollbar's thumb: its length and where it sits in a track as tall as the viewport, or null
// when everything fits. total: the scrollable height (maxTop + viewport).
const MIN_THUMB = 24;
export function thumb(top, total, viewport) {
  if (total <= viewport + 1) return null;
  const size = Math.max(MIN_THUMB, (viewport * viewport) / total);
  return { size, offset: (top / (total - viewport)) * (viewport - size) };
}

// The thumb dragged by dy px from where the view was at `from`: the view moves in proportion.
// Reaching the end follows it again; anywhere else is reading back.
export function dragged(from, dy, total, viewport) {
  const bar = thumb(from, total, viewport);
  if (!bar) return { top: 0, follow: "end" };
  const max = total - viewport;
  const top = Math.max(0, Math.min(from + (dy * max) / (viewport - bar.size), max));
  return { top, follow: top >= max - AT_END ? "end" : "free" };
}

// A press on the track at y: the thumb's middle goes there.
export function trackPressed(y, total, viewport) {
  const bar = thumb(0, total, viewport);
  return bar ? dragged(0, y - bar.size / 2, total, viewport) : { top: 0, follow: "end" };
}
