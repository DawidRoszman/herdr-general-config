import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, terminals, panes, spaces, focused, theme, layout, shared, setShared, setAgentOrder, settings, openOverlay, closeOverlay, props, nextCommand } from "herdr";
import { notNews, ownStatus, subAgents, treeStatus } from "./tree.js";
import { glow, tip } from "./tip.js";
import { stopsInit, stopsEnd, stop, focusRoot, enter } from "./focus.js";
import { menuJump } from "./list.js";
import { MOTION, planMotion, flying, leavingRows } from "./motion.js";
import { agentEntries, agentStatus, STACK, RANK, SECTION } from "./rows.js";
const SORTS = [
  { id: "priority", label: "Priority", icon: "clock" },
  { id: "grouped", label: "Grouped by space", icon: "layers" },
];
const sortOf = () => SORTS.find((s) => s.id === shared("agents.sort")) ?? SORTS[0];

const SORT_WIDTH = 200;

export default class Agents extends View {
  async close() { stopsEnd(this); }

  init(_props, cx) {
    if (props()?.sortMenu) {

      this.at = -1;
      this.keys = cx.focus_handle();
      this.keys.focus();
      cx.timer.after(16, (cx) => { this.shown = true; cx.notify(); });
      return;
    }
    stopsInit(this, cx);

    cx.spawn(async (cx) => {
      for (;;) if (await nextCommand() === "focus") enter(this, cx, "ag-sort");
    });
    this.folded = JSON.parse(localStorage.getItem("folded") ?? "{}");

    this.changed = JSON.parse(localStorage.getItem("changed") ?? "{}");
    cx.timer.every(1000, () => {
      const findLists = (n) => (n?.id === "sidebar-lists" ? n : (n?.children ?? []).map(findLists).find(Boolean));
      const mode = findLists(layout());
      if (!mode || mode.active !== "inbox") this.compute();
    });
    cx.timer.every(30000, (cx) => cx.notify());

    if (shared("agents.pins") == null && localStorage.getItem("pins")) setShared("agents.pins", JSON.parse(localStorage.getItem("pins")));
  }

  get pins() {
    return shared("agents.pins") ?? [];
  }

  isFolded(id, initial = true) {
    return this.folded[id] ?? initial;
  }

  toggleFold(id, cx, initial = true) {
    this.folded[id] = !this.isFolded(id, initial);
    localStorage.setItem("folded", JSON.stringify(this.folded));
    cx.notify();
  }

  track(list, now) {
    let dirty = false;

    const changedAt = new Map(spaces().flatMap((s) => s.tabs ?? []).map((c) => [c.id, c.changed_at]));
    for (const a of list) {
      const s = a.status === "done" ? "idle" : a.status;
      if (this.changed[a.address]?.s === s) continue;
      this.changed[a.address] = { s, at: changedAt.get(a.tab) ?? now };
      dirty = true;
    }
    if (!dirty) return;

    const listed = new Set(list.map((a) => a.address));
    for (const [k, c] of Object.entries(this.changed)) if (!listed.has(k) && now - c.at > 30 * 86400000) delete this.changed[k];
    localStorage.setItem("changed", JSON.stringify(this.changed));
  }

  prune(all) {
    const machine = (addr) => (addr.includes("/") ? addr.split("/")[0] : "");
    const heard = new Set(all.map((k) => machine(k.address)));
    const live = new Set(all.filter((k) => k.state === "live").map((k) => k.address));
    const kept = this.pins.filter((p) => !heard.has(machine(p)) || live.has(p));
    if (kept.length !== this.pins.length) setShared("agents.pins", kept);

    const ended = Object.keys(this.folded).filter((k) => !/^(sp-|sec-|pinned$)/.test(k) && heard.has(machine(k)) && !live.has(k));
    for (const k of ended) delete this.folded[k];
    if (ended.length) localStorage.setItem("folded", JSON.stringify(this.folded));
  }

  since(a) {
    return this.changed[a.address]?.at ?? 0;
  }

  hold(list) {
    const cur = list.find((a) => a.focused);
    const same = cur && cur.address === this.held?.address;

    if (!same || cur.status !== "idle") this.held = cur ? { address: cur.address, rank: RANK[cur.status] ?? 0 } : null;
  }

