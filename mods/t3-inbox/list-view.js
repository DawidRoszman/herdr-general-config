import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { settings, layout, props, openOverlay } from "herdr";
import { glow, tip } from "./tip.js";
import { MOTION, planMotion, flying } from "./motion.js";
import { stop } from "./focus.js";
import { inboxTop } from "./filter.js";
import { FIRST, MORE } from "./row-model.js";

export const SLIM = 36, SHELF = 32;

export const STACK = 1, CARD_GAP = 5, LIST_TOP = 10;

export function inboxList(view, t, model, actions, drag, draw, cx) {
  const { list, every, sp, scope, kids, working, pinned, out, work, nap, put, busyRows, napRows, busy } = model;
  const { d, dragging, lifted, plan, cardH, rows, hot, aim, gap, others, placeholder, boundary, pinTo } = drag;
  const { card, slim } = draw;
  const { doomed } = actions;
  const zoom = Number(settings()?.zoom) || 1;
  const lit = (id, color) => view.hot === id ? t.foreground : color;
  const scoped = sp.filter((s) => scope.includes(s.id));
  const lane = (section, xs, draw, spacing) => drag.lane(section, xs, draw, spacing, fly);

  const shelf = (id, label, count, open, toggle, extra) => stop(view, t, id, h_flex().id(id).h(SHELF).mx(2).px(8).gap(8).flex_none().items_center()
    .text_size(12).font_medium().text_color(t.dim)
    .role("button").accessibility_label(`${open ? "Hide" : "Show"} ${label.toLowerCase()} agents`)
    .on_hover((on, cx) => {
      if (on) view.overShelf = id;
      else if (view.overShelf === id) view.overShelf = null;
      cx.notify();
    })
    .on_click((_e, cx) => {
      toggle();
      cx.notify();
    })
    .child(div().flex_1().child(label))
    .when(Boolean(extra), (el) => el.child(extra))
    .child(div().font_normal().child(String(count)))
    .child(svg(`mods/t3-inbox/icons/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(view.overShelf === id ? t.foreground : t.dim)));

  const heightOf = (kind, key) => view.rowH[`${kind}:${key}`] ?? (kind === "slim" ? SLIM + STACK : kind === "marker" ? SHELF + STACK : (view.cardH ?? 78) + CARD_GAP);

  const place = () => {
    const at = new Map(), gapH = plan?.section === "settled" ? SLIM + STACK : cardH + CARD_GAP;
    const put1 = (a, kind, y) => { const h = dragging && plan && a.address === d.from ? 0 : heightOf(kind, a.address); at.set(a.address, { y, h, kind, a }); return h; };
    const mark = (key, y, h = heightOf("marker", key)) => { at.set(key, { y, h, kind: "marker" }); return h; };
    let y = LIST_TOP + (dragging ? 24 : 0);
    for (const a of pinned) { if (dragging && plan?.gap === a.address) y += gapH; y += put1(a, "card", y); }
    if (dragging) y += (plan?.gap === "end-pinned" || plan?.gap === "head-pinned" ? gapH : 0) + 24;
    for (const a of out) { if (dragging && plan?.gap === a.address) y += gapH; y += put1(a, "card", y); }
    if (!out.length && dragging) y += 36 + CARD_GAP;
    if (!list.length) y += mark("m:empty", y);
    const shelf = [];
    let b = 0;
    if (work.length) { shelf.push(["m:working", "marker", b]); b += SHELF + STACK; for (const a of busyRows) { shelf.push([a, "work", b]); b += heightOf("work", a.address); } }
    if (nap.length) { shelf.push(["m:snoozed", "marker", b]); b += SHELF + STACK; for (const a of napRows) { shelf.push([a, "slim", b]); b += a.address === d?.from && dragging && plan ? 0 : SLIM + STACK; } }
    if (put.length || dragging) {
      shelf.push(["m:settled", "marker", b]); b += SHELF + STACK;
      for (const a of rows) { if (dragging && plan?.gap === a.address) b += gapH; shelf.push([a, "slim", b]); b += a.address === d?.from && dragging && plan ? 0 : SLIM + STACK; }
      if (view.open && put.length > view.limit) { shelf.push(["m:more", "marker", b]); b += SLIM; }
    }
    const base = Math.max(y, (view.listH ?? 0) - 8 - b);
    for (const [a, kind, off] of shelf) kind === "marker" ? mark(a, base + off) : put1(a, kind, base + off);
    return at;
  };
  {
    planMotion(view, [...place()].map(([key, v]) => ({ key, ...v })), cx, { freeze: dragging || view.sweep?.moved, from: view.landed });
    view.landed = null;
  }

  const fly = (key, kind, child) => {
    return flying(view, key, child).on_size_change((size) => { view.rowH[`${kind}:${key}`] = size.height / zoom + (kind === "card" || kind === "work" ? CARD_GAP : STACK); });
  };

  const leaving = (x) => {
    if (x.kind === "marker") return null;
    let drawn;
    if (!kids.has(x.key)) kids.set(x.key, []);
    try { drawn = x.kind === "slim" ? slim(x.a, true) : card(x.a, true); } catch { return null; }
    const away = view.motion.leaving;
    return div().id(`leaving-${x.key}-${view.motion.step}`).absolute().left(8).right(8).top(x.y + (away ? x.travel ?? 0 : 0))
      .opacity(away ? 0 : 1).transition("top", MOTION).transition("opacity", MOTION).child(drawn);
  };
  view.ticking = busyRows.length > 0 || pinned.some(working);

  const n = view.notice;
  const footer = (x) => !x?.hidden && ((x?.content?.mod === "t3-chrome" && Boolean(x.content.props?.footer)) || (x?.children ?? []).some(footer));
  const notice = n && !footer(layout()) && h_flex().id(`undo-notice-${n.gen}`).absolute().left(0).right(0).top(-24).h(24).px(10).gap(4).items_center()
    .bg(t.chrome).text_size(11).text_color(t.dim).opacity(n.shown ? 1 : 0).transition("opacity", { duration: 200, easing: "ease-out" })
    .child(div().min_w(0).truncate().child(`${n.action} ${n.count} agent${n.count === 1 ? "" : "s"},`))

    .when(n.live, (el) => el.child(div().id("undo-notice-undo").flex_none().font_medium().text_color(t.foreground).hover((s) => s.underline())
      .role("button").accessibility_label("Undo")
      .on_click((_e, cx) => {
        cx.stop_propagation();
        view.undo(cx);
      })
      .child("Undo")));

  const shelves = v_flex().id("shelves").relative().gap(STACK).flex_none()
    .when(Boolean(notice), (el) => el.child(notice))
    .when(work.length > 0, (el) => el
      .child(fly("m:working", "marker", shelf("working-header", "Working", work.length, view.workOpen, () => {
        view.workOpen = !view.workOpen;
        localStorage.setItem("working-open", String(view.workOpen));
      }).on_mouse_move((_e, cx) => aim(null, cx))))
      .child(v_flex().py(2).gap(CARD_GAP).children(busyRows.map((a) => fly(a.address, "work", card(a))))));

  const napShelf = v_flex().id("snoozed").gap(STACK).flex_none()
    .child(fly("m:snoozed", "marker", shelf("snoozed-header", "Snoozed", nap.length, view.napOpen, () => {
      view.napOpen = !view.napOpen;
      localStorage.setItem("snoozed-open", String(view.napOpen));
    }).on_mouse_move((_e, cx) => aim(null, cx))))
    .children(lane("snoozed", napRows, (a) => slim(a), 0));

  if (doomed.length === 0 && view.hot === "settled-clear") view.hot = null;
  const clearButton = doomed.length > 0 && tip(view, t, "settled-clear", "Clear settled agents", stop(view, t, "settled-clear", h_flex().id("settled-clear").h(20).px(6).flex_none().items_center().rounded(4).text_size(11)
    .text_color(lit("settled-clear", t.dim)).on_hover(glow(view, "settled-clear"))
    .role("button").accessibility_label("Clear settled agents")
    .on_click((_e, cx) => {
      cx.stop_propagation();
      view.hot = null;
      const ask = {
        title: `Close ${doomed.length} pane${doomed.length === 1 ? "" : "s"}?`,
        detail: "This ends the terminals of your settled agents. The tab you're on stays.",
        command: { name: "t3-inbox.clear" },
      };

      openOverlay(props()?.home ? { mod: "t3-actions", kind: "dialog", frame: "none", width: 512, props: { actions: "confirm", ...ask } }
        : { mod: "confirm", kind: "dialog", width: 400, height: 170, props: ask });
      cx.notify();
    })
    .child("Clear"), 4));
  const tail = v_flex().id("settled").gap(STACK).flex_none()
    .child(fly("m:settled", "marker", shelf("settled-header", "Settled", put.length, view.open, () => {
      view.open = !view.open;
      view.limit = FIRST;
      localStorage.setItem("open", String(view.open));
    }, clearButton).on_mouse_move((_e, cx) => aim({ section: "settled" }, cx))

      .when(dragging, (el) => el.text_color(hot("settled") ? t.accent : t.foreground))))
    .when(dragging && others(rows).length === 0 && !(rows.length > 0 && !plan), (el) => el
      .child(plan?.gap === "head-settled" ? gap("head-settled") : placeholder("settled", "Settled")))
    .children(lane("settled", rows, (a) => slim(a), 0))
    .when(view.open && put.length > view.limit, (el) => el.child(fly("m:more", "marker", stop(view, t, "settled-more", h_flex().id("settled-more").h(SLIM).px(10).gap(10).flex_none().items_center().rounded(6)
      .text_color(lit("settled-more", t.dim)).hover((s) => s.bg(t.hover)).active((s) => s.bg(t.selected)).on_hover(glow(view, "settled-more"))
      .role("button").accessibility_label("Show more settled agents")
      .on_click((_e, cx) => {
        view.hot = null;
        view.limit += MORE;
        cx.notify();
      })
      .child(svg("mods/t3-inbox/icons/chevron-down.svg").size(16).flex_none())
      .child(`Show ${Math.min(MORE, put.length - view.limit)} more`)))));

  const top = inboxTop(view, t, model);
  const body = v_flex().id("inbox-list").relative().flex_1().min_h(0).px(8).pt(LIST_TOP).pb(8).overflow_y_scroll()
      .on_size_change((size) => { view.listH = size.height / zoom; })

      .children(view.motion?.exits.map(leaving).filter(Boolean) ?? [])
      .child(boundary("pinned", "Pinned", "pinned", pinTo(others(pinned)[0]?.address)))
      .child(gap("head-pinned"))
      .children(lane("pinned", pinned, (a) => card(a), CARD_GAP))
      .child(boundary("active", "Active", "active", { section: "active" }))
      .when(dragging && others(out).length === 0 && !(out.length > 0 && !plan), (el) => el
        .child(plan?.gap === "head-active" ? gap("head-active") : placeholder("active", "Active")))
      .children(lane("active", out, (a) => card(a), CARD_GAP))

      .when(list.length === 0, (el) => el.child(fly("m:empty", "marker", div().px(8).py(24).text_center().text_size(12).line_height("16px").text_color(t.dim)
        .child(!every.length ? "Nothing here yet. Agents and panes that report a status show up here."
          : scoped.length > 1 ? "Nothing in these spaces yet" : `Nothing in ${scoped[0].name} yet`))))

      .child(div().id("active-rest").flex_1().min_h(0).on_mouse_move((_e, cx) => aim({ section: "active" }, cx)))
      .child(shelves.when(nap.length > 0, (el) => el.child(napShelf)).when(put.length > 0 || (dragging && !busy(lifted)), (el) => el.child(tail)));
  return { top, list: body };
}
