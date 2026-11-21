import { View, div, svg, image } from "gpui-kit";
import { h_flex, Popup } from "gpui-base";
import { spaces, panes, agents, terminals, machines, run, openOverlay, closeOverlay, focused, hc, notify, theme, window, layout, settings, props, shared, setShared, nextCommand, home } from "herdr";
import { modStatus, namer, programOf } from "./name.js";
import { descendants, notNews, ownStatus, stillSettled, subAgents, treeStatus } from "./tree.js";
import { tip, glow } from "./tip.js";
import { detailsFor, detailsAt, detailsWatch } from "./details.js";
import { focusAgent, focusPane } from "./zoom.js";
import { stopsInit, stopsEnd, stop, focusRoot, within } from "./focus.js";
import { resolveSpaceTargets, pickSpaceTarget, pickAdjacentSpace } from "./spaces-nav.js";

const homeId = () => shared("t3-home.space");

const HOME_NAME = "Home\u200b";
let renaming = false;

function knowHome() {
  const all = spaces(), known = all.find(s => s.id === homeId());

  if (known?.name === "Home" && !renaming) { renaming = true; run("space.rename", { id: known.id, name: HOME_NAME }); }
  if (known) return;
  const found = all.find(s => s.machine === null && s.named && s.name === HOME_NAME);
  if (found) setShared("t3-home.space", found.id);
}
const atHome = () => Boolean(homeId()) && spaces().some(s => s.active && s.id === homeId());

async function seen(cx, look) {

  for (let i = 0; i < 400; i++) {
    const found = look();
    if (found) return found;
    await new Promise(resolve => cx.timer.after(25, () => resolve()));
  }
  return null;
}
async function goHome(cx) {

  const here = machines().find(m => m.name === null);
  if (here && here.layout !== "ready") return;
  knowHome();
  if (spaces().some(s => s.id === homeId())) return run("space.select", { id: homeId() });
  const before = new Set(spaces().map(s => s.id));
  run("space.new", { name: HOME_NAME, machine: "", folder: home() });
  const made = await seen(cx, () => spaces().find(s => !before.has(s.id) && s.name === HOME_NAME));
  if (!made) return;
  setShared("t3-home.space", made.id);

  const shell = made.tabs[0]?.id;
  run("tab.new", { space: made.id, name: "Home", mod: "t3-home" });
  const page = await seen(cx, () => spaces().find(s => s.id === made.id)?.tabs.find(c => c.id !== shell)?.id);
  if (page && shell) run("tab.close", { id: shell, confirmed: true });
}

function step(command) {
  const { order = [], view = null } = shared(inboxShown() ? "t3-inbox.rows" : "t3-agents.rows") ?? {};
  const i = view === null ? -1 : order.indexOf(view);
  const to = view === null ? (command === "next" ? order[0] : order.at(-1)) : i < 0 ? null : order[command === "next" ? i + 1 : i - 1];
  showRow(to);
}
function showRow(to) {
  if (to?.startsWith("pane:")) focusPane(to.slice(5));
  else if (to) focusAgent(to);
}

function selectInboxRow(index) {
  showRow((shared("t3-inbox.rows")?.order ?? [])[index - 1]);
}

function showSpace(s, trail) {
  const back = trail[s.id]?.find(id => s.tabs.some(c => c.id === id));
  run(back ? "tab.select" : "space.select", { id: back ?? s.id });
}

function selectSpace(index, trail) {
  const all = spaces(), context = shared("context");
  const targets = resolveSpaceTargets({ spaces: all, homeId: homeId(), context, publishedRows: shared("t3-spaces.rows") });
  const target = pickSpaceTarget(targets, index);
  if (!target) return;
  if (target.kind === "coordinator") {
    const id = context?.coordinators?.[target.key];
    const s = id ? all.find((x) => x.id === id) : null;
    if (s) showSpace(s, trail);
    else run(`t3-context.coordinator:${target.key}`);
    return;
  }
  const s = all.find((x) => x.id === target.id);
  if (s) showSpace(s, trail);
}
function walkSpaces(by, trail) {
  const all = spaces(), context = shared("context");
  const targets = resolveSpaceTargets({ spaces: all, homeId: homeId(), context, publishedRows: shared("t3-spaces.rows") });
  const next = pickAdjacentSpace({ targets, spaces: all, coordinators: context?.coordinators, by });
  if (next) showSpace(next, trail);
}

const inboxShown = () => find(layout(), "sidebar-lists")?.active === "inbox";