  word(a) {
    const sawDone = a.address === this.held?.address && this.held.rank === RANK.done && a.status === "idle";
    return sawDone ? "done" : a.status;
  }

  sortMenu(t) {
    const on = sortOf().id;
    const choose = (s) => {
      setShared("agents.sort", s.id);
      closeOverlay(props().overlay);
    };
    return v_flex()
      .id("sort-menu")
      .w_full()
      .p(4)
      .bg(t.popover)
      .text_size(14)
      .opacity(this.shown ? 1 : 0).transition("opacity", MOTION)
      .track_focus(this.keys).on_key_down((e, cx) => {
        if (e.key === "enter") { if (this.at >= 0) choose(SORTS[this.at]); }
        else if (e.key === "escape") closeOverlay(props().overlay);
        else {
          const to = menuJump(this, e, SORTS.map((s) => s.label), this.at);
          if (to < 0) return;
          this.at = to;
        }
        cx.stop_propagation();
        cx.notify();
      })
      .child(div().px(8).py(6).text_size(12).line_height("16px").font_medium().text_color(t.muted).child("Sort agents"))
      .children(SORTS.map((s, i) => h_flex()
        .id(`sort-${s.id}`)
        .h(28)
        .px(8)
        .gap(8)
        .rounded(4)
        .items_center()
        .text_color(t.foreground)
        .role("button").accessibility_label(s.label)
        .when(i === this.at, el => el.bg(t.selected))
        .on_hover((over, cx) => { if (over && this.at !== i) { this.at = i; cx.notify(); } })
        .on_click(() => choose(s))
        .child(svg(`mods/t3-agents/icons/${s.icon}.svg`).size(16).mx(-2).flex_none().text_color(t.muted))
        .child(div().flex_1().child(s.label))
        .when(s.id === on, (el) => el.child(svg("mods/t3-agents/icons/check.svg").size(14).flex_none().text_color(t.foreground)))));
  }

  status(t, a, note = "", id) {
    return agentStatus(this, t, a, note, id);
  }

  compute() {
    const sort = sortOf();

    const offAgents = new Set(shared("context")?.offAgents ?? []);
    let list = agents().filter((a) => !offAgents.has(a.address));
    this.listed = new Map(list.map((a) => [a.address, a.status]));
    const all = terminals();

    const f = focused();
    const shown = f?.pane && !f.terminal && !list.some((a) => a.tab === f.tab && a.address === f.agent) ? null : f?.agent;
    const ps = panes();
    const now = Date.now();

    const ancestor = (() => {
      const byAddress = new Map(all.map((k) => [k.address, k])), seen = new Set();
      let k = byAddress.get(shown);
      while (k && !this.listed.has(k.address) && !seen.has(k.address)) { seen.add(k.address); k = byAddress.get(k.parent); }
      return k && this.listed.has(k.address) ? k.address : null;
    })();
    const viewing = (a) => a.focused || (a.address === ancestor && this.isFolded(a.address));
    this.track(list, now);
    this.hold(list);
    const byPriority = sort.id === "priority";
    const under = subAgents(list, all);
    const kidsOf = new Map(list.map((a) => [a.address, under(a.address)]));

    const own = (a) => ownStatus(a.status, a.address, all);
    const shownStatus = (a) => notNews(all.find(k => k.address === a.address), own(a), kidsOf.get(a.address))
      && treeStatus(own(a), kidsOf.get(a.address)) !== "blocked" ? "idle" : treeStatus(own(a), kidsOf.get(a.address));
    const urgency = new Map(list.map((a) => [a.address, RANK[treeStatus(ownStatus(this.word(a), a.address, all), kidsOf.get(a.address))] ?? 0]));
    const rankOf = (a) => urgency.get(a.address);
    if (byPriority) list = [...list].sort((x, y) => rankOf(y) - rankOf(x) || this.since(y) - this.since(x) || y.seq - x.seq);
    this.prune(all);
    const pinned = this.pins.map((p) => list.find((a) => a.address === p)).filter(Boolean);
    const rest = list.filter((a) => !this.pins.includes(a.address));
    list = [...pinned, ...rest];
    const groups =  (pinned.length ? [{ id: "pinned", label: "Pinned", status: null, members: pinned }] : []);
    for (const a of rest) {
      const r = rankOf(a) || RANK.idle;
      const id = byPriority ? `sec-${r}` : `sp-${a.space}`;
      if (groups.at(-1)?.id === id) groups.at(-1).members.push(a);
      else groups.push({ id, label: byPriority ? SECTION[r] : a.space_name || "", space: byPriority ? null : a.space, members: [a] });
    }

    const order = [...new Set(groups.flatMap(g => g.members.map(a => a.address)))];
    const view = order.includes(ancestor) ? ancestor : null;
    const find = (n) => n?.id === "sidebar-lists" ? n : (n?.children ?? []).map(find).find(Boolean);
    if (find(layout())?.active !== "inbox") {
      const drawn = { order, view };
      if (JSON.stringify(drawn) !== JSON.stringify(shared("t3-agents.rows") ?? null)) setShared("t3-agents.rows", drawn);
      const addresses = list.map(a => a.address), key = JSON.stringify(addresses);
      if (key !== this.agentOrder || shared("t3-agent-order") !== "lists") {
        this.agentOrder = key;
        setAgentOrder(addresses);
        if (shared("t3-agent-order") !== "lists") setShared("t3-agent-order", "lists");
      }
    } else this.agentOrder = null;
    return { sort, list, all, shown, ps, now, viewing, byPriority, own, shownStatus, pinned, groups };
  }

