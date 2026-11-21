import { div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { POINTER_WATCH, pointerAt, pointerGone, pointerMoved } from "./tip.js";

export function programIcon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

export const detailsLive = (view) => Boolean(view.details) || Date.now() - (view.detailsClosed ?? 0) < 400;

function fadeOut(view, key, cx) {
  view.detailsFade?.cancel();
  view.detailsOut = key;
  view.detailsFade = cx.timer.after(150, (cx) => {
    view.detailsOut = null;
    cx.notify();
  });
}

export const detailsAt = (view, key, e) => { pointerMoved(e.position); view.detailsBox = { key, box: e.bounds }; };

export function detailsWatch(view, key, cx) {
  view.detailsWatch?.cancel();
  const stop = () => { view.detailsWatch.cancel(); view.detailsWatch = null; };

  const from = pointerAt();
  view.detailsWatch = cx.timer.every(POINTER_WATCH, (cx) => {
    if (![view.hovered, view.overTab, view.details].includes(key) && !view.detailsWait) return stop();
    if (!pointerGone(view.detailsBox?.key === key ? view.detailsBox.box : null, from)) return;
    stop();
    if (view.hovered === key) view.hovered = null;
    if (view.overTab === key) view.overTab = null;
    view.hot = null;
    detailsFor(view, null, cx);
    cx.notify();
  });
}

export function detailsFor(view, key, cx) {
  if (!key) view.detailsHold = null;
  view.detailsWait?.cancel();
  view.detailsWait = null;
  if (key) detailsWatch(view, key, cx);

  if (!key && !view.details) return;
  if (!key) {
    view.detailsClosed = Date.now();
    fadeOut(view, view.details, cx);
    view.details = null;
    return;
  }
  const live = detailsLive(view);
  if (view.detailsOut === key) {
    view.detailsFade?.cancel();
    view.detailsOut = null;
  }
  if (live) {
    if (view.details && view.details !== key) fadeOut(view, view.details, cx);
    view.details = key;
    view.detailsIn = true;
    return;
  }
  view.detailsWait = cx.timer.after(150, (cx) => {
    view.details = key;
    view.detailsIn = false;
    cx.notify();
    view.detailsWait = cx.timer.after(34, (cx) => {
      view.detailsWait = null;
      view.detailsIn = true;
      cx.notify();
    });
  });
}

export const detailsLine = (t, mark, text) => h_flex().gap(8).min_w(0).items_center().child(mark).child(div().min_w(0).truncate().text_color(t.foreground + "bf").child(text));

const detailsFade =  ({ duration: 150, easing: "ease-out" });
export function detailsCard(view, t, key, title, lines, { wrap, hide, from = -4 } =  ({})) {
  const shown = view.details === key && view.detailsIn && !hide;
  return v_flex().id(`details-card-${key}`).max_w(320).p(12).gap(8).rounded(6).border(1).border_color(t.border)

    .bg(t.chrome).shadow_xl().text_size(12).line_height("16px").opacity(shown ? 1 : 0).left(shown ? 0 : from).transition("opacity", detailsFade).transition("left", detailsFade)
    .child(div().min_w(0).when(!wrap, el => el.truncate()).line_height(1.25).font_medium().text_color(t.foreground).child(title))
    .child(v_flex().pl(2).gap(6).children(lines.filter(Boolean)));
}
