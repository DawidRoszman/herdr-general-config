import { div, svg } from "gpui-kit";

export const MOTION =  ({ duration: 150, easing: "ease-out" });

export function foldArrow(mod, id, open, size, color) {
  const glyph = (name) => svg(`mods/${mod}/icons/chevron-${name}.svg`).size(size).flex_none().text_color(color);
  if (!id) return glyph(open ? "down" : "right");
  const way = (name, on) => div().id(`${id}-${name}`).absolute().top(0).left(0).opacity(on ? 1 : 0).transition("opacity", MOTION).child(glyph(name));
  return div().relative().size(size).flex_none().child(way("down", open)).child(way("right", !open));
}

export function planMotion(view, entries, cx, { freeze, from } =  ({})) {
  let y = 0;
  const at = new Map(entries.map((e) => { const top = e.y ?? y; y = top + e.h; return [e.key, { ...e, y: top }]; }));
  const sig = [...at.keys()].join("\n"), m = view.motion;
  if (!m || sig === m.sig || freeze) {
    view.motion = { gen: {}, fly: {}, exits: [], step: 0, leaving: false, ...m, sig, at };
    return;
  }
  const exits = [...m.at.values()].filter((v) => !at.has(v.key));
  const fresh = [...at.keys()].filter((k) => !m.at.has(k));
  const step = m.step + 1;
  if (fresh.length + exits.length > 40) {
    view.motion = { ...m, sig, at, fly: {}, exits: [], step, leaving: false };
    return;
  }
  const fly = {}, gen = m.gen;
  let riding;
  for (const [k, v] of at) {
    const was = from?.key === k ? from.y : m.at.get(k)?.y;
    if (was === undefined) {
      gen[k] = (gen[k] ?? 0) + 1;
      fly[k] = { top: riding ?? -Math.min(v.h, 40), fade: true };
      continue;
    }
    riding = was - v.y;
    if (riding === 0) continue;
    gen[k] = (gen[k] ?? 0) + 1;
    fly[k] = { top: riding };
  }
  const old = [...m.at.keys()];
  for (const x of exits) {
    const above = old.slice(0, old.indexOf(x.key)).reverse().find((k) => at.has(k));
    x.travel = above === undefined ? Math.min(x.h, 40) : -(fly[above]?.top ?? 0);
  }
  view.motion = { sig, at, gen, fly, exits, step, leaving: false };

  cx.timer.after(16, (cx) => { if (view.motion.step !== step) return; view.motion.fly = {}; view.motion.leaving = true; cx.notify(); });
  cx.timer.after(MOTION.duration + 50, (cx) => { if (view.motion.step !== step) return; view.motion.exits = []; cx.notify(); });
}

export function flying(view, key, child) {
  const f = view.motion.fly[key];
  return div().id(`fly-${key}-${view.motion.gen[key] ?? 0}`).flex_none().relative()
    .top(f?.top ?? 0).opacity(f?.fade ? 0 : 1).transition("top", MOTION).transition("opacity", MOTION)
    .child(child);
}

export function leavingRows(view) {
  const away = view.motion.leaving;
  return view.motion.exits.filter((x) => x.ghost).flatMap((x) => {
    try {
      return [div().id(`leaving-${x.key}-${view.motion.step}`).absolute().left(0).right(0).top(x.y + (away ? x.travel : 0))
        .opacity(away ? 0 : 1).transition("top", MOTION).transition("opacity", MOTION).child(x.ghost())];
    } catch { return []; }
  });
}