function awake(st, under) {
  const now = Date.now(), byAddress = new Map(terminals().map((k) => [k.address, k]));
  const offAgents = new Set(shared("context")?.offAgents ?? []);
  return agents().filter((a) => {
    if (offAgents.has(a.address)) return false;
    const k = byAddress.get(a.address);
    return st(a) === "blocked" || (!stillSettled(k, a.status, under(a.address)) && !(Number(k?.labels?.snoozed) > now));
  });
}

const blockedMark = (t) => div().size(14).flex_none().rounded(4).bg(t.blocked + "26").text_size(11).font_bold().text_color(t.blocked).flex().items_center().justify_center().child("!");
const mark = (t, s) => s === "working" ? svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)
  : s === "blocked" ? blockedMark(t)
  : div().size(6).flex_none().rounded_full().bg(t.done);

const WORDS = { working: "Working", blocked: "Needs you", done: "Done" };
const TAB_GAP = 4;

const TAB_FLOOR = 144, TAB_ACTIVE = 240, TAB_MIN = 96;

const TAB_CHROME = 51;

function fairCap(wants, room) {
  const sorted = [...wants].sort((a, b) => a - b);
  for (let i = 0; i < sorted.length; i++) {
    const share = room / (sorted.length - i);
    if (sorted[i] > share) return share;
    room -= sorted[i];
  }
  return Infinity;
}

const lit = (view, id, color = theme().dim) => (view.hot === id ? theme().foreground : color);

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

const leadOf = (mine) => mine.find(p => p.status != null) ?? mine.find(p => p.focused) ?? mine[0];
const nameOf = (c, lead) => c.named ? c.name : lead ? namer()(lead) : "Terminal";

const SHELL = /^-?(zsh|bash|fish|sh|dash|ksh|tcsh|nu)$/;
async function atPrompt(terminal) {
  try {
    const k = JSON.parse((await hc(["get", terminal, "--json"])).stdout);
    return k.foreground?.pid === k.pid && SHELL.test(k.foreground.name);
  } catch { return false; }
}

