import { div } from "gpui-kit";
import { shared, setShared } from "herdr";

const MODE = "t3-focus";

const POOL = 64;

const TICK = 150;

const LOST_TICKS = 3;

export function stopsInit(view, cx, kind) {
  view.fs = { handles: new Map(), free: Array.from({ length: POOL }, () => cx.focus_handle()), modal: kind === "modal", me: String(Math.random()), keyboard: false, watch: null, last: null, hold: null };

  if (!globalThis.t3FocusRun) { globalThis.t3FocusRun = true; if (shared(MODE)) setShared(MODE, null); }
}

export function stopsEnd(view) {
  if (view.fs && shared(MODE) === view.fs.me) setShared(MODE, null);
}

function handleOf(s, id) {
  let h = s.handles.get(id);
  if (!h && s.free.length) { h = s.free.pop(); s.handles.set(id, h); }
  return h;
}

export function onStop(view) {
  const s = view.fs;
  if (!s?.keyboard) return null;
  for (const [id, h] of s.handles) if (h.is_focused()) return id;
  return null;
}

export const within = (view, ids) => ids.includes(onStop(view));

function watch(view, cx) {
  const s = view.fs;
  if (s.watch) return;
  let lost = 0, seen = onStop(view);
  s.watch = cx.timer.every(TICK, (cx) => {
    const id = onStop(view);
    if (id !== seen) { seen = id; cx.notify(); }
    if (id || s.hold?.()) { lost = 0; s.last = id ?? s.last; return; }
    if (++lost < LOST_TICKS) return;
    s.watch.cancel();
    s.watch = null;
    s.keyboard = false;
    if (shared(MODE) === s.me) setShared(MODE, null);
    cx.notify();
  });
}

export function enter(view, cx, first) {
  const s = view.fs, h = handleOf(s, s.last ?? first);
  s.last = null;
  s.keyboard = true;
  setShared(MODE, s.me);
  h?.focus();
  watch(view, cx);
  cx.notify();
}

export const pressed = (view) => { view.pressAt = Date.now(); };
export function justClosed(view, key) {
  const closing = view.pressAt != null && (shared(key) ?? 0) >= view.pressAt - 50;
  view.pressAt = null;
  return closing;
}

export function focusRoot(view, el) {
  const s = view.fs;
  if (!s.modal && !shared(MODE)) {
    s.free.push(...s.handles.values());
    s.handles.clear();
    return el;
  }
  return el
    .on_key_up((e, cx) => {
      if (e.key !== "tab") return;
      s.keyboard = true;
      const id = onStop(view);
      if (!id) { s.keyboard = false; return; }
      s.last = id;
      while (s.free.length < POOL / 4) s.free.push(cx.focus_handle());
      if (!s.modal) setShared(MODE, s.me);
      watch(view, cx);
      cx.notify();
    })
    .on_mouse_down("left", (_e, cx) => { s.keyboard = false; cx.notify(); });
}

export function stop(view, t, id, el, radius = 6, { enter: act, handle } =  ({})) {
  const s = view.fs;
  if (!s.modal && !shared(MODE)) return el;
  if (handle) s.handles.set(id, handle);

  const h = handleOf(s, id);
  if (!h) return el;
  return el.track_focus(h).tab_index(0)

    .when(!s.modal, (e) => e.on_mouse_down("left", () => { if (!s.watch) setShared(MODE, null); }))
    .when(Boolean(act), (e) => e.on_key_down((k, cx) => {

      if ((k.keystroke !== "enter" && k.keystroke !== "space") || !h.is_focused()) return;
      cx.stop_propagation();
      act();
      cx.notify();
    }))
    .when(s.keyboard && h.is_focused(), (e) => e.relative().child(div().absolute().inset_0().rounded(radius).border(2).border_color(t.accent)));
}