  render(cx) {
    const t = theme();
    if (props()?.sortMenu) return this.sortMenu(t);
    const data = this.compute();
    const { sort, list } = data;
    const entries = agentEntries(this, t, data);

    planMotion(this, entries, cx);

    const gone = this.hovered;
    if (gone && !entries.some((e) => e.key === gone)) {
      this.hovered = this.hot = null;
       (this).detailsWait?.cancel();
      if (this.details === gone) this.details = null;
      if (this.detailsOut === gone) this.detailsOut = null;
    }
    const rows = entries.map((e) => flying(this, e.key, e.el));

    return focusRoot(this, v_flex()
      .id("t3-agents-root")
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .text_size(14)
      .child(
          h_flex()
            .id("agents-heading")
            .pl(18).pr(8)
            .h(31)
            .flex_none()
            .items_center()
            .justify_between()
            .child(div().text_size(12).font_medium().text_color(t.muted).child("Agents"))
            .child(
              tip(this, t, "ag-sort", `Sort agents: ${sort.label}`, stop(this, t, "ag-sort", div()
                .id("ag-sort")
                .size(28).flex_none().flex().items_center().justify_center().rounded(8)
                .role("button").accessibility_label("Sort agents")
                .text_color(this.hot === "ag-sort" ? t.foreground : t.dim)
                .hover((s) => s.bg(t.hover))
                .on_hover(glow(this, "ag-sort"))
                .on_mouse_down("left", (e) => { this.sortFrom = e.bounds; })
                .on_click((_e, cx) => {
                  this.hot = null;

                  const b = this.sortFrom, z = Number(settings()?.zoom) || 1;
                  this.sortFrom = null;
                  openOverlay({ mod: "t3-agents", kind: "popup", width: SORT_WIDTH, height: 140, ...(b ? { at: { x: b.x + b.width - SORT_WIDTH * z, y: b.y + b.height + 4 * z } } : {}), props: { sortMenu: true } });
                  cx.notify();
                })
                .child(svg(`mods/t3-agents/icons/${sort.icon}.svg`).size(16)), 8)),
            ),
      )
      .when(list.length === 0, (el) =>
        el.child(div().px(16).py(24).text_center().text_size(12).line_height("16px").text_color(t.dim).child("No agent status yet. Agents show up here when they report their status. Older versions and agents inside tmux may not.")),
      )
      .child(v_flex().id("ag-list").flex_1().min_h(0).px(8).pb(8).overflow_y_scroll()

        .child(v_flex().id("ag-content").relative().w_full().flex_none().gap(STACK).children(leavingRows(this)).children(rows))));
  }
}