export default class Tabs extends View {
  init(_props, cx) {
    this.pressed = null;
    this.over = null;
    this.strip = 0;
    this.nameW = {};
    this.trail = {};
    this.owed = new Map();
    if (props()?.part !== "measure") stopsInit(this, cx);

    if (!props()?.part) cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();

        if (command === "close-tab") await this.closeTab(focused()?.tab, cx);
        else if (command === "close-pane") await this.closePane(focused()?.pane, cx);
        else if (command.startsWith("close-tab:")) await this.closeTab(command.slice("close-tab:".length), cx);
        else if (command.startsWith("close-pane:")) await this.closePane(command.slice("close-pane:".length), cx);

        else if (command.startsWith("close-tab-now:")) await this.closeTabNow(command.slice("close-tab-now:".length), { confirmed: true }, cx);
        else if (command.startsWith("close-pane-now:")) await this.closePaneNow(command.slice("close-pane-now:".length), cx);
        else if (command === "home") await goHome(cx);
        else if (command === "next" || command === "prev") step(command);

        else if (command === "sidebar") run("layout.select", { stack: "sidebar-lists", child: inboxShown() ? "lists" : "inbox" });
        else if (command === "settle") await this.settle(cx);
        else if (command === "undo") await this.undo();

        else if (command === "new") run(... (atHome() ? ["mod.open", { name: "t3-new-menu" }] : ["tab.new"]));
        else if (command.startsWith("space:")) {
          const index = Number(command.slice("space:".length));
          if (inboxShown()) selectInboxRow(index);
          else selectSpace(index, this.trail);
        }
        else if (command === "space-next") walkSpaces(1, this.trail);
        else if (command === "space-prev") walkSpaces(-1, this.trail);
        else if (command.startsWith("tab:")) {
          const c = this.visibleTabs()[Number(command.slice("tab:".length)) - 1];
          if (c) run("tab.select", { id: c.id });
        }
        else if (command === "tab-next") this.walkTabs(1);
        else if (command === "tab-prev") this.walkTabs(-1);
      }
    });
  }

  ask(names, more, command, cx) {

    this.overTab = this.hot = null;
    detailsFor(this, null, cx);
    cx.notify();
    if (this.asking) closeOverlay(this.asking);
    const [title, detail] = names.length === 1
      ? [`Close terminal "${names[0]}"?`, "This stops the running process and clears its history."]
      : [`Close ${names.length} terminals?`, `This stops their running processes and clears their histories: ${names.map(n => `"${n}"`).join(", ")}.`];

    this.asking = openOverlay({ mod: "t3-actions", kind: "dialog", frame: "none", width: 512, props: { actions: "confirm", title, detail: detail + more, command: { name: command } } });
  }

  async closeTab(id, cx) {
    const space = spaces().find(s => s.tabs.some(c => c.id === id));

    if (!space || space.id === homeId()) return;
    const c = space.tabs.find(c => c.id === id), mine = panes().filter(p => p.tab === id);
    const live = mine.filter(p => p.terminal), empty = await Promise.all(live.map(p => atPrompt(p.terminal)));

    const names = live.filter((_, k) => !empty[k]).map(p => mine.length === 1 ? nameOf(c, p) : namer()(p));
    if (names.length === 0) return this.closeTabNow(id, {}, cx);
    this.ask(names, space.tabs.length === 1 ? " It's the space's last tab, so the space closes too." : "", `t3-tabs.close-tab-now:${id}`, cx);
  }

  async closeTabNow(id, args, cx) {
    await this.leave(id, cx);
    run("tab.close", { id, ...args });
  }

  async closePaneNow(pane, cx) {
    const ps = panes(), p = ps.find(p => p.pane === pane), tab = p?.tab;
    const homeTabs = spaces().find(s => s.id === homeId())?.tabs.map(c => c.id) ?? [];

    if (homeTabs.includes(tab) && ps.filter(p => homeTabs.includes(p.tab)).length === 1) run("pane.split", { direction: "right", pane, mod: "t3-home" });
    if (ps.filter(p => p.tab === tab).length === 1) await this.leave(tab, cx);
    else if (!atHome() && focused()?.pane === pane && agents().some(a => a.address === p?.terminal)) await goHome(cx);
    else if (focused()?.pane === pane && p?.mod && programOf(p)?.inbox) {
      const mine = agents().filter(a => a.tab === tab), back = mine.find(a => a.address === focused()?.agent) ?? mine[0];
      if (back) focusAgent(back.address);
    }
    run("pane.close", { pane });
  }

  async writeLabel(address, key, value) {
    const r = await hc(["label", address, `${key}=${value}`]).catch(e => ({ code: 1, stderr: String(e) }));
    if (r.code === 0) return true;
    notify({ title: "Couldn't update the agent", body: r.stderr.trim(), level: "error" });
    return false;
  }

  async settle(cx) {
    if (atHome()) return;
    const f = { ...focused() }, ps = panes(), p = ps.find(p => p.pane === f.pane), every = agents(), all = terminals();
    if (p?.mod && programOf(p)?.inbox) {
      if (!["working", "blocked"].includes(modStatus(p))) await this.closePaneNow(p.pane, cx);
      return;
    }
    const byAddress = new Map(all.map(k => [k.address, k]));
    let address = f?.pane && !f.terminal ? (every.find(a => a.tab === f.tab && a.address === f.agent) ?? every.find(a => a.tab === f.tab))?.address
      : f?.terminal ?? f?.agent ?? every.find(a => a.focused)?.address;
    const seen = new Set();
    while (address && !every.some(a => a.address === address) && !seen.has(address)) { seen.add(address); address = byAddress.get(address)?.parent; }
    const a = every.find(a => a.address === address), k = byAddress.get(address);
    if (!a) return;
    const kids = subAgents(every, all)(address), own = ownStatus(a.status, address, all);
    if ([own, ...kids].some(s => s === "working" || s === "blocked")) return;
    if (stillSettled(k, own, kids)) { await this.writeLabel(address, "settled", ""); return; }
    const snoozed = k?.labels?.snoozed ?? "";
    if (!await this.writeLabel(address, "settled", `${Date.now()}:${k?.turn ?? 0}`)) return;
    if (snoozed) await this.writeLabel(address, "snoozed", "");
    const pins = shared("agents.pins") ?? [];
    if (pins.includes(address)) setShared("agents.pins", pins.filter(p => p !== address));
    const old = shared("t3-inbox.notice"), now = Date.now();
    const joined = old?.owner === "tabs" && old.live && now - old.at < 5000;
    const n = { owner: "tabs", action: "Settled", count: (joined ? old.count : 0) + 1, gen: (old?.gen ?? 0) + 1,
      live: true, shown: joined, at: now, undos: [...(joined ? old.undos : []), { address, snoozed, pins }] };
    setShared("t3-inbox.notice", n);
    const update = (change) => {
      const current = shared("t3-inbox.notice");
      if (current?.owner === "tabs" && current.gen === n.gen && current.at === n.at) setShared("t3-inbox.notice", change && { ...current, ...change });
    };
    if (!joined) cx.timer.after(16, () => update({ shown: true }));
    cx.timer.after(5000, () => update({ live: false, shown: false }));
    cx.timer.after(5250, () => update(null));
    const current = focused();
    if (["space", "tab", "pane", "terminal", "agent"].every(key => current?.[key] === f[key])) run("t3-tabs.home");
  }

  async undo() {
    const n = shared("t3-inbox.notice");
    if (!n?.live || Date.now() - n.at >= 5000) return;
    if (n.owner !== "tabs") {
      setShared("t3-inbox.undo", { gen: n.gen, at: n.at, requestedAt: Date.now(), request: (shared("t3-inbox.undo")?.request ?? 0) + 1 });
      return;
    }

    setShared("t3-inbox.notice", null);
    let back;
    const failed = [];
    for (const u of [...n.undos].reverse()) {
      if (!await this.writeLabel(u.address, "settled", "")) { failed.unshift(u); continue; }
      back = u.address;
      if (Number(u.snoozed) > Date.now()) await this.writeLabel(u.address, "snoozed", u.snoozed);
      const pins = [...(shared("agents.pins") ?? [])];
      if (u.pins.includes(u.address) && !pins.includes(u.address)) {
        const next = u.pins.slice(u.pins.indexOf(u.address) + 1).find(p => pins.includes(p));
        pins.splice(next ? pins.indexOf(next) : pins.length, 0, u.address);
        setShared("agents.pins", pins);
      }
    }
    if (failed.length) setShared("t3-inbox.notice", { ...n, count: failed.length, undos: failed });
    if (back && atHome()) focusAgent(back);
  }

  async leave(id, cx) {
    const space = spaces().find(s => s.active);

    if (atHome() || !space?.tabs.find(c => c.id === id)?.active) return;

    if (space.tabs.length === 1) return agents().some(a => a.tab === id) ? goHome(cx) : undefined;
    this.goBack(space.id, id);
  }

  goBack(space, from) {
    const back = this.trail[space]?.find(id => id !== from && spaces().some(s => s.tabs.some(c => c.id === id)));
    if (!back) return;
    this.going = { tab: back, until: Date.now() + 500 };
    run("tab.select", { id: back });
  }

  async closePane(pane, cx) {
    const ps = panes(), p = ps.find(p => p.pane === pane);
    if (!p) return;
    const space = spaces().find(s => s.tabs.some(c => c.id === p.tab)), tabs = space?.tabs.map(c => c.id) ?? [];
    const last = ps.filter(q => tabs.includes(q.tab)).length === 1, inHome = space?.id === homeId();

    if (inHome && last && p.mod === "t3-home") return;

    if (!p.terminal || (last && !inHome) || await atPrompt(p.terminal)) return this.closePaneNow(pane, cx);
    this.ask([namer()(p)], "", `t3-tabs.close-pane-now:${pane}`, cx);
  }

  track() {
    knowHome();
    const all = spaces(), space = all.find(s => s.active), tab = space?.tabs.find(c => c.active), home = atHome();
    const alive = (id) => all.some(s => s.tabs.some(c => c.id === id));
    const was = this.inView;

    const toHome = () => { this.going = { until: Date.now() + 500 }; run("t3-tabs.home"); };

    if (this.wasHome && all.length && !all.some(s => s.id === homeId())) toHome();
    this.wasHome = home;

    const terms = terminals(), every = agents(), ps = panes();
    if (was && (!alive(was.tab) || (was.pane && !ps.some(p => p.pane === was.pane))) && !home) {

      if (space?.id === was.space && !alive(was.tab)) this.goBack(was.space, was.tab);
      else if (was.agent) toHome();

      for (const a of every.filter(a => a.tab === tab?.id)) {
        const before = this.unread?.get(a.address);
        if (before) this.owed.set(a.address, { ...before, until: Date.now() + 3000 });
      }
    }
    this.zoomFollows(every);
    this.payBack(tab, home, terms, every);

    this.unread = new Map(every.filter(a => a.status === "done").map(a => {
      const k = terms.find(k => k.address === a.address);
      return [a.address, { turn: k?.turn ?? 0, snoozed: k?.labels?.snoozed }];
    }));
    if (this.going && (tab?.id === this.going.tab || Date.now() > this.going.until)) this.going = null;

    if (space && tab && !home && !this.going) this.trail[space.id] = [tab.id, ...(this.trail[space.id] ?? []).filter(id => id !== tab.id && alive(id))];
    const pane = focused()?.pane;
    this.inView = tab && !home ? { tab: tab.id, space: space.id, agent: every.some(a => a.tab === tab.id),
      pane: every.some(a => a.pane === pane) ? pane : null } : null;
  }

  zoomFollows(every) {
    const ps = panes(), f = ps.find(p => p.focused), z = f && ps.find(p => p.tab === f.tab && p.zoomed), was = this.focusWas;
    const off = z && z.pane !== f.pane ? `${f.pane}:${z.pane}` : null, told = this.zoomOff;
    this.focusWas = f?.pane; this.zoomOff = off;
    if (!off || off === told) return;
    if (was === f.pane) return run("pane.focus", { pane: z.pane });
    run("pane.zoom", { pane: f.pane });
    const before = this.unread?.get(z.terminal);
    if (before && every.some(a => a.address === z.terminal)) this.owed.set(z.terminal, { ...before, until: Date.now() + 3000 });
  }

  payBack(tab, home, terms, every) {
    for (const [addr, o] of this.owed) {
      const k = terms.find(k => k.address === addr), a = every.find(a => a.address === addr);
      if (!k || (k.turn ?? 0) !== o.turn || o.turn < 1) { this.owed.delete(addr); continue; }

      if (a?.status === "done") o.seen = true;

      const covered = panes().some(p => p.tab === a?.tab && p.zoomed && p.terminal !== addr);
      if (a?.tab === tab?.id && !home && !covered) { if (Date.now() > o.until) this.owed.delete(addr); continue; }
      if (!o.seen && Number(k.labels?.["herdr.seen"]) >= o.turn) { o.seen = true; hc(["label", addr, `herdr.seen=${o.turn - 1}`]); }

      if (o.snoozed && !k.labels?.snoozed) { hc(["label", addr, `snoozed=${o.snoozed}`]); o.snoozed = null; }
      if ((o.seen && !o.snoozed) || Date.now() > o.until) this.owed.delete(addr);
    }
  }

  visibleTabs() {
    const space = spaces().find(s => s.active);
    if (!space || atHome()) return [];
    if (!inboxShown()) return space.tabs;
    const every = agents(), all = terminals(), f = focused();
    const shownTab = this.going?.tab ?? space.tabs.find(c => c.active)?.id;
    const inTab = [shownTab, ...(this.trail[space.id] ?? [])].find(id => every.some(a => a.tab === id));
    const here = every.filter(a => a.tab === inTab);
    const viewed = here.find(a => a.focused) ?? here.find(a => a.address === f?.agent) ?? here[0];

    const byAddress = new Map(all.map(k => [k.address, k])), seen = new Set();
    let top = viewed?.address;
    while (!seen.has(top) && byAddress.get(byAddress.get(top)?.parent)?.state === "live") { seen.add(top); top = byAddress.get(top).parent; }
    const family = new Set([top, ...descendants(all, top).map(k => k.address)]);
    const lead = space.tabs.find(c => c.id === every.find(a => a.address === top)?.tab);
    const kin = space.tabs.filter(c => c !== lead && every.some(a => a.tab === c.id && family.has(a.address)));
    return [...(lead ? [lead] : []), ...kin, ...space.tabs.filter(c => !every.some(a => a.tab === c.id))];
  }

  walkTabs(by) {
    const list = this.visibleTabs();
    if (!list.length) return;
    run("tab.select", { id: list[(list.findIndex(c => c.active) + by + list.length) % list.length].id });
  }

  tabWidths(shown, want) {
    const room = (this.room ?? 0) - TAB_GAP * (shown.length - 1), active = shown.find(c => c.active);
    let cap = fairCap(shown.map(want), room), held = active && want(active);
    if (active && held > cap) {
      held = Math.min(held, Math.max(cap, TAB_ACTIVE));
      cap = fairCap(shown.filter(c => c !== active).map(want), room - held);
    }
    return new Map(shown.map(c => [c.id, c === active ? held : Math.min(want(c), Math.max(cap, TAB_FLOOR))]));
  }

  stripAt(shown, widths) {

    const walked = shown.findIndex(c => within(this, [`tab-${c.id}`, `close-${c.id}`]));
    const room = this.room ?? 0, i = walked >= 0 ? walked : shown.findIndex(c => c.active), width = (c) => widths.get(c.id);
    const key = `${shown[i]?.id}:${i}:${room}:${i >= 0 ? width(shown[i]) : 0}`;
    if (i >= 0 && room > 0 && key !== this.revealed && shown.every(c => this.nameW[c.id])) {
      this.revealed = key;
      const left = shown.slice(0, i).reduce((sum, c) => sum + width(c) + TAB_GAP, 0), right = left + width(shown[i]);
      if (left < this.strip) this.strip = left;

      else if (right > this.strip + room) this.strip = Math.min(left, right - room);
    }
    const all = shown.reduce((sum, c) => sum + width(c) + TAB_GAP, -TAB_GAP);
    this.strip = Math.max(0, Math.min(this.strip, all - room));
    return this.strip;
  }

  sidebarToggle(t, stopPress, live, st) {
    const counts = ["blocked", "working", "done"].map(s => [s, live.filter(a => st(a) === s).length]).filter(([, n]) => n > 0);
    const words = { blocked: "needing you", working: "working", done: "done" };
    const summary = counts.map(([s, n]) => `${n} ${words[s]}`).join(" · ");
    return tip(this, t, "sidebar-toggle", "Show sidebar", stop(this, t, "sidebar-toggle", h_flex().id("sidebar-toggle").h(28).px(6).mr(8).gap(8).flex_none().items_center().rounded(8)
      .text_size(12).text_color(lit(this, "sidebar-toggle")).hover(s => s.bg(t.hover)).on_hover(glow(this, "sidebar-toggle"))
      .role("button").accessibility_label(summary ? `Show sidebar, ${summary}` : "Show sidebar")

      .on_mouse_down("left", stopPress).on_click(() => { this.hot = null; run("layout.toggle", { id: "sidebar" }); })
      .child(svg("mods/t3-tabs/icons/panel-left.svg").size(16).flex_none())
      .children(counts.map(([s, n]) => h_flex().id(`agents-${s}`).gap(4).items_center().child(mark(t, s)).child(div().text_color(t.muted).child(String(n))))), 8), { action: "layout.toggle:sidebar", below: true });
  }

  fit(size) {
    const id = props()?.block, px = Math.ceil(size.width / (Number(settings()?.zoom) || 1));
    if (!id || px === this.fitted) return;
    this.fitted = px;
    run("layout.resize", { id, px });
  }

  async close() {
    stopsEnd(this);
    if (props()?.part === "measure") setShared("bar.compact", false);
  }

  render() {
    const zoom = Number(settings()?.zoom) || 1;

    if (props()?.part === "measure") return div().id("bar-measure").size_full()
      .on_size_change((size) => {
        const isCompact = size.width / (Number(settings()?.zoom) || 1) < 1024;
        if (shared("bar.compact") !== isCompact) setShared("bar.compact", isCompact);
      });
    const t = theme(), w = window();
    const stopPress = (_e, cx) => cx.stop_propagation();

    const button = (id, glyph, label, action, key, size = 24) => tip(this, t, id, label, stop(this, t, id, div().id(id).size(size).flex_none().flex().items_center().justify_center().rounded(8).text_color(lit(this, id)).hover(s => s.bg(t.hover)).on_hover(glow(this, id))
      .role("button").accessibility_label(label)
      .on_mouse_down("left", stopPress).on_click(action).child(glyph), 8), { action: key, below: true });

    if (props()?.part === "end") return focusRoot(this, h_flex().size_full().items_center().justify_end().bg(t.chrome)
      .child(h_flex().id("tabs-end").flex_none().pr(12).gap(4).items_center().on_size_change((size) => this.fit(size))
        .when(!atHome(), el => el.child(button("tab-new", svg("mods/t3-tabs/icons/plus.svg").size(14), "New tab", () => run("tab.new"), "t3-tabs.new")))
        .when(w?.buttons, el => el.child(button("minimize", w.platform === "windows" ? svg("mods/t3-tabs/icons/win-min.svg").size(16) : "−", "Minimize", () => run("window.minimize"), undefined, 28))
          .child(button("maximize", w.platform === "windows" ? svg(`mods/t3-tabs/icons/${w.maximized ? "win-restore" : "win-max"}.svg`).size(16) : "□", w.maximized ? "Restore" : "Maximize", () => run("window.maximize"), undefined, 28))
          .child(button("close-window", w.platform === "windows" ? svg("mods/t3-tabs/icons/win-close.svg").size(16) : svg("mods/t3-tabs/icons/x.svg").size(16), "Close window", () => run("window.close"), undefined, 28)))));
    const space = spaces().find(p => p.active);

    if (!props()?.part) this.track();
    const shown = this.visibleTabs(), inbox = inboxShown();

    if (this.hot?.startsWith("close-") && !shown.some(c => this.hot === `close-${c.id}`)) this.hot = null;

    const every = agents(), all = terminals(), under = subAgents(every, all);
    const st = (a) => treeStatus(ownStatus(a.status, a.address, all), under(a.address));
    const live = awake(st, under);
    const ps = panes();

    const statusOf = (c) => {
      const words = [...every.filter(a => a.tab === c.id).map(a => st(a) === "done" && notNews(all.find(k => k.address === a.address), a.status, under(a.address)) ? "idle" : st(a)), ...ps.filter(p => p.tab === c.id && p.mod).map(p => modStatus(p))];
      return words.includes("blocked") ? "blocked"
        : words.includes("done") ? "done"
        : words.includes("working") ? "working" : null;
    };
    const widths = this.tabWidths(shown, (c) => this.nameW[c.id] ? Math.max(TAB_MIN, Math.ceil(this.nameW[c.id]) + TAB_CHROME) : TAB_FLOOR);

    const loose = (c) => !inbox || !every.some(a => a.tab === c.id);

    const pressedAt = shown.findIndex(c => c.id === this.pressed);
    const item = (c, i) => {
      const lead = leadOf(ps.filter(p => p.tab === c.id));
      const program = lead && programOf(lead);
      const name = nameOf(c, lead);

      const isOwnZoom = c.zoomed && !ps.some(p => p.tab === c.id && p.zoomed && (p.mod === "t3-chat" || p.mod === "agent-chat"));
      const status = inbox ? null : statusOf(c), label = isOwnZoom ? `${name} Z` : name;

      const tabId = `tab-${c.id}`, closeId = `close-${c.id}`;
      const over = this.overTab === c.id || within(this, [tabId, closeId]);
      const glyph = !program?.icon ? svg("mods/t3-tabs/icons/terminal.svg").size(12).text_color(t.muted)
        : program.tint ? svg(program.icon).size(12).text_color(t.muted) : image(program.icon).size(12);

      const says = status || !(widths.get(c.id) >= Math.ceil(this.nameW[c.id]) + TAB_CHROME);
      const cardShown =  (this).details === c.id &&  (this).detailsIn && !this.hot, cardFade =  ({ duration: 150, easing: "ease-out" });
      const details = Popup.new(`details-${c.id}`, div()).absolute().bottom(0).left(6 + 16 + 2 - (1 + 8)).size(1)
        .when(( (this).details === c.id && this.pressed === null) ||  (this).detailsOut === c.id, pop => pop.content(div().id(`details-card-${c.id}`)
          .mt(4).max_w(320).px(8).py(4).rounded(6).border(1).border_color(t.border).bg(t.chrome).shadow_md().text_size(12).text_color(t.foreground)
          .opacity(cardShown ? 1 : 0).top(cardShown ? 0 : -4).transition("opacity", cardFade).transition("top", cardFade)
          .child(status ? `${name} · ${WORDS[status]}` : name)));
      const tab = h_flex().id(tabId).relative().h(24).w(widths.get(c.id)).pl(6).pr(8).gap(2).rounded(6).items_center().flex_none().text_size(12)
        .bg(c.active ? t.selected : t.chrome).text_color(c.active || over ? t.foreground : t.muted)
        .role("button").accessibility_label(name)
        .on_hover((on, cx) => {
          if (on) { this.overTab = c.id; detailsWatch(this, c.id, cx); }
          else if (this.overTab === c.id) { this.overTab = null; detailsFor(this, null, cx); }
          cx.notify();
        })
        .when(!c.active, el => el.hover(s => s.bg(t.hover)))

        .when(pressedAt === i && this.over !== null && this.over !== c.id, el => el.opacity(0.5))
        .when(pressedAt >= 0 && this.over === c.id && pressedAt !== i, el => el.child(
          div().absolute().top(0).bottom(0).w(2).bg(t.accent)
            .when(pressedAt < i, line => line.right(0))
            .when(pressedAt > i, line => line.left(0)),
        ))
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); detailsFor(this, null, cx); this.pressed = c.id; this.over = null; this.pressAt = e.position; if (e.click_count === 2) run("tab.rename", { id: c.id }); })
        .on_mouse_move((e, cx) => {
          detailsAt(this, c.id, e);
          const held = shown.find(x => x.id === this.pressed);
          if (!held || this.over === c.id || !loose(held) || !loose(c)) return;

          if (this.over === null && Math.hypot(e.position.x - this.pressAt.x, e.position.y - this.pressAt.y) < 6 * zoom) return;
          this.over = c.id;
          cx.notify();
        })
        .on_mouse_up("left", (_e, cx) => {
          const from = this.pressed ?? c.id, to = this.over; this.pressed = this.over = null;

          if (from !== to && shown.some(x => x.id === from) && shown.some(x => x.id === to)) run("tab.move", { id: from, index: space.tabs.findIndex(x => x.id === to) + 1 });

          else if (shown.some(x => x.id === from)) run("tab.select", { id: from });
          cx.notify();
        })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); detailsFor(this, null, cx); openOverlay({ mod: "t3-menu", kind: "popup", width: 220, props: { tab: "tab", target: { id: c.id, space: space.id } } }); })

        .child(div().id(`name-${c.id}`).absolute().top(0).left(0).h(0).overflow_hidden().whitespace_nowrap().child(label)
          .on_size_change((size, cx) => {
            const width = size.width / (Number(settings()?.zoom) || 1);
            if (this.nameW[c.id] === width) return;
            this.nameW[c.id] = width;
            cx.notify();
          }))

        .child(h_flex().id(`label-${c.id}`).flex_1().min_w(0).h_full().gap(2).items_center()
          .on_hover((on, cx) => { detailsFor(this, on && says ? c.id : null, cx); cx.notify(); })
          .child(div().size(16).flex_none().flex().items_center().justify_center().child(glyph))
          .child(div().flex_1().min_w(0).truncate().child(label)))

        .child(tip(this, t, closeId, "Close tab", div().id(closeId).size(16).flex_none().flex().items_center().justify_center().rounded(4).hover(s => s.bg(t.raised)).on_hover(glow(this, closeId))
          .role("button").accessibility_label(`Close ${name}`)
          .on_mouse_down("left", stopPress).on_click((_e, cx) => { cx.stop_propagation(); run(`t3-tabs.close-tab:${c.id}`); })
          .when(over, el => el.child(svg("mods/t3-tabs/icons/x.svg").size(12).text_color(t.foreground)))
          .when(!over && status != null, el => el.child(mark(t, status)))
          .when(over, el => stop(this, t, closeId, el, 4)), { action: c.active ? "t3-tabs.close-tab" : undefined, below: true, delay: 500 }))
        .when([this.overTab,  (this).details,  (this).detailsOut].includes(c.id), el => el.child(details));

      return stop(this, t, tabId, tab, 6, { enter: () => run("tab.select", { id: c.id }) });
    };
    const root = layout(), sidebar = find(root, "sidebar");

    const lightsPadding = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
      ? Math.max(8, (root.traffic_lights[0] + 64) / zoom - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0))
      : 8;
    const notice = sidebar?.hidden && this.undoNotice(t);
    return focusRoot(this, h_flex().size_full().min_w(0).pl(lightsPadding).pr(4).gap(4).items_center().bg(t.chrome)
      .on_mouse_up("left", (_e, cx) => { this.pressed = this.over = null; cx.notify(); })

      .on_hover((on, cx) => {
        if (on || this.pressed === null) return;
        this.pressed = this.over = null;
        cx.notify();
      })
      .on_scroll_wheel((e, cx) => {
        if (Math.abs(e.delta.x) > Math.abs(e.delta.y)) { this.strip -= e.delta.x / zoom; cx.notify(); }
        else if (Math.abs(e.delta.y) >= 1) this.walkTabs(e.delta.y > 0 ? -1 : 1);
      })
      .when(Boolean(sidebar?.hidden), el => el.child(this.sidebarToggle(t, stopPress, live, st)))
      .when(Boolean(notice), el => el.child(notice))
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_center().overflow_hidden()
        .on_size_change((size, cx) => {
          const nextRoom = size.width / (Number(settings()?.zoom) || 1);
          if (this.room === nextRoom) return;
          this.room = nextRoom;
          cx.notify();
        })
        .child(h_flex().id("tab-strip").flex_none().h_full().items_center().gap(TAB_GAP).ml(-this.stripAt(shown, widths)).children(shown.map(item)))));
  }

  undoNotice(t) {
    const n = shared("t3-inbox.notice");
    if (!n || Date.now() - n.at >= 6000) return null;
    return h_flex().id(`undo-notice-${n.gen}`).flex_none().h(24).gap(4).items_center().text_size(11).text_color(t.dim)
      .opacity(n.shown ? 1 : 0).transition("opacity", { duration: 200, easing: "ease-out" })
      .child(`${n.action}${n.count === 1 ? "" : ` ${n.count}`},`)
      .child(h_flex().id("undo-notice-undo").h(24).items_center().font_medium().text_color(t.foreground)
        .when(n.live && Date.now() - n.at < 5000, el => stop(this, t, "undo-notice-undo", el.hover(s => s.underline()).role("button")
          .accessibility_label(`Undo: ${n.action}`).on_click(() => run("t3-tabs.undo")), 4)).child("Undo"));
  }
}
