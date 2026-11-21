import { div } from "gpui-kit";
import { settings } from "herdr";

export function step(e, at, n) {
  if (!n || (e.key !== "down" && e.key !== "up")) return -1;
  return e.key === "down" ? (at + 1) % n : (at <= 0 ? n : at) - 1;
}

export function menuJump(view, e, labels, at) {
  const moved = step(e, at, labels.length);
  if (moved >= 0) return moved;
  if (e.key === "home") return 0;
  if (e.key === "end") return labels.length - 1;
  if (!e.key_char?.trim() || e.modifiers?.control || e.modifiers?.platform || e.modifiers?.alt) return -1;
  const now = Date.now();
  view.typed = now - (view.typedAt ?? -Infinity) < 750 ? view.typed + e.key_char.toLowerCase() : e.key_char.toLowerCase();
  view.typedAt = now;
  const same = [...view.typed].every((c) => c === view.typed[0]), word = same ? view.typed[0] : view.typed;
  for (let i = 0; i < labels.length; i++) {
    const k = (Math.max(at + (same ? 1 : 0), 0) + i) % labels.length;
    if (labels[k].toLowerCase().startsWith(word)) return k;
  }
  return -1;
}

export function scrollList(view, id, { count, row, at = -1, height, draw, wheeled }) {
  const seen = height ?? view.listHeight?.[id], max = seen === undefined ? 0 : Math.max(0, count * row - seen);
  let top = Math.max(0, Math.min(view.scrollTop?.[id] ?? 0, max));

  const pointed = view.pointerY?.[id] === undefined ? -1 : Math.floor((view.pointerY[id] + top) / row);
  if (at >= 0 && at < count && at !== pointed && seen !== undefined) top = Math.max(0, Math.min(top, at * row, max), (at + 1) * row - seen);
  view.scrollTop = { ...view.scrollTop, [id]: top };
  const first = seen === undefined ? 0 : Math.floor(top / row), end = seen === undefined ? count : Math.min(count, Math.ceil((top + seen) / row));
  const rows = [];
  for (let i = first; i < end; i++) rows.push(draw(i).absolute().left(0).right(0).top(i * row - top));
  return div().id(id).relative().overflow_hidden()
    .when(height !== undefined, (el) => el.flex_none().h(height))
    .when(height === undefined, (el) => el.on_size_change((size, cx) => {
      const h = size.height / (Number(settings()?.zoom) || 1);
      if (h !== seen) { view.listHeight = { ...view.listHeight, [id]: h }; cx.notify(); }
    }))
    .on_mouse_move((e) => { view.pointerY = { ...view.pointerY, [id]: e.local_position.y / (Number(settings()?.zoom) || 1) }; })
    .on_hover((on) => { if (!on) view.pointerY = { ...view.pointerY, [id]: undefined }; })

    .on_scroll_wheel((e, cx) => {

      cx.stop_propagation();
      const from = view.scrollTop[id], next = Math.max(0, Math.min(from - e.delta.y / (Number(settings()?.zoom) || 1), max));
      if (next === from) return;
      view.scrollTop = { ...view.scrollTop, [id]: next };
      wheeled(at < 0 ? -1 : Math.min(Math.max(at, Math.ceil(next / row)), Math.floor((next + seen) / row) - 1), cx);
      cx.notify();
    })
    .children(rows);
}
