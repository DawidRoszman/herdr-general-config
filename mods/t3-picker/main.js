import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex, InputState, Input } from "gpui-base";
import { theme, spaces, panes, agents, terminals, focused, run, closeOverlay, props, window, shared, setShared } from "herdr";
import { modStatus, namer, programOf } from "./name.js";
import { focusPane } from "./zoom.js";
import { notNews, ownStatus, subAgents, treeStatus } from "./tree.js";
import { projectMark } from "./project.js";
import { step, scrollList } from "./list.js";

const ROW = 48;

const LIST_MAX = 420 - 2 - 48 - 8 - 8 - 41;

const icon = (t, p) => !p?.icon ? svg("mods/t3-picker/icons/terminal.svg").size(12).flex_none().text_color(t.muted)
  : p.tint ? svg(p.icon).size(12).flex_none().text_color(t.muted) : image(p.icon).size(12).flex_none();

const CHAT_MODS = ["t3-chat", "agent-chat"];

export default class Picker extends View {
  init() {
    this.at = null;
    this.filter = "";
    this.input = InputState.new({ placeholder: "Search terminals…" });
    this.input.on("change", (_e, cx) => { this.filter = this.input.value(); this.at = 0; cx.notify(); });
    this.input.on("submit", () => this.choose(this.items()[this.at ?? 0]));
    this.input.focus();
  }

  close() { setShared("t3-picker.closed", Date.now()); }

  items() {
    const q = this.filter.toLowerCase(), ps = panes(), all = terminals(), name = namer(), kids = subAgents(agents(), all);
    const mine = spaces().find((s) => s.active)?.machine ?? null;
    const rank = (s) => (s.active ? 0 : (s.machine ?? null) === mine ? 1 : 2);

    const offSpaces = new Set(shared("context")?.offSpaces ?? []);
    const offAgents = new Set(shared("context")?.offAgents ?? []);
    const byAddress = new Map(all.map((k) => [k.address, k]));

    const chats = new Map(ps.filter((p) => p.zoomed && CHAT_MODS.includes(p.mod)).map((p) => [p.tab, p]));
    const isBehindChat = (p) => chats.has(p.tab) && chats.get(p.tab).pane !== p.pane;
    const agentOf = (p) => (chats.get(p.tab)?.pane === p.pane ? ps.find((x) => x.tab === p.tab && x.terminal && isBehindChat(x)) : p.terminal ? p : null);
    const rows = spaces().filter((s) => !offSpaces.has(s.id)).sort((a, b) => rank(a) - rank(b) || (a.machine ?? "").localeCompare(b.machine ?? "")).flatMap((s) => s.tabs.flatMap((c) =>

      ps.filter((p) => p.tab === c.id && p.mod !== "t3-home" && !isBehindChat(p)).flatMap((p) => {
        const agent = agentOf(p);
        if (agent && offAgents.has(agent.terminal)) return [];
        const under = agent ? kids(agent.terminal) : [];
        return [{
          key: `pane:${p.pane}`, p, agent, term: agent ? byAddress.get(agent.terminal) : null, s, label: name(p), program: programOf(p) ?? agent?.program, team: under.length, under, here: s.active && c.active && p.focused,
          status: (p.mod && modStatus(p)) || (agent ? treeStatus(ownStatus(agent.status, agent.terminal, all), under) : null),

          words: [s.name, s.machine ?? "", c.named ? c.name : "", name(p), (programOf(p) ?? agent?.program)?.name ?? "", agent?.program?.key ?? "", (p.cwd ?? "").split(/[\\/]/).pop()],
        }];
      })));

    const back = !q && rows.find((r) => r.p.pane === shared("t3-picker.back") && r.p.pane !== focused()?.pane);
    const found = rows.filter((r) => !q || r.words.join(" ").toLowerCase().includes(q));
    return back ? [{ ...back, key: `back:${back.p.pane}`, back: true }, ...found] : found;
  }

  choose(item) {
    if (!item) return;
    closeOverlay(props().overlay);

    const from = focused()?.pane;
    if (from && item.p.pane !== from) setShared("t3-picker.back", from);
    focusPane(item.p.pane);
  }

  row(item, i, ps) {
    const t = theme(), on = this.at === i, s = item.s, st = item.status;

    const mark = st === "working" ? svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)
      : st === "blocked" ? div().size(14).flex_none().rounded(4).bg(t.blocked + "26").text_size(11).font_bold().text_color(t.blocked).flex().items_center().justify_center().child("!")
      : st === "done" && !notNews(item.term, item.agent?.status, item.under) ? div().size(6).flex_none().rounded_full().bg(t.done) : null;
    return h_flex().id(item.key).w_full().h(ROW).px(8).py(6).gap(8).rounded(4).items_center().flex_none()
      .role("button").accessibility_label(item.back ? `Back to ${item.label}` : item.label)
      .when(on, (el) => el.bg(t.selected))
      .on_hover((over, cx) => { if (over && this.at !== i) { this.at = i; cx.notify(); } })
      .on_click(() => this.choose(item))

