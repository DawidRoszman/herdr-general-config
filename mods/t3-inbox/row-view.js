import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Popup } from "gpui-base";
import { settings, shared } from "herdr";
import { namer } from "./name.js";
import { projectMark } from "./project.js";
import { glow, tip, tipMark } from "./tip.js";
import { MOTION } from "./motion.js";
import { programIcon, detailsLive, detailsFor, detailsLine, detailsCard } from "./details.js";
import { stop, within } from "./focus.js";
import { snoozeButton } from "./snooze.js";
import { SLIM } from "./list-view.js";
import { accountChip } from "./account.js";

const icon = programIcon;

function ago(ms, now) {
  const m = Math.floor((now - ms) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h`;
  return `${Math.floor(m / 1440)}d`;
}

function took(ms, now) {
  const s = Math.max(0, Math.floor((now - ms) / 1000)), m = Math.floor(s / 60);
  return s < 60 ? `${s}s` : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

function left(ms, now) {
  const m = Math.max(1, Math.ceil((ms - now) / 60000));
  return m < 60 ? `${m}m` : m < 1440 ? `${Math.ceil(m / 60)}h` : `${Math.ceil(m / 1440)}d`;
}

export function inboxRowView(view, t, model, actions, drag) {
  const { now, ps, sp, state, viewing, kids, running, woke, busy, pins, started, since, wake, hidden, napUntil, settledAt } = model;
  const { settle, unsettle, away, pick } = actions;
  const { dragging, plan, verb, badge, swept, row, open, sweepFrom, justDropped } = drag;
  const zoom = Number(settings()?.zoom) || 1;
  const title = namer();
  const hover = (a) => (on, cx) => {
    if (on) { view.hovered = a.address; detailsFor(view, a.address, cx); }
    else if (view.hovered === a.address) { view.hovered = null; detailsFor(view, null, cx); }
    cx.notify();
  };

  const lit = (id, color) => (view.hot === id ? t.foreground : color);

  const avatar = (id, name, size) => projectMark(sp.find((s) => s.id === id) ?? { name: name ?? "" }, size, t, ps);

  const delay = detailsLive(view) ? 0 : 150;
  const machineOf = (a) => a.address.includes("/") ? a.address.split("/")[0] : null;

  const order = shared("t3-inbox.rows")?.order ?? [];
  const number = (a, ghost) => {
    const n = ghost ? 0 : order.indexOf(a.address) + 1;
    return div().w(8).flex_none().text_size(10.5).text_color(t.dim).opacity(0.7)
      .font_family(settings().font_family ?? "JetBrains Mono").child(n >= 1 && n <= 9 ? String(n) : "");
  };
  const branchOf = (a) => ps.find((p) => p.pane === a.pane)?.branch;

  const details = (a) => {
    const machine = machineOf(a), branch = branchOf(a), pic = icon(a.program, 12, t.muted);
    const up = view.details === a.address || view.detailsOut === a.address;
    return Popup.new(`details-${a.address}`, div()).absolute().top(-1).right(-1).size(1)
      .when(up && !view.napMenu && !dragging && !view.sweep?.moved, (pop) => pop.content(detailsCard(view, t, a.address, title(a), [
        a.space_name && detailsLine(t, avatar(a.space, a.space_name, 12), a.space_name),
        machine && detailsLine(t, svg("mods/t3-inbox/icons/server.svg").size(12).flex_none().text_color(t.muted), machine),
        branch && detailsLine(t, svg("mods/t3-inbox/icons/git-branch.svg").size(12).flex_none().text_color(t.muted), branch),
        pic && detailsLine(t, div().flex_none().opacity(0.6).child(pic), a.program.name),
      ], { hide: Boolean(view.hot) || view.detailsHold === a.address }).ml(4)));
  };

  const card = (a, ghost) => {
    const st = state(a), on = viewing(a);
    const machine = machineOf(a), branch = branchOf(a);
    const going = (kids.get(a.address) ?? []).filter((s) => s === "working").length;

    const meta = [branch !== title(a) && branch, going ? `${going} sub-agent${going > 1 ? "s" : ""} working` : null].filter(Boolean).join(" · ");
    const pic = icon(a.program, 14, t.muted);

    const canNap = !ghost && !a.mod && st !== "blocked", menu = canNap && view.napMenu === a.address;

    const over = !dragging && !view.sweep?.moved && (menu || view.hovered === a.address || within(view, [`card-${a.address}`, `settle-${a.address}`, `snooze-${a.address}`, `woke-${a.address}`]));

    const leads = on || ghost || st === "blocked" || st === "done" || woke(a);
    const account = a.mod ? null : accountChip(view, t, ghost ? null : `acct-${a.address}`, a.address, { isOnlyOtherProfile: true });
    const marks = machine || pic || account ? h_flex().gap(4).flex_none().items_center()
      .when(Boolean(account), (el) => el.child(account))

      .when(Boolean(machine), (el) => el.child(h_flex().when(!ghost, (m) => m.id(`machine-${a.address}`).accessibility_label(`On ${machine}`))
        .gap(3).flex_none().items_center().text_size(11).text_color(t.dim)
        .child(svg("mods/t3-inbox/icons/server.svg").size(14).flex_none().text_color(t.dim))
        .child(div().max_w(96).truncate().child(machine))))
      .when(Boolean(pic), (el) => el.child(div().flex_none().opacity(0.6).child(pic))) : null;

    const offer = over && !busy(a);
    const id = `settle-${a.address}`;
    const napOffer = canNap && over;

    const pill = (color, mark, label, time) => h_flex().id(`state-${a.address}`).h(20).gap(4).flex_none().items_center().font_medium().text_color(color)
      .child(mark).child(div().child(label))
      .when(Boolean(time), (el) => el.children(time.split(" ").map((part) => div().font_family(settings().font_family ?? "JetBrains Mono").child(part))));

    const wokeMark = woke(a) && tip(view, t, `woke-${a.address}`, "Dismiss Woke notification", stop(view, t, `woke-${a.address}`, h_flex().id(`woke-${a.address}`).h(20).gap(4).flex_none().items_center().font_medium().text_color(t.blocked)
      .hover((s) => s.underline()).on_hover(glow(view, `woke-${a.address}`)).role("button").accessibility_label("Dismiss Woke notification")
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => {
        cx.stop_propagation();
        view.hot = null;
        wake(a, cx);
        cx.notify();
      })
      .child(svg("mods/t3-inbox/icons/alarm-clock.svg").size(16).flex_none().text_color(t.blocked)).child("Woke"), 4), { delay });
    const acting = offer || napOffer, quiet = acting && (menu || !woke(a));

    const word = running(a)
        ? pill(t.working, svg("mods/workspace-chrome/spinner.svg").size(16).flex_none().text_color(t.working).spin(900),
          "Working", started(a) > 0 && started(a) < Infinity ? took(started(a), now) : null)
        : st === "blocked"
          ? pill(t.blocked, div().size(16).flex_none().rounded(4).bg(t.blocked + "26").text_size(11).font_bold().flex().items_center().justify_center().child("!"), "Needs you")
          : wokeMark
            || (st === "done"
              ? pill(t.ansi2, svg("mods/t3-inbox/icons/circle-check.svg").size(16).flex_none().text_color(t.ansi2), "Done")
              : div().id(`state-${a.address}`).flex_none().child(since(a) > 0 ? ago(since(a), now) : ""));

    const status = running(a) && wokeMark ? h_flex().gap(4).flex_none().items_center().when(!acting, (el) => el.child(word)).child(wokeMark) : word;

    const clock = canNap && snoozeButton(view, t, a, { now, offer: napOffer, delay }, pick);
    const corner = ghost ? (verb ? badge(verb) : div())
      : swept(a) ? badge("settle")

      : h_flex().id(`corner-${a.address}`).relative().h(20).min_w(32).gap(4).flex_none().items_center().justify_end()
        .when(acting, (el) => el.on_hover((on, cx) => { view.detailsHold = on ? a.address : null; cx.notify(); }))
        .child(div().flex_none().when(quiet, (el) => el.absolute().top(0).right(0)).opacity(quiet ? 0 : 1).transition("opacity", MOTION).child(status))
        .child(h_flex().id(`controls-${a.address}`).h(20).flex_none().items_center().when(!acting, (el) => el.absolute().top(0).right(0))
        .when(Boolean(clock), (el) => el.child(clock))
        .child(div().when(!offer, (el) => el.absolute().top(0).right(0)).child(tip(view, t, id, a.mod ? "Settle and close" : "Settle agent", h_flex().id(id).h(20).px(6).mr(-4).gap(4).flex_none().items_center().rounded(6)
        .text_size(12).text_color(lit(id, t.muted)).opacity(offer ? 1 : 0).transition("opacity", MOTION)

        .when(offer, (el) => el.on_hover(glow(view, id)).role("button").accessibility_label(a.mod ? "Settle and close" : "Settle").when(!a.mod, (b) => b.on_mouse_down("left", sweepFrom("settle", a))).on_click((_e, cx) => {
          cx.stop_propagation();
          if (justDropped()) return;

          view.sweep = null;
          settle([a], cx);
          cx.notify();
        }))
        .child(svg("mods/t3-inbox/icons/check.svg").size(14).flex_none().text_color(lit(id, t.muted)))
        .child("Settle")
        .when(offer, (el) => stop(view, t, id, el, 6)), { action: "t3-tabs.settle", delay }))));

    const base = v_flex().id(`${ghost ? "ghost-" : ""}card-${a.address}`).px(10).py(8).flex_none().rounded(6)

      .when(!ghost, (el) => el.opacity(running(a) && !woke(a) && !on && !over ? 0.7 : 1).transition("opacity", MOTION));
    return (ghost ? base : row(base, a, details).role("button").accessibility_label(title(a)).on_hover(hover(a))
      .on_click(open(a)).on_size_change((size) => { view.cardH = size.height / zoom; }))
      .when(on, (el) => el.bg(t.selected))
      .when(!on && !ghost && !dragging && !view.sweep?.moved, (el) => el.when(menu, (m) => m.bg(t.hover)).hover((s) => s.bg(t.hover)).active((s) => s.bg(t.selected)))
      .child(h_flex().h(20).gap(6).items_center().text_size(12).text_color(t.dim)
        .child(number(a, ghost))
        .child(avatar(a.space, a.space_name, 16))

        .when(pins.includes(a.address) && (!ghost || plan?.section === "pinned" || !plan), (el) => el.child(svg("mods/t3-inbox/icons/pin.svg").size(12).flex_none().text_color(t.dim)))
        .child(div().flex_1().min_w(0).truncate().child(a.space_name ?? ""))
        .child(corner))
      .child(h_flex().h(20).mt(4).gap(6).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(14).when(leads, (el) => el.font_medium())
          .text_color(leads || over || swept(a) ? t.foreground : t.muted).child(title(a)))

        .when(Boolean(marks) && !meta, (el) => el.child(marks)))
      .when(Boolean(meta), (el) => el.child(h_flex().h(16).mt(2).gap(6).items_center().text_size(12).text_color(t.dim)
        .child(div().flex_1().min_w(0).truncate().child(meta))
        .when(Boolean(marks), (m) => m.child(marks))))
      .when(!ghost, (el) => stop(view, t, `card-${a.address}`, el));
  };

  const slim = (a, ghost) => {
    const on = viewing(a), over = !dragging && !view.sweep?.moved && (view.hovered === a.address || within(view, [`slim-${a.address}`, `wake-${a.address}`, `unsettle-${a.address}`])), bright = on || over || ghost || swept(a);
    const napping = hidden(a), undoId = `${napping ? "wake" : "unsettle"}-${a.address}`, undoLabel = napping ? "Wake agent" : "Unsettle";

    const mark = avatar(a.space, a.space_name, 16);
    const undo = h_flex().id(undoId).h(24).px(6).flex_none().items_center().justify_center().rounded(6)
      .opacity(over ? 1 : 0).transition("opacity", MOTION)

      .when(over, (el) => el.on_hover(glow(view, undoId)).role("button").accessibility_label(undoLabel)
        .on_mouse_down("left", sweepFrom(napping ? "unsnooze" : "unsettle", a)).on_click((_e, cx) => {
        cx.stop_propagation();
        if (justDropped()) return;
        view.sweep = null;
        away(a, cx);
        if (napping) wake(a, cx); else unsettle(a, cx);
        cx.notify();
      }))
      .child(svg(`mods/t3-inbox/icons/${napping ? "alarm-clock-off" : "undo"}.svg`).size(napping ? 12 : 14).mb(1).flex_none().text_color(lit(undoId, t.muted)))
      .when(over, (el) => stop(view, t, undoId, el, 6));
    const time = napping
      ? h_flex().gap(4).items_center().text_color(t.accent).child(svg("mods/t3-inbox/icons/alarm-clock.svg").size(12).flex_none().text_color(t.accent)).child(left(napUntil(a), now))
      : !ghost && ago(settledAt(a)[0], now);
    const base = h_flex().id(`${ghost ? "ghost-" : ""}slim-${a.address}`).h(SLIM).px(10).gap(10).flex_none().items_center().rounded(6);
    return (ghost ? base : row(base, a, details).role("button").accessibility_label(title(a)).on_hover(hover(a)).on_click(open(a)))
      .when(on, (el) => el.bg(t.selected))
      .when(!on && !ghost && !dragging && !view.sweep?.moved, (el) => el.hover((s) => s.bg(t.hover)).active((s) => s.bg(t.selected)))
      .child(number(a, ghost))
      .child(h_flex().id(`slim-mark-${a.address}`).size(16).flex_none().items_center().justify_center().opacity(bright ? 1 : 0.4).transition("opacity", MOTION).child(ghost ? mark : tipMark(view, t, `slim-space-${a.address}`, a.space_name, mark, { delay })))
      .child(div().flex_1().min_w(0).truncate().when(on, (el) => el.font_medium()).text_color(bright ? t.foreground : t.muted).child(title(a)))
      .child(ghost ? (verb ? badge(verb) : div()) : swept(a) ? badge(view.sweep.action === "unsnooze" ? "wake" : "unsettle")

        : h_flex().id(`slim-corner-${a.address}`).relative().h(24).min_w(32).flex_none().items_center().justify_end()
          .child(div().flex_none().text_size(12).text_color(t.dim).opacity(over ? 0 : 1).transition("opacity", MOTION).child(time))
          .child(div().absolute().top(0).right(-4).child(tip(view, t, undoId, undoLabel, undo, { action: napping ? undefined : "t3-inbox.settle", delay }))))
      .when(!ghost, (el) => stop(view, t, `slim-${a.address}`, el));
  };

  return { card, slim };
}
