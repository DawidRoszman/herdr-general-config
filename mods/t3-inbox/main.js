import { View } from "gpui-kit";
import { v_flex, InputState } from "gpui-base";
import { agents, terminals, panes, spaces, focused, hc, notify, theme, shared, setShared, setAgentOrder, props, nextCommand, settings, layout } from "herdr";
import { modStatus, programOf } from "./name.js";
import { descendants, ownStatus, stillSettled } from "./tree.js";
import { stopsInit, stopsEnd, focusRoot, enter } from "./focus.js";
import { FIRST, trackInboxRows, inboxInView, inboxFields, inboxSections } from "./row-model.js";
import { DAY, initCustom, customView } from "./snooze.js";
import { inboxMatches, pickInboxSpace } from "./filter.js";
import { inboxActions } from "./actions.js";
import { inboxDrag } from "./drag.js";
import { inboxRowView } from "./row-view.js";
import { inboxList } from "./list-view.js";

const RETRY = 60000;

export default class Inbox extends View {
  async close() { stopsEnd(this); }

  init(_props, cx) {
    if (props()?.customSnooze) return initCustom(this, cx);
    stopsInit(this, cx);

     (this).fs.hold = () => (this.napMenu && this.napKeys.is_focused()) || (this.scopeOpen && this.searching);

    this.changed = JSON.parse(localStorage.getItem("changes") ?? "{}");
    this.open = localStorage.getItem("open") === "true";
    this.workOpen = localStorage.getItem("working-open") === "true";
    this.napOpen = localStorage.getItem("snoozed-open") === "true";

    this.napMenu = null;
    this.undoRequest = shared("t3-inbox.undo");
    this.napAt = -1;
    this.napKeys = cx.focus_handle();
    this.limit = FIRST;

    this.pending = { settled: {}, snoozed: {} };

    this.writing = {};

    this.refused = {};
    this.hovered = null;

    this.rowH = {};

    this.scope = JSON.parse(localStorage.getItem("scope") ?? "[]");
    this.scopeOpen = false;
    this.scopeAt = 0;
    this.search = InputState.new({ placeholder: "Search spaces…" });
    this.search.on("change", (_e, cx) => { this.scopeAt = 0; cx.notify(); });
    this.search.on("submit", (_e, cx) => this.pick(this.matches()[this.scopeAt], false, cx));

    this.search.on("focus", () => { this.searching = true; });
    this.search.on("blur", () => { this.searching = false; });

    this.keys = cx.focus_handle();

    cx.timer.every(1000, (cx) => {
      const findLists = (n) => (n?.id === "sidebar-lists" ? n : (n?.children ?? []).map(findLists).find(Boolean));
      const mode = findLists(layout());
      const isInboxActive = !mode || mode.active === "inbox";
      if (props()?.home && isInboxActive) {
        this.consumeUndo(cx);
        this.compute(cx);
      }
      if (this.ticking) { this.ticking = false; cx.notify(); }
    });

    cx.timer.every(60000, (cx) => cx.notify());

    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "settle")  (this).settleKey?.(cx);
        else if (command === "clear")  (this).clearSettled?.();
        else if (command.startsWith("custom-snooze:"))  (this).customSnooze?.(command.slice("custom-snooze:".length), cx);
        else if (command === "undo") this.undo(cx);

