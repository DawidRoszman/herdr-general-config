import { div } from "gpui-kit";
import { v_flex, Popup } from "gpui-base";
import { keys, window } from "herdr";

export function keyOf(action) {
  const k = keys().find(b => b.action === action);
  if (!k?.keys.trim()) return "";
  const mac = window()?.platform === "macos";
  const names = mac ? { ctrl: "⌃", alt: "⌥", shift: "⇧", cmd: "⌘", fn: "fn" } : { ctrl: "Ctrl", alt: "Alt", shift: "Shift", cmd: "Super", fn: "Fn" };
  const alias = { secondary: mac ? "cmd" : "ctrl", super: "cmd", win: "cmd" };
  return k.keys.trim().split(/\s+/).map(stroke => {
    const parts = stroke.split("-");
    let key = parts.pop();
    if (key === "") { key = "-"; parts.pop(); }
    const held = new Set(parts.map(m => alias[m.toLowerCase()] ?? m.toLowerCase()));
    if (/^[A-Z]$/.test(key)) held.add("shift");
    const label = key.length === 1 ? key.toUpperCase() : key[0].toUpperCase() + key.slice(1).toLowerCase();
    return [...Object.keys(names).filter(m => held.has(m)).map(m => names[m]), label].join(mac ? "" : "+");
  }).join(" ");
}

export const POINTER_WATCH = 100;
export const pointerAt = () => globalThis.window.mouse_position?.();
const track = { at: null, step: { x: 0, y: 0 } };
export function pointerMoved(p) {
  if (!p) return;
  if (track.at) track.step = { x: p.x - track.at.x, y: p.y - track.at.y };
  track.at = p;
}
export function pointerGone(box, from) {
  const p = pointerAt(), size = globalThis.window.viewport_size?.();
  if (p && size && track.at?.x === p.x && track.at.y === p.y) {
    const x = p.x + 2 * track.step.x, y = p.y + 2 * track.step.y;
    if (x < 0 || y < 0 || x >= size.width || y >= size.height) return true;
  }
  if (!box) return Boolean(p && from) && (p.x !== from.x || p.y !== from.y);
  return Boolean(p) && !(p.x >= box.x && p.x < box.x + box.width && p.y >= box.y && p.y < box.y + box.height);
}

export const dragGone = (box) => window()?.active === false || pointerGone(box);

const tips = new Map(), FADE =  ({ duration: 150, easing: "ease-out" });
let opened = 0;

function dropTip(id, s) {
  s.timer?.cancel();
  s.watch?.cancel();
  if (tips.get(id) === s) tips.delete(id);
}

function leaveTip(id, s, cx) {
  s.timer?.cancel();
  s.watch?.cancel();
  if (!s.open) return dropTip(id, s);
  s.closing = true;
  s.timer = cx.timer.after(FADE.duration, (cx) => { dropTip(id, s); cx.notify(); });
}

export function tip(view, t, id, label, trigger, { action, hint, below, delay = 150, off } =  ({})) {
  const key = action ? keyOf(action) : "", hot = off ? null : view.hot, s = tips.get(id), shown = hot === id && s?.drawn;
  const watch = (s, cx) => {
    s.watch = cx.timer.every(POINTER_WATCH, (cx) => {
      if (!pointerGone(s.box, s.from)) return;
      if (view.hot === id) view.hot = null;
      leaveTip(id, s, cx);
      cx.notify();
    });
  };
  const hover = (on, cx) => {
    const was = tips.get(id);
    if (!on) return was && leaveTip(id, was, cx);
    if (was?.closing) {
      was.timer.cancel();
      was.closing = false;
      return watch(was, cx);
    }
    if (was) dropTip(id, was);
    const next = { n: ++opened, from: pointerAt() };
    tips.set(id, next);
    next.timer = cx.timer.after(delay, (cx) => { next.open = true; cx.notify(); });
    watch(next, cx);
  };
  return Popup.new(`tip-${id}`, div().id(`tip-over-${id}`).on_hover(hover).on_mouse_move((e) => { pointerMoved(e.position); const at = tips.get(id); if (at) at.box = e.bounds; }).child(trigger)).anchor(below ? "top_center" : "bottom_center")

    .when(Boolean(s?.open && (hot === id || s.closing)), pop => pop.content(v_flex().id(`tip-body-${id}-${s.n}`)
      .opacity(shown ? 1 : 0).top(shown ? 0 : below ? -4 : 4).transition("opacity", FADE).transition("top", FADE)
      .on_size_change((_size, cx) => { if (tips.get(id) !== s || s.drawn) return; s.drawn = true; cx.notify(); }).when(below, el => el.mt(4)).when(!below, el => el.mb(4)).max_w(320).px(8).py(4).gap(2).rounded(6).border(1).border_color(t.border).bg(t.chrome).shadow_md().text_size(12).line_height(1.375).text_color(t.foreground)
      .child(div().child(key ? `${label} (${key})` : label))
      .when(Boolean(hint), el => el.child(div().text_color(t.muted).child(hint)))));
}

export const glow = (view, id) => (on, cx) => {
  if (on) view.hot = id;
  else if (view.hot === id) view.hot = null;
  cx.notify();
};

export function hoverKept(view, key, id, el) {
  return el.on_hover((on, cx) => {
    if (on) {
      view[key] = id;
      view.keptBox = null;
      view.keptWatch?.cancel();
      const from = pointerAt();
      view.keptWatch = cx.timer.every(POINTER_WATCH, (cx) => {
        if (view[key] === id && !pointerGone(view.keptBox, from)) return;
        view.keptWatch.cancel();
        if (view[key] === id) { view[key] = null; cx.notify(); }
      });
    } else if (view[key] === id) view[key] = null;
    cx.notify();
  }).on_mouse_move((e) => { pointerMoved(e.position); if (view[key] === id) view.keptBox = e.bounds; });
}

export function tipMark(view, t, id, label, mark, options) {
  if (!label) return mark;
  const lit = div().id(id).flex_none().on_hover(glow(view, id)).child(mark);
  return tip(view, t, id, label, lit, options);
}
