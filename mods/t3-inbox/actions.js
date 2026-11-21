import { focused, run, shared, setShared, props, notify, openOverlay } from "herdr";
import { focusAgent, focusPane } from "./zoom.js";
import { detailsFor } from "./details.js";

export function inboxActions(view, model) {
  const { every, viewing, term, pins, napUntil, wake, state, settledAt, busy, pinned, out, busyRows, sp, ps, put } = model;

  const away = (a, cx) => {
    if (view.hovered !== a.address) return;
    view.hovered = null;
    detailsFor(view, null, cx);
  };

  const repin = (before, took) => {
    const current = [...(shared("agents.pins") ?? [])];
    for (const p of before.filter((p) => took.includes(p) && !current.includes(p))) {
      const next = before.slice(before.indexOf(p) + 1).find((q) => current.includes(q));
      current.splice(next ? current.indexOf(next) : current.length, 0, p);
    }
    setShared("agents.pins", current);
  };

  const unsettle = (a, cx) => {
    away(a, cx);
    view.setLabel("settled", a.address, "", cx);
    view.changed[a.address] = { ...view.changed[a.address], at: Date.now(), start: null };
    localStorage.setItem("changes", JSON.stringify(view.changed));
  };
  const go = (a) => a.mod ? focusPane(a.pane) : focusAgent(a.address);

  const moveOn = (xs) => {
    const cards = [...pinned, ...out, ...busyRows], i = cards.findIndex(viewing);
    if (i < 0 || !xs.includes(cards[i])) return false;

    if (props()?.home) { if (cards[i].mod) return false; run(props().home); return true; }
    const next = [...cards.slice(i + 1), ...cards.slice(0, i)].find((a) => !xs.includes(a));
    if (next) go(next);
    return Boolean(next);
  };

  const bringBack = (a) => { if (a && props()?.home && focused()?.space === shared("t3-home.space")) go(a); };

  const settle = (xs, cx) => {
    const panes = xs.filter((a) => a.mod), kept = xs.filter((a) => !a.mod), seen = kept.find(viewing);
    for (const a of xs) away(a, cx);
    const naps = new Map(kept.map((a) => [a, napUntil(a)]));
    const before = [...pins], unpinned = pins.filter((p) => !kept.some((a) => a.address === p));
    if (unpinned.length < before.length) setShared("agents.pins", unpinned);
    for (const a of kept) {
      view.setLabel("settled", a.address, `${Date.now()}:${term.get(a.address)?.turn ?? 0}`, cx);
      if (naps.get(a)) wake(a, cx);
    }

    if (kept.length) view.remember("Settled", kept.length, (cx) => {
      repin(before, kept.map((a) => a.address));
      for (const a of kept) {
        view.setLabel("settled", a.address, "", cx);
        if (naps.get(a) > Date.now()) view.setLabel("snoozed", a.address, String(naps.get(a)), cx);
      }
      bringBack(seen);
    }, cx);
    const moved = moveOn(xs);
    for (const a of panes) run(props()?.home ? `t3-tabs.close-pane:${a.pane}` : "pane.close", props()?.home ? undefined : { pane: a.pane });
    return moved;
  };
  const snooze = (a, at, cx) => {
    const seen = viewing(a);
    view.setLabel("snoozed", a.address, String(at), cx);
    view.remember("Snoozed", 1, (cx) => { wake(a, cx); if (seen) bringBack(a); }, cx);

    view.napMenu = view.hovered = view.hot = null;
    detailsFor(view, null, cx);
    moveOn([a]);
  };

  const pick = (a, p, cx) => {
    if (p.custom) {

      view.napMenu = view.hovered = view.hot = null;
      detailsFor(view, null, cx);
      openOverlay({ mod: "t3-inbox", kind: "dialog", frame: "none", width: 384, props: { customSnooze: a.address } });
      return;
    }
    const at = p.hours ? Date.now() + p.hours * 3600000 : p.at;
    if (at > Date.now()) return snooze(a, at, cx);
    view.napAt = -1;
    notify({ title: "Couldn't snooze the agent", body: "That time has passed. Choose another.", level: "warning" });
  };

  view.customSnooze = (answer, cx) => {
    const i = answer.lastIndexOf(":"), at = Number(answer.slice(i + 1)), a = every.find((x) => x.address === answer.slice(0, i));
    if (a && state(a) !== "blocked" && at > Date.now()) snooze(a, at, cx);
  };

  view.settleKey = (cx) => {
    const a = every.find(viewing);
    if (!a) return;
    if (settledAt(a)) unsettle(a, cx);
    else if (!busy(a)) settle([a], cx);
  };

  const spaceNow = sp.find((s) => s.active), tabNow = spaceNow?.tabs.find((c) => c.active)?.id;
  const doomed = put.filter((a) => a.pane && !viewing(a) && a.tab !== tabNow);
  view.clearSettled = () => {
    const gone = new Set(doomed.map((a) => a.pane));
    for (const id of new Set(doomed.map((a) => a.space))) {
      const s = sp.find((s) => s.id === id), tabs = s?.tabs.map((c) => c.id) ?? [];
      const mine = ps.filter((p) => tabs.includes(p.tab));

      if (mine.every((p) => gone.has(p.pane))) run("tab.new", { space: id, folder: mine.find((p) => p.cwd)?.cwd || s.folder });
      for (const a of doomed.filter((a) => a.space === id)) run("pane.close", { pane: a.pane });
    }

    if (tabNow) { run("space.select", { id: spaceNow.id }); run("tab.select", { id: tabNow }); }
  };

  return { away, repin, unsettle, go, settle, pick, doomed };
}