        else if (command === "focus") enter(this, cx, "inbox-search");
        cx.notify();
      }
    });
  }

  matches() { return inboxMatches(this); }

  pick(s, shift, cx) { pickInboxSpace(this, s, shift, cx); }

  track(list, all, now, cx) {
    const { changes, waits, dirty } = trackInboxRows(this.changed, list, all, now);
    for (const ms of waits) cx.timer.after(ms, (cx) => cx.notify());
    if (!dirty) return;

    for (const key of Object.keys(this.changed)) if (!(key in changes)) delete this.changed[key];
    Object.assign(this.changed, changes);
    localStorage.setItem("changes", JSON.stringify(this.changed));
  }

  setLabel(key, addr, value, cx) {
    this.pending[key][addr] = value;
    const slot = `${key} ${addr}`, w = this.writing[slot] ?? (this.writing[slot] = { out: 0, unsure: false });

    w.unsure = w.unsure || (w.out > 0 && (terminals().find((k) => k.address === addr)?.labels?.[key] ?? "") === value);
    w.out++;
    cx.spawn(async (cx) => {
      const r = await hc(["label", addr, `${key}=${value}`]).catch((e) => ({ code: 1, stderr: String(e) }));
      if (--w.out === 0) delete this.writing[slot];
      if (r.code !== 0) {
        if (this.pending[key][addr] === value) delete this.pending[key][addr];
        this.refused[`${key} ${addr} ${value}`] = Date.now();
        notify({ title: "Couldn't update the agent", body: r.stderr.trim(), level: "error" });

        if (value && this.notice?.live) { if (--this.notice.count > 0) this.publishNotice(); else this.forget(cx); }
      }
      if (w.out === 0 && w.unsure && this.pending[key][addr] !== undefined) this.setLabel(key, addr, this.pending[key][addr], cx);
      cx.notify();
    });
  }

  setLabelDue(key, addr, value, cx) {
    const write = `${key} ${addr} ${value}`;
    if (Date.now() - (this.refused[write] ?? -Infinity) < RETRY) return;
    delete this.refused[write];
    this.setLabel(key, addr, value, cx);
  }

  remember(action, count, undo, cx) {
    const live = this.notice?.live && shared("t3-inbox.notice")?.owner !== "tabs" && this.notice.action === action ? this.notice : null;
    const n = live ?? { action, count: 0, undos: [], gen: (this.notice?.gen ?? 0) + 1, shown: false };
    n.count += count; n.undos.push(undo); n.live = true; n.at = Date.now();
    this.notice = n;
    this.publishNotice(true);
    const ran = n.undos.length;
    if (!live) cx.timer.after(16, (cx) => { if (this.notice === n && n.live) { n.shown = true; this.publishNotice(); cx.notify(); } });
    cx.timer.after(5000, (cx) => {
      if (this.notice === n && n.undos.length === ran) { this.consumeUndo(cx); this.forget(cx); }
    });
  }

  forget(cx) {
    const n = this.notice;
    if (!n?.live) return;
    n.live = false; n.shown = false;
    this.publishNotice();
    cx.timer.after(250, (cx) => { if (this.notice === n) { this.notice = null; this.publishNotice(); cx.notify(); } });
    cx.notify();
  }

  undo(cx) {
    if (!this.notice?.live) return;
    for (const undo of [...this.notice.undos].reverse()) undo(cx);
    this.forget(cx);
  }

  consumeUndo(cx) {
    const undo = shared("t3-inbox.undo");
    if (JSON.stringify(undo) === JSON.stringify(this.undoRequest)) return;
    this.undoRequest = undo;
    if (undo && undo.gen === this.notice?.gen && undo.at === this.notice?.at && undo.requestedAt < undo.at + 5000) this.undo(cx);
  }

  publishNotice(fresh = false) {
    const n = this.notice;
    const said = n ? { action: n.action, count: n.count, gen: n.gen, shown: n.shown, live: n.live, at: n.at } : null;
    const before = this.said;
    this.said = JSON.stringify(said);
    if (this.said !== before && (fresh || JSON.stringify(shared("t3-inbox.notice") ?? null) === before)) setShared("t3-inbox.notice", said);
  }

  compute(cx, publish = true) {
    const now = Date.now();

    const offAgents = new Set(shared("context")?.offAgents ?? []), offSpaces = new Set(shared("context")?.offSpaces ?? []);
    const runs = agents().filter((a) => !offAgents.has(a.address)), all = terminals(), ps = panes(), sp = spaces(), f = focused();

    const every = [...runs, ...sp.filter((s) => !offSpaces.has(s.id)).flatMap((s) => s.tabs.flatMap((c) => {
      const cards = ps.filter(x => x.tab === c.id && x.mod && programOf(x)?.inbox);
      return (props()?.home ? cards : runs.some(a => a.tab === c.id) ? [] : cards.slice(0, 1)).map(p => ({ ...p,
        address: `pane:${p.pane}`, status: modStatus(p) ?? "idle", focused: p.pane === f?.pane,
        space: s.id, space_name: s.name, program: { name: p.title, ...programOf(p) } }));
    }))];
    const inView = inboxInView(every, all, f);

    if (this.inView !== undefined && inView && inView !== this.inView && this.scope.length) {
      const a = every.find((x) => x.address === inView);
      if (a && !this.scope.includes(a.space)) { this.scope = []; localStorage.setItem("scope", "[]"); this.limit = FIRST; }
    }
    this.inView = inView;

    const scope = this.scope.filter((id) => !offSpaces.has(id) && sp.some((s) => s.id === id));
    const term = new Map(all.map((k) => [k.address, k]));
    for (const [key, of] of Object.entries(this.pending)) {
      for (const [k, v] of Object.entries(of)) if (!term.has(k) || (!this.writing[`${key} ${k}`]?.unsure && (term.get(k).labels?.[key] ?? "") === v)) delete of[k];
    }
    const fields = inboxFields({ every, all, term, pending: this.pending, changed: this.changed, now, inView });
    const { viewing, settledAt, kids, state, running, napUntil, hidden, since, working, begun } = fields;

    for (const a of every) {
      const label = this.pending.settled[a.address] ?? term.get(a.address)?.labels?.settled;
      if (label && !stillSettled({ labels: { settled: label }, turn: term.get(a.address)?.turn }, ownStatus(a.status, a.address, all), kids.get(a.address))) this.setLabelDue("settled", a.address, "", cx);
    }

    const pins = shared("agents.pins") ?? [];
    const wake = (a, cx) => this.setLabel("snoozed", a.address, "", cx);

    const failed = (a) => term.get(a.address)?.status === "error" || descendants(all, a.address).some((k) => k.status === "error");
    for (const a of every) {
      const until = napUntil(a);
      if (!until) continue;
      const turned = viewing(a) && running(a) && ["idle", "done"].includes(this.changed[a.address]?.s);
      if (failed(a) || turned || (viewing(a) && until <= now)) this.setLabelDue("snoozed", a.address, "", cx);
    }
    const tabs = new Map(sp.flatMap((s) => s.tabs.map((c) => [c.id, c])));
    this.track(every.map((a) => ({
      address: a.address, s: state(a) === "blocked" ? "blocked" : running(a) ? "working"
        : state(a) === "done" && kids.get(a.address).includes("working") ? "done" : "idle",
      turn: term.get(a.address)?.turn ?? 0, excluded: pins.includes(a.address) || Boolean(settledAt(a)) || hidden(a),

      first:  (a).mod ? now : 0,

      changed: state(a) === ownStatus(a.status, a.address, all) ? tabs.get(a.tab)?.changed_at : null,
    })), all, now, cx);
    const sections = inboxSections(every.map((a) => ({ a, address: a.address, settledAt: settledAt(a), hidden: hidden(a),
      working: working(a), viewing: viewing(a), since: since(a), begun: begun(a), napUntil: napUntil(a) })),
      { scope, pins, workOpen: this.workOpen, napOpen: this.napOpen, open: this.open, limit: this.limit });
    const { pinned, out, work, nap, put, busyRows, napRows, rows, next } = sections;

    if (this.napMenu && ![...pinned, ...out, ...busyRows].some((a) => a.address === this.napMenu && state(a) !== "blocked")) this.napMenu = null;

    if (next !== this.nextWake) {
      this.wakeTimer?.cancel();
      this.nextWake = next;
      this.wakeTimer = next < Infinity ? cx.timer.after(Math.min(next - now, DAY), (cx) => { this.nextWake = null; cx.notify(); }) : null;
    }
    if (publish) this.publishRows([...pinned, ...out, ...busyRows, ...napRows, ...rows], inView,
      [...pinned, ...out, ...work, ...nap, ...put]);
    return { now, all, ps, sp, f, every, inView, scope, term, pins, wake, ...fields, ...sections };
  }

  publishRows(rows, view, ordered = rows) {
    const find = (n) => n?.id === "sidebar-lists" ? n : (n?.children ?? []).map(find).find(Boolean);
    const mode = find(layout());
    if (mode && mode.active !== "inbox") { this.agentOrder = null; return; }
    const drawn = { order: rows.map((a) => a.address), view };
    if (JSON.stringify(drawn) !== JSON.stringify(shared("t3-inbox.rows") ?? null)) setShared("t3-inbox.rows", drawn);
    const order = ordered.filter((a) => !a.mod).map((a) => a.address);
    if (JSON.stringify(order) !== this.agentOrder || shared("t3-agent-order") !== "inbox") {
      this.agentOrder = JSON.stringify(order);
      setAgentOrder(order);
      if (shared("t3-agent-order") !== "inbox") setShared("t3-agent-order", "inbox");
    }
  }

  render(cx) {
    if (props()?.customSnooze) return customView(this);
    const t = theme(), zoom = Number(settings()?.zoom) || 1;
    const model = this.compute(cx, false);
    const actions = inboxActions(this, model);
    const drag = inboxDrag(this, t, model, actions);
    this.publishRows([...model.pinned, ...model.out, ...model.busyRows, ...model.napRows, ...drag.rows], model.inView,
      [...model.pinned, ...model.out, ...model.work, ...model.nap, ...model.put]);
    const draw = inboxRowView(this, t, model, actions, drag);
    const { top, list } = inboxList(this, t, model, actions, drag, draw, cx);
    const tree = drag.root(v_flex().id("t3-inbox-root").relative().size_full().min_h(0).bg(t.chrome).text_size(14)
      .on_size_change((size) => { this.height = size.height / zoom; this.width = size.width / zoom; }))
      .child(top).child(list);
    const ghost = drag.ghost(draw);
    if (ghost) tree.child(ghost);

    const gone = this.hovered;
    if (gone && !drag.drawn.order.includes(gone)) {
      this.hovered = null;
       (this).detailsWait?.cancel();
      if (this.details === gone) this.details = null;
      if (this.detailsOut === gone) this.detailsOut = null;
    }
    return focusRoot(this, tree);
  }
}