      .child(h_flex().w(16).h(20).pt(2).self_start().flex_none().items_center().justify_center().child(projectMark(s, 16, t, ps, true)))
      .child(v_flex().flex_1().min_w(0)
        .child(div().truncate().text_color(t.foreground).when(Boolean(item.here), (d) => d.font_medium()).child(item.label))
        .child(h_flex().min_w(0).gap(4).items_center().text_size(12).line_height("16px").text_color(t.dim)
          .child(icon(t, item.program))
          .child(div().flex_none().text_color(t.muted).child(item.program?.name ?? "Terminal"))
          .child(div().flex_none().child("·"))

          .when(Boolean(s.machine), (el) => el
            .child(svg("mods/t3-picker/icons/server.svg").size(12).flex_none().text_color(t.muted))
            .child(div().flex_none().text_color(t.muted).child(`${s.machine} ·`)))
          .child(div().min_w(0).truncate().child(s.name + (item.team ? ` · +${item.team}` : "")))))
      .when(Boolean(mark), (el) => el.child(mark))
      .when(Boolean(item.back), (el) => el.child(div().flex_none().text_size(12).font_medium().text_color(t.muted).child("↩ Back")));
  }

  render() {
    const t = theme(), ps = panes(), items = this.items();

    if (this.at === null) this.at = Math.max(0, items.findIndex((r) =>  (r).back || r.here));
    this.at = Math.min(this.at, Math.max(0, items.length - 1));
    const key = (label) => div().flex().flex_none().min_w(20).h(20).px(4).items_center().justify_center().rounded(4).bg(t.foreground + "14").text_size(12).text_color(t.foreground).child(label);
    const hint = (label, what) => h_flex().gap(4).items_center().children(label.split(" ").map(key)).child(what);
    return v_flex().id("picker").size_full().min_h(0).rounded(16).border(1).border_color(t.border).bg(t.popover).shadow_2xl().text_size(14).line_height("20px")
      .on_key_down((e, cx) => {
        if (e.key === "escape") { cx.stop_propagation(); return closeOverlay(props().overlay); }
        const to = step(e, this.at, items.length);
        if (to >= 0) this.at = to;
        else if (e.key === "d" && e.modifiers.control && items[this.at]) {
          closeOverlay(props().overlay);

          return run(`t3-tabs.close-pane:${items[this.at].p.pane}`);
        } else return;
        cx.stop_propagation();
        cx.notify();
      })
      .child(h_flex().h(36).my(6).flex_none().pl(18).pr(20).gap(7).items_center()
        .child(svg("mods/t3-picker/icons/search.svg").size(16).flex_none().text_color(t.dim))
        .child(Input.new(this.input).flex_1().h_full().text_size(14).text_color(t.foreground)))

      .child(div().flex_none().mt(8).mb(8).px(8)
        .when(items.length > 0, (el) => el.child(scrollList(this, "picker-rows", { count: items.length, row: ROW, at: this.at, height: Math.min(items.length * ROW, LIST_MAX),
          draw: (i) => this.row(items[i], i, ps), wheeled: (keep) => { this.at = keep; } })))
        .when(items.length === 0, (el) => el.child(div().py(40).text_center().text_color(t.dim).child("No matching terminals."))))
      .child(h_flex().flex_none().px(16).py(10).gap(8).items_center().justify_between().rounded_b(15).border_t(1).border_color(t.foreground + "12").bg(t.foreground + "06").font_medium().text_color(t.muted)
        .child(h_flex().gap(12).items_center()
          .child(hint("↑ ↓", "Navigate"))
          .child(hint("Enter", "Go"))
          .child(hint(window()?.platform === "macos" ? "⌃D" : "Ctrl+D", "Close pane"))
          .child(hint("Esc", "Close")))

        .child(h_flex().id("picker-new").gap(4).px(8).rounded(8).items_center().flex_none().text_size(12).line_height("16px")
          .role("button").accessibility_label("New tab").hover((s) => s.text_color(t.foreground))
          .on_click(() => { closeOverlay(props().overlay); run("mod.open", { name: "t3-new-menu" }); })
          .child(svg("mods/t3-picker/icons/square-pen.svg").size(14).text_color(t.muted))
          .child("New tab")));
  }
}
