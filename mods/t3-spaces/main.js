import { View, div, svg } from "gpui-kit";
import { foldArrow, planMotion, flying, leavingRows } from "./motion.js";
import { v_flex, h_flex } from "gpui-base";
import { spaces, machines, panes, run, openOverlay, exec, hc, theme, shared, setShared, watchFolder, window, props, layout, nextCommand, settings, checking, appHome } from "herdr";
import { projectMark, placeOf, tint } from "./project.js";
import { dragGone, glow, hoverKept, tip, tipMark, POINTER_WATCH, pointerMoved } from "./tip.js";
import { stopsInit, stopsEnd, stop, focusRoot, enter, pressed, justClosed } from "./focus.js";
import { projectOf, projectsFirst } from "./groups.js";

const where = (s, ps) => JSON.stringify([s.machine ?? null, placeOf(s, ps)]);
const base = (path) => path.replace(/\/+$/, "").split("/").pop();

const MULTIREPO_FIND = `d=$(pwd -P)
while :; do
  if [ -f "$d/.mr-task.json" ]; then printf 'task\\n'; cat "$d/.mr-task.json"; exit 0; fi
  if [ -f "$d/.mr.json" ]; then printf 'project\\n%s\\n' "$d"; exit 0; fi
  [ "$d" = / ] && exit 0
  d=$(dirname "$d")
done`;

const FALLBACK = 60000;

const OPENING = 5000;

const ROW = 32, STACK = 1, PITCH = ROW + STACK;
const find = (n, id) => n?.id === id ? n : (n?.children ?? []).map((c) => find(c, id)).find(Boolean);

const listInView = (root = layout()) => find(root, "sidebar-lists")?.active !== "inbox" && !find(root, "sidebar")?.hidden;

function hiddenByContext() {
  const context = shared("context");
  return new Set([...(context?.offSpaces ?? []), ...Object.values(context?.coordinators ?? {})]);
}

function shownProjects() {
  const context = shared("context"), profile = context?.current ?? null;
  return { profile, projects: context?.profiles?.[profile]?.projects ?? {} };
}

const projectGroupOf = (name) => `project:${name}`;
const machineGroupOf = (machine) => `machine:${machine ?? ""}`;
const groupOf = (r) => (r.p ? projectGroupOf(r.p) : machineGroupOf(r.w.machine));
const zoneOf = (r) => `${groupOf(r)}|${r.w.machine ?? ""}`;

function numberBadge(slot, t, isActive) {
  return h_flex()
    .size(16)
    .flex_none()
    .rounded(4)
    .bg(isActive ? t.accent : t.accent + "28")
    .items_center()
    .justify_center()
    .font_family(settings().font_family ?? "JetBrains Mono")
    .font_bold()
    .text_size(10)
    .text_color(isActive ? t.accent_foreground : t.accent)
    .child(String(slot));
}

export default class Spaces extends View {
  async close() {
    this.isClosed = true;
    this.watching?.clear();
    this.keptWatch?.cancel?.();
    stopsEnd(this);
  }

  init(_props, cx) {
    this.isClosed = false;
    this.isCtrlHeld = false;
    stopsInit(this, cx);

    cx.spawn(async (cx) => {
      for (;;) if (await nextCommand() === "focus") enter(this, cx, "space-new");
    });
    this.git = {};
    this.multirepo = {};
    this.lastGit = {};
    this.opening = new Map();
    this.checked = {};
    this.unsure = new Set();
    this.pending = new Set();
    this.refreshing = new Set();
    this.busy = {};
    this.ready = {};
    this.at = {};
    this.watching = new Map();

    this.shown = new Set(spaces().map((s) => s.id));
    this.born = {};
    this.drag = null;
    this.machines = [];
    this.reconnecting = JSON.parse(localStorage.getItem("machines.reconnecting") ?? "{}");
    for (const state of Object.values(this.reconnecting)) state.busy = false;
    this.folded = new Set(JSON.parse(localStorage.getItem("machines.folded") ?? "[]"));
    this.foldedRepos = new Set(JSON.parse(localStorage.getItem("repos.folded") ?? "[]"));
    this.machinesSeen = this.machinesNow();
    if (!checking()) {
      this.refreshMachines(cx);
      cx.timer.every(15000, cx => this.refreshMachines(cx));

      cx.timer.every(250, (cx) => this.checkNew(cx));
      this.watchCtrl(cx);
    }
  }

  watchCtrl(cx) {
    const src = `${appHome()}/mods/t3-spaces/ctrl-watch.c`;
    const bin = `${appHome()}/cache/t3-spaces-ctrl-watch`;
    cx.spawn(async (cx) => {
      while (!this.isClosed && !window()) await cx.sleep(100);
      if (this.isClosed || window()?.platform !== "macos") return;
      const build = await exec("sh", [
        "-c",
        '[ -x "$2" ] && [ "$2" -nt "$1" ] || { mkdir -p "$(dirname "$2")" && clang -O2 -framework CoreGraphics "$1" -o "$2"; }',
        "sh", src, bin,
      ]).catch(() => ({ code: 1 }));
      if (build.code !== 0) return;

      while (!this.isClosed) {
        if (!window()?.active || !listInView()) {
          if (this.isCtrlHeld) {
            this.isCtrlHeld = false;
            cx.notify();
          }
          await cx.sleep(200);
          continue;
        }
        const r = await exec(bin, [this.isCtrlHeld ? "1" : "0", "15"]).catch(() => ({ code: 1, stdout: "" }));
        if (this.isClosed) break;
        if (r.code === 0) {
          const isHeld = r.stdout.trim() === "1";
          if (isHeld !== this.isCtrlHeld) {
            this.isCtrlHeld = isHeld;
            cx.notify();
          }
        } else if (r.code !== 2) {
          await cx.sleep(1000);
        }
      }
    });
  }

  machinesNow() {
    return JSON.stringify(machines().map((m) => [m.name, m.layout]));
  }

  checkNew(cx) {
    const now = Date.now();
    const sp = spaces();

    const seen = this.machinesNow();
    if (seen !== this.machinesSeen) {
      this.machinesSeen = seen;
      this.refreshMachines(cx);
    }
    this.landOnRoot(sp);
    const due = this.due(now, sp, panes());
    if (due.size) this.refreshGit(due, cx);
    if (sp.some((s) => !this.shown.has(s.id)) || this.orderingDue(now)) cx.notify();
  }

  landOnRoot(sp) {
    const active = sp.find((s) => s.active)?.id ?? null;
    const left = this.activeSpace;
    this.activeSpace = active;
    if (!left || left === active || sp.some((s) => s.id === left)) return;
    const closed = this.lastGit[left];
    if (!closed?.linked) return;
    const root = sp.find((s) => this.lastGit[s.id]?.repo === closed.repo && !this.lastGit[s.id].linked);
    if (root && root.id !== active) run("space.select", { id: root.id });
  }

  due(now, sp, ps) {

    const at = {};
    for (const s of sp) at[s.id] = where(s, ps);
    const keys = new Set(Object.values(at).filter((k) => JSON.parse(k)[1]));

    for (const k of Object.keys(this.git)) if (!keys.has(k)) { delete this.git[k]; delete this.checked[k]; this.unsure.delete(k); }

    if ([...keys].every((k) => k in this.git)) {
      const used = new Set(Object.values(this.git).filter(Boolean).map((g) => JSON.parse(g.repo)).filter(([on]) => !on).map(([, repo]) => repo));
      for (const repo of this.watching.keys()) if (!used.has(repo)) this.watching.delete(repo);
    }
    const due = new Set([...keys].filter((k) => !(k in this.git) && !(k in this.checked)));
    for (const [id, k] of Object.entries(at)) if (this.at[id] && this.at[id] !== k && keys.has(k)) due.add(k);
    this.at = at;
    const spaceOf = {};
    for (const s of sp) for (const t of s.tabs ?? []) spaceOf[t.id] = s;
    const busy = {};
    for (const p of ps) {
      if (!p.terminal || !spaceOf[p.tab]) continue;
      busy[p.pane] = p.status === "working" || !(p.program?.shell || p.program?.agent);
      if (this.busy[p.pane] && !busy[p.pane]) this.sameRepo(at[spaceOf[p.tab].id], keys).forEach((k) => due.add(k));
    }
    this.busy = busy;
    for (const m of machines()) {
      const ready = m.layout === "ready";
      if (ready && this.ready[m.name] === false) for (const k of keys) if (JSON.parse(k)[0] === m.name) due.add(k);
      this.ready[m.name] = ready;
    }
    if (window().active && listInView()) {
      for (const k of keys) {
        const asks = this.git[k] || this.unsure.has(k);
        if (asks && !this.folded.has(JSON.parse(k)[0]) && now - (this.checked[k] ?? 0) > FALLBACK) due.add(k);
      }
    }
    return due;
  }

  sameRepo(key, keys) {
    const repo = this.git[key]?.repo;
    return [key, ...(repo ? [...keys].filter((k) => this.git[k]?.repo === repo) : [])];
  }

  refreshMachines(cx) {
    cx.spawn(async cx => {
      let hasChanged = false;
      try {
        const r = await hc(["machine", "ls", "--json"]);
        if (r.code === 0) {
          const next = JSON.parse(r.stdout).machines ?? [];
          if (JSON.stringify(next) !== JSON.stringify(this.machines)) {
            this.machines = next;
            hasChanged = true;
          }

          const fixed = this.machines.filter((m) => m.state === "connected" && this.reconnecting[m.name] && !this.reconnecting[m.name].busy);
          for (const m of fixed) delete this.reconnecting[m.name];
          if (fixed.length) {
            localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
            hasChanged = true;
          }
        }
      } catch {}
      if (hasChanged) cx.notify();
    });
  }

  rebuilt(machine) {
    return machine?.state === "unreachable" && /^a different core answers there \("[^"]+"\)$/.test(machine.why ?? "");
  }

  reconnect(machine, cx) {
    const name = machine.name;
    if (this.reconnecting[name]?.busy) return;
    const state = this.reconnecting[name] ??= { machine, removed: false };
    state.busy = true;
    state.error = null;
    localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
    cx.notify();
    cx.spawn(async cx => {
      try {
        const ask = async args => {
          const r = await hc([...args, "--json"]);
          if (r.code !== 0) {
            let error;
            try { error = JSON.parse(r.stdout || r.stderr).error?.message; } catch {}
            throw new Error(error || r.stderr || r.stdout || "Couldn't connect.");
          }
        };
        if (!state.removed) {
          await ask(["machine", "rm", name]);
          state.removed = true;
          localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
        }
        const args = ["machine", "add"];
        if (machine.via) args.push("--via", machine.target);
        else args.push(machine.target);
        args.push("--name", name);
        if (machine.session) args.push("--session", machine.session);
        if (machine.temporary) args.push("--temp");
        await ask(args);
        this.folded.delete(name);
        localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
        delete this.reconnecting[name];
      } catch (e) {
        state.error = String(e.message ?? e);
        state.busy = false;
      }
      localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
      this.refreshMachines(cx);
      cx.notify();
    });
  }

  refreshGit(keys, cx) {
    const now = Date.now(), machineOf = (k) => JSON.parse(k)[0];
    for (const k of keys) { this.pending.add(k); this.checked[k] = now; }
    for (const on of new Set([...this.pending].map(machineOf))) {
      if (this.refreshing.has(on)) continue;
      this.refreshing.add(on);
      cx.spawn(async (cx) => {
        for (let key; (key = [...this.pending].find((k) => machineOf(k) === on));) {
          this.pending.delete(key);
          await this.check(key, cx);
        }
        this.refreshing.delete(on);
        cx.notify();
      });
    }
  }

  async multirepoAt(key, on, cwd) {
    if (key in this.multirepo) return this.multirepo[key];
    const r = await exec("sh", ["-c", MULTIREPO_FIND], { cwd, on });
    const [kind, ...rest] = (r.code === 0 ? r.stdout : "").split("\n");
    let place = null;
    if (kind === "task") {
      const task = JSON.parse(rest.join("\n"));

      place = { root: task.project, branch: task.branch ?? null, linked: true, host: task.host ?? null };
    } else if (kind === "project" && rest[0]) {
      place = { root: rest[0], branch: null, linked: false };
    }
    this.multirepo[key] = place && { name: base(place.root), branch: place.branch, ahead: 0, behind: 0, repo: JSON.stringify([on, place.root]), linked: place.linked, root: place.root, host: place.host ?? null };
    return this.multirepo[key];
  }

  async check(key, cx) {
    const [on, cwd] = JSON.parse(key);
    try {
      const multirepo = await this.multirepoAt(key, on, cwd).catch(() => null);
      if (multirepo) {
        this.unsure.delete(key);
        this.git[key] = multirepo;
        return;
      }

      const r = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v2", "--branch"], { cwd, on });
      this.unsure.delete(key);
      if (r.code !== 0) {

        if (!/not a git repository/i.test(r.stderr)) this.unsure.add(key);
        this.git[key] = null;
        return;
      }

      const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
      const common = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, on });
      const repo = common.stdout.trim();
      const name = repo.endsWith("/.git") ? base(repo.slice(0, -5)) : base(repo).replace(/\.git$/, "");
      const info = { name, branch: null, ahead: 0, behind: 0, repo: JSON.stringify([on, repo]), linked: repo !== `${top.stdout.trim()}/.git` };
      for (const line of r.stdout.split("\n")) {
        if (line.startsWith("# branch.head ")) info.branch = line.slice(14);
        else if (line.startsWith("# branch.ab ")) {
          const [a, b] = line.slice(12).split(" ");
          info.ahead = Math.abs(parseInt(a, 10)) || 0;
          info.behind = Math.abs(parseInt(b, 10)) || 0;
        }
      }
      this.git[key] = info;
      if (!on) this.watch(repo, cx);
    } catch {

      this.git[key] ??= null;
      this.unsure.add(key);
    }
  }

  watch(repo, cx) {
    if (this.watching.has(repo)) return;

    const token = {};
    this.watching.set(repo, token);
    cx.spawn(async (cx) => {
      try {
        while (this.watching.get(repo) === token) {
          await watchFolder(repo);
          const mine = JSON.stringify([null, repo]);
          if (this.watching.get(repo) === token) this.refreshGit(Object.keys(this.git).filter((k) => this.git[k]?.repo === mine), cx);
        }
      } catch { if (this.watching.get(repo) === token) this.watching.delete(repo); }
    });
  }

  menu(w) {

    openOverlay({ mod: "t3-menu", kind: "popup", width: 220, height: 260, props: { tab: "space", target: { id: w.id } } });
  }

  machineMenu(machine) {
    if (!machine || !Object.keys(shared("context")?.profiles ?? {}).length) return;
    openOverlay({ mod: "t3-menu", kind: "popup", width: 220, height: 260, props: { tab: "profile", target: { kind: "machine", value: machine } } });
  }

  orderingDue(now) {
    return this.ordering && now - this.ordering.at >= 1000
      && this.ordering.machines.every(name => machines().some(m => m.name === name && m.layout === "ready"));
  }

  ordered() {
    const sp = spaces(), ps = panes();
    const ready = (w) => this.shown.has(w.id) || where(w, ps) in this.git || Date.now() - (this.born[w.id] ??= Date.now()) > 1500;
    for (const w of sp) if (!this.shown.has(w.id) && ready(w)) this.shown.add(w.id);

    const homeId = shared("t3-home.space");

    const gitOf = (w) => {
      const k = where(w, ps);
      if (this.git[k] || (k in this.git && !this.unsure.has(k))) this.lastGit[w.id] = this.git[k];
      return this.lastGit[w.id] ?? null;
    };
    const { projects } = shownProjects(), projectNames = Object.keys(projects);

    const list = sp.map((w, i) => {
      const g = w.id === homeId ? null : gitOf(w);
      return { w, i, g, p: w.id === homeId ? null : projectOf({ machine: w.machine, place: placeOf(w, ps), folder: w.folder, git: g }, projects) };
    });
    const mains = new Set(list.filter((r) => r.g && !r.g.linked).map((r) => r.g.repo));
    const worktrees = (repo) => list.filter((k) => k.g?.linked && k.g.repo === repo);

    for (const [repo, at] of this.opening) {
      const main = list.findIndex((r) => r.g && !r.g.linked && r.g.repo === repo);
      const first = list.findIndex((r) => r.g?.linked && r.g.repo === repo);
      if (main >= 0 && first >= 0 && main > first) list.splice(first, 0, list.splice(main, 1)[0]);
      else if (main >= 0 || Date.now() - at > OPENING) this.opening.delete(repo);
    }

    const nested = (r) => r.g?.linked && (mains.has(r.g.repo) || worktrees(r.g.repo).length > 1);
    const out =  ([]);
    const placed = new Set();
    const hang = (top) => {
      const kids = worktrees(top.g.repo), folded = this.foldedRepos.has(top.g.repo);

      const keep = (k) => folded && k.w.active;
      top.kids = kids.length;
      top.members = kids.map((k) => k.w.id);
      top.hiding = kids.filter((k) => !keep(k)).length;
      kids.forEach((k, n) => out.push({ ...k, folded: folded && !keep(k), tree: folded || n === kids.length - 1 ? "└─" : "├─" }));
    };
    for (const r of list) {
      if (nested(r)) {
        if (mains.has(r.g.repo) || placed.has(r.g.repo)) continue;
        placed.add(r.g.repo);

        const [, common] = JSON.parse(r.g.repo);
        const head = { head: true, g: r.g, p: r.p, w: { id: `repo-${r.g.repo}`, name: r.g.name, machine: r.w.machine ?? null, folder: r.g.root ?? (common.endsWith("/.git") ? common.slice(0, -5) : null) } };
        out.push(head);
        hang(head);
        continue;
      }
      const top = { ...r, tree: null, kids: 0 };
      out.push(top);
      if (!r.g || r.g.linked || placed.has(r.g.repo)) continue;
      placed.add(r.g.repo);
      hang(top);
    }

    const isSettled = list.every((r) => r.w.id === homeId || !placeOf(r.w, ps) || where(r.w, ps) in this.git);
    const rows = projectNames.length && isSettled ? projectsFirst(out, projectNames) : out;

    const real = rows.filter((r) => !r.head);
    const order = sp.map(w => w.id);
    const target = real.map(r => r.w.id);
    const key = JSON.stringify([order, target, machines()]);
    if (order.every((id, i) => id === target[i])) {
      this.ordering = null;
    } else if (this.ordering?.key !== key || this.orderingDue(Date.now())) {
      const moved = new Set();
      this.ordering = { key, at: Date.now(), machines: [] };
      for (let i = 0; i < real.length; i++) {
        const from = order.indexOf(real[i].w.id);
        if (from === i) continue;
        run("space.move", { id: real[i].w.id, index: i + 1 });
        moved.add(real[i].w.machine ?? null);
        order.splice(i, 0, order.splice(from, 1)[0]);
      }
      this.ordering.machines = [...moved];
    }
    const hidden = hiddenByContext();
    const isHidden = (r) => r.head ? r.members.length > 0 && r.members.every((id) => hidden.has(id)) : hidden.has(r.w.id);
    return rows.filter(r => (r.head || this.shown.has(r.w.id)) && !r.folded && r.w.id !== homeId && !isHidden(r));
  }

  toggleRepo(repo, cx) {
    this.foldedRepos.has(repo) ? this.foldedRepos.delete(repo) : this.foldedRepos.add(repo);
    localStorage.setItem("repos.folded", JSON.stringify([...this.foldedRepos]));
    cx.notify();
  }

  projectGroup(t, profile, name, project, mine, entry, plain, takeSlot, showNumbers) {
    const id = `project-${name}`, group = projectGroupOf(name), foldKey = group, folded = this.folded.has(foldKey), lit = this.overMachine === id;
    const head = hoverKept(this, "overMachine", id, h_flex().id(id).h(ROW).flex_none().mx(2).px(8).gap(8).items_center()
      .text_size(12).font_medium().text_color(t.muted)
      .role("button").accessibility_label(`${folded ? "Expand" : "Collapse"} ${project.label}`))
      .on_click((_e, cx) => {
        folded ? this.folded.delete(foldKey) : this.folded.add(foldKey);
        localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
        cx.notify();
      })
      .child(svg("mods/workspace-chrome/folder.svg").size(14).ml(-1).flex_none().text_color(t.dim))
      .child(div().flex_1().min_w(0).truncate().child(project.label))

      .child(h_flex().flex_none().gap(4).items_center().text_size(11).text_color(lit ? t.foreground : t.dim)
        .when(folded && mine.length > 0, (el) => el.child(String(mine.length)))
        .child(div().id(`${id}-fold`).flex_none().child(foldArrow("t3-spaces", `${id}-fold`, !folded, 12, lit ? t.foreground : t.dim))));
    const heading = { key: id, h: PITCH, group, el: stop(this, t, id, head) };
    if (folded) return [heading];
    const key = `${profile}/${name}`;
    const coordinator = project.coordinator ? (() => {
      const slot = takeSlot();
      return [{ ...plain(`coordinator-${key}`, group, (ghost) => this.coordinatorRow(t, key, project, ghost, slot, showNumbers)), navTarget: { kind: "coordinator", key } }];
    })() : [];

    const isNaming = new Set(mine.map((r) => r.g?.host?.machine ?? r.w.machine).filter(Boolean)).size > 1;
    for (const r of mine) r.isNaming = isNaming;
    const none = plain(`${id}-none`, group, (ghost) => div().when(!ghost, (el) => el.id(`${id}-none`))
      .h(ROW).flex_none().px(10).flex().items_center().text_color(t.dim).child("No spaces"));
    return [heading, ...coordinator, ...(mine.length ? mine.map(entry) : coordinator.length ? [] : [none])];
  }

  coordinatorRow(t, key, project, ghost, slot, showNumbers) {
    const context = shared("context") ?? {};
    const space = spaces().find((s) => s.id === context.coordinators?.[key]);
    const status = space?.status ?? null, rowId = `coordinator-${key}`;
    const mark = status === "working" ? svg("mods/workspace-chrome/spinner.svg").size(12).text_color(t.working).spin(900)
      : div().size(6).rounded_full().bg(status === "blocked" ? t.blocked : status === "done" ? t.accent : space ? t.ansi2 : t.dim);
    const showBadge = showNumbers && slot >= 1 && slot <= 9;
    const note = context.starting === key ? "Starting…" : !space ? "Start" : status === "blocked" ? "Needs you" : status === "done" ? "Done" : "";
    const open = () => run(`t3-context.coordinator:${key}`);
    const el = h_flex().h(ROW).flex_none().px(10).gap(10).items_center().rounded(8)
      .when(Boolean(space?.active), (el) => el.bg(t.selected))
      .child(showBadge ? numberBadge(slot, t, Boolean(space?.active)) : div().size(16).flex_none().flex().items_center().justify_center().child(mark))
      .child(div().flex_1().min_w(0).truncate().font_medium().text_color(space ? t.foreground + "e6" : t.muted).child("Coordinator"))
      .when(Boolean(note), (el) => el.child(div().flex_none().text_size(12).text_color(status === "blocked" ? t.blocked : t.dim).child(note)));
    if (ghost) return el;
    return stop(this, t, rowId, el.id(rowId)
      .role("button").accessibility_label(`${project.label} coordinator`)
      .tooltip(space ? `${project.label}'s coordinator: starts and tracks its tasks` : `Start ${project.label}'s coordinator`)
      .when(!space?.active && !this.drag?.moved, (el) => el.hover((s) => s.bg(t.hover)).active((s) => s.bg(t.selected)))
      .on_click(open)
      .on_mouse_down("right", () => { if (space) this.menu(space); }), 8, { enter: open });
  }

  machineChip(t, w, isNaming, ghost, on = w.machine ?? null) {
    const name = on, state = this.machines.find((m) => m.name === name)?.state;
    const isAway = Boolean(name) && Boolean(state) && state !== "connected";
    const chip = h_flex().flex_none().gap(4).items_center().text_size(11).text_color(isAway ? t.blocked : t.dim)
      .child(svg(`mods/t3-spaces/icons/${name ? "server" : "monitor"}.svg`).size(12).flex_none())
      .when(Boolean(name) && isNaming, (el) => el.child(div().max_w(64).truncate().child(name)));
    const label = !name ? "On this computer" : isAway ? `On ${name}, ${state.replace(/_/g, " ")}` : `On ${name}`;
    return ghost ? chip : tipMark(this, t, `machine-of-${w.id}`, label, chip);
  }

  sandboxMark(t, w, ghost) {
    const mark = svg("mods/t3-spaces/icons/lock.svg").size(12).flex_none().text_color(t.ansi2 ?? t.dim);
    return ghost ? mark : tipMark(this, t, `sandbox-of-${w.id}`, "In a sandbox VM: offline, no secrets", mark);
  }

  grouped(t, showNumbers) {
    const rows = this.ordered(), ps = panes(), lifting = Boolean(this.drag?.moved);
    let nextSlot = 1;
    const takeSlot = () => nextSlot++;
    const draw = (r, ghost, slot) => r.head ? this.repoHead(r, t, ps, ghost) : this.row(r, t, ps, ghost, slot, showNumbers);
    const entry = (r) => {
      const slot = r.head ? null : takeSlot();
      const navTarget = r.head ? null : { kind: "space", id: r.w.id };
      return { key: r.head ? r.w.id : `space-${r.w.id}`, h: PITCH, group: groupOf(r), zone: zoneOf(r), r, navTarget, el: draw(r, false, slot), ghost: () => draw(r, true, slot) };
    };
    const plain = (key, group, draw) => ({ key, h: PITCH, group, el: draw(false), ghost: () => draw(true) });
    const { profile, projects } = shownProjects(), projectNames = Object.keys(projects);
    const offMachines = new Set(shared("context")?.offMachines ?? []);
    const remote = [...new Set([...rows.map(r => r.w.machine).filter(Boolean), ...this.machines.filter(m => !m.temporary && !(m.via === true && String(m.target).includes("sandbox-via.sh"))).map(m => m.name), ...Object.keys(this.reconnecting)])]
      .filter((m) => !offMachines.has(m)).sort();
    const loading = m => {
      const layout = machines().find(k => k.name === m)?.layout;
      return layout === "loading" || (!layout && this.machines.some(k => k.name === m && k.state === "connected"))
        || spaces().some(s => (s.machine ?? null) === m && !this.shown.has(s.id));
    };
    const loadingRow = m => plain(`machine-loading-${m ?? "local"}`, machineGroupOf(m), ghost => div().when(!ghost, el => el.id(`machine-loading-${m ?? "local"}`))
      .h(ROW).flex_none().px(10).flex().items_center().text_color(t.dim).child("Loading…"));
    if (!remote.length && !projectNames.length) return loading(null) && !rows.length ? [loadingRow(null)] : rows.map(entry);
    const projectGroups = projectNames.flatMap((name) => this.projectGroup(t, profile, name, projects[name], rows.filter((r) => r.p === name), entry, plain, takeSlot, showNumbers));
    const machineNames = [null, ...remote];
    return [...projectGroups, ...machineNames.flatMap((m) => {
      const mine = rows.filter((r) => !r.p && (r.w.machine ?? null) === m);
      const repair = this.reconnecting[m];
      const machine = this.machines.find(k => k.name === m) ?? repair?.machine;
      const connected = !m || machine?.state === "connected";
      const rebuilt = this.rebuilt(machine) || !!repair;
      const folded = this.folded.has(m);
      const id = m ?? "local";

      const head = hoverKept(this, "overMachine", `machine-${id}`, h_flex().id(`machine-${id}`).h(ROW).flex_none().mx(2).px(8).gap(8).items_center()
        .text_size(12).font_medium().text_color(t.dim)
        .role("button").accessibility_label(`${folded ? "Expand" : "Collapse"} ${m ?? "This computer"}`))
        .on_mouse_down("right", () => this.machineMenu(m))
        .on_click((_e, cx) => {
          folded ? this.folded.delete(m) : this.folded.add(m);
          localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
          cx.notify();
        })

        .child(svg(`mods/t3-spaces/icons/${m ? "server" : "monitor"}.svg`).size(14).ml(-1).flex_none())

        .child(h_flex().flex_1().min_w(0).gap(8).items_center()
          .child(div().min_w(0).truncate().child(m ?? "This computer"))
          .child(tipMark(this, t, `machine-state-${id}`, connected ? "Connected" : (machine?.state ?? "asleep").replace(/_/g, " ").replace(/^./, c => c.toUpperCase()), div().size(6).rounded_full().flex_none().bg(connected ? t.ansi2 : t.dim))))
        .when(!connected && !rebuilt, el => el.child(div().flex_none().child((machine?.state ?? "asleep").replace(/_/g, " "))))
        .when(rebuilt, el => el.child(h_flex().flex_none().gap(4).items_center()
          .child(div().max_w(140).truncate().child(repair?.error || "rebuilt ·"))
          .child(tip(this, t, `machine-connect-${m}`, `Connect ${m}`, stop(this, t, `machine-connect-${m}`, div().id(`machine-connect-${m}`).text_color(repair?.error ? t.blocked : t.muted)
            .hover(s => s.text_color(t.foreground)).on_hover(glow(this, `machine-connect-${m}`))
            .role("button").accessibility_label(`Connect ${m}`)
            .on_click((_e, cx) => { cx.stop_propagation(); this.reconnect(machine, cx); })
            .child(repair?.busy ? "Connecting…" : "Connect"), 4)))))
        .child(h_flex().flex_none().gap(2).items_center()
          .when(connected, el => el.child(tip(this, t, `machine-add-${id}`, "New space here", stop(this, t, `machine-add-${id}`, div().id(`machine-add-${id}`).size(24).flex_none().flex().items_center().justify_center().rounded(8)
            .text_color(this.hot === `machine-add-${id}` ? t.foreground : t.dim).on_hover(glow(this, `machine-add-${id}`))
            .role("button").accessibility_label("New space here")
            .on_click((_e, cx) => { cx.stop_propagation(); run("space.new", { machine: m ?? "" }); }).child(svg("mods/t3-spaces/icons/plus.svg").size(14)), 8),

            { action: (spaces().find(s => s.active)?.machine ?? null) === m ? "space.new" : null })))

          .child(div().id(`machine-fold-${id}`).flex_none()
            .text_color(this.overMachine === `machine-${id}` ? t.foreground : t.dim)
            .child(foldArrow("t3-spaces", `machine-fold-${id}`, !folded, 12, this.overMachine === `machine-${id}` ? t.foreground : t.dim))));
      const empty = plain(`machine-new-${id}`, machineGroupOf(m), ghost => {
        const el = h_flex().h(ROW).flex_none().px(10).gap(10).items_center().rounded(8)
          .text_color(this.hot === `machine-new-${id}` ? t.foreground : t.dim)

          .child(div().size(16).flex_none().flex().items_center().justify_center().child(svg("mods/t3-spaces/icons/plus.svg").size(12))).child("New space here");
        return ghost ? el : stop(this, t, `machine-new-${id}`, el.id(`machine-new-${id}`)
          .when(!lifting, el => el.hover(s => s.bg(t.hover)).active(s => s.bg(t.selected))).on_hover(glow(this, `machine-new-${id}`))
          .role("button").accessibility_label("New space here")
          .on_click(() => run("space.new", { machine: m ?? "" })), 8);
      });

      const heading = { key: `machine-${id}`, h: PITCH, group: machineGroupOf(m), el: stop(this, t, `machine-${id}`, head) };
      if (rebuilt) return [heading];

      if (!mine.length && connected && !loading(m) && rows.some((r) => r.p && (r.w.machine ?? null) === m)) return [];
      return [heading, ...(folded ? [] : mine.length ? mine.map(entry) : [loading(m) ? loadingRow(m) : empty])];
    })];
  }

  gitTail(g, tree, name, t, id, ghost) {
    const n = (count, what) => `${count} commit${count === 1 ? "" : "s"} to ${what}`;
    const mark = (mid, label, el) => ghost ? el : tipMark(this, t, mid, label, el);
    const where = this.gitWhere(g, tree, name);
    return h_flex()
      .flex_1()
      .min_w(0)
      .gap(6)
      .justify_end()
      .items_center()
      .text_size(12)
      .text_color(t.dim)
      .when(Boolean(where), (el) => el.child(div().min_w(0).truncate().child(where)))
      .when(g.ahead > 0, (el) => el.child(mark(`ahead-${id}`, n(g.ahead, "push"), div().text_color(t.ansi2).child(`\u2191${g.ahead}`))))
      .when(g.behind > 0, (el) => el.child(mark(`behind-${id}`, n(g.behind, "pull"), div().text_color(t.ansi1).child(`\u2193${g.behind}`))));
  }

  gitWhere(g, tree, name) {

    const raw = g.branch ?? (g.root ? "" : "detached");

    const same = (a) => a.toLowerCase() === name.toLowerCase() || (Boolean(g.root) && a.replace(/[^A-Za-z0-9._-]+/g, "-").toLowerCase() === name.toLowerCase());
    const branch = same(raw) || raw === "master" || raw === "main" ? "" : raw;
    const repo = tree || same(g.name) ? "" : g.name;
    return [repo, branch].filter(Boolean).join(" \u00b7 ");
  }

  foldButton(t, id, repo, hiding, ghost) {
    const folded = this.foldedRepos.has(repo), lit = this.hot === id ? t.foreground : t.dim;
    const label = folded ? "Expand worktrees" : "Collapse worktrees";
    const el = div().h(20).min_w(20).mr(-6).px(6).gap(4).flex_none().flex().items_center().justify_center().rounded(4)

      .text_size(11).text_color(lit)
      .when(folded && hiding > 0, el => el.child(String(hiding)))
      .child(foldArrow("t3-spaces", ghost ? null : id, !folded, 12, lit));
    return ghost ? el : tip(this, t, id, label, stop(this, t, id, el.id(id)
      .role("button").accessibility_label(label)
      .on_hover(glow(this, id))

      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); this.toggleRepo(repo, cx); }), 4));
  }

  openCheckout({ w, g }) {
    if (Date.now() - (this.opening.get(g.repo) ?? -Infinity) < OPENING) return;
    this.opening.set(g.repo, Date.now());
    run("space.new", { folder: w.folder, machine: w.machine ?? "" });
  }

  repoHead(r, t, ps, ghost) {
    const { w, g, p, isNaming, hiding = 0 } = r, rowId = w.id, foldId = `${rowId}-fold`;
    const el = h_flex().h(ROW).flex_none().px(10).gap(10).items_center().rounded(8)
      .child(div().flex_none().opacity(0.5).child(projectMark(w, 16, t, ps)))
      .child(div().flex_1().min_w(0).truncate().font_medium().text_color(t.dim).child(w.name))
      .when(Boolean(p), el => el.child(this.machineChip(t, w, isNaming, ghost, g?.host?.machine ?? (w.machine ?? null))))
      .child(this.foldButton(t, foldId, g.repo, hiding, ghost));
    return ghost ? el : stop(this, t, rowId, el.id(rowId)
      .when(!this.drag?.moved, el => el.hover(s => s.bg(t.hover)).active(s => s.bg(t.selected)))
      .role("button").accessibility_label(w.folder ? `Open ${w.name}` : `${this.foldedRepos.has(g.repo) ? "Expand" : "Collapse"} ${w.name}`)
      .on_click((_e, cx) => { if (w.folder) this.openCheckout(r); else this.toggleRepo(g.repo, cx); cx.notify(); }), 8);
  }

  row({ w, g, p, isNaming, tree, kids = 0, hiding = kids }, t, ps, ghost, slot, showNumbers) {
    const on = w.active;
    const showBadge = showNumbers && slot >= 1 && slot <= 9;

    const said = tree || p;

    const foldId = `space-fold-${w.id}`;
    const rowId = `space-${w.id}`;
    const where = g ? this.gitWhere(g, said, w.name) : "";
    const el = v_flex()
      .relative()
      .px(10)
      .h(ROW)
      .flex_none()
      .justify_center()
      .rounded(8)
      .when(on, (el) => el.bg(t.selected))

      .when(tree === "├─", el => el.child(div().absolute().left(17.25).top(0).bottom(-STACK).w(1.5).bg(t.input)))
      .when(Boolean(tree), el => el.child(div().absolute().left(17.25).top(-4).h(20).w(9.75).border_l(1.5).border_b(1.5).rounded_bl(6).border_color(t.input)))
      .child(
        h_flex()
          .w_full().min_w(0)
          .gap(10)
          .items_center()
          .when(Boolean(tree), el => el.pl(20).child(showBadge
            ? numberBadge(slot, t, on)
            : h_flex().size(16).flex_none().items_center().justify_center()
              .child(svg("mods/t3-spaces/icons/git-branch.svg").size(16).text_color(t.dim))))
          .when(!tree, el => el.child(showBadge ? numberBadge(slot, t, on) : projectMark(w, 16, t, ps)))

          .child(div().min_w(0).when(Boolean(where), el => el.max_w(150)).truncate().text_ellipsis_middle().font_medium().text_color(t.foreground + "e6").child(w.name))
          .when(Boolean(g?.host), el => el.child(this.sandboxMark(t, w, ghost)))
          .child(g ? this.gitTail(g, said, w.name, t, w.id, ghost) : div().flex_1())

          .when(Boolean(p) && !tree, el => el.child(this.machineChip(t, w, isNaming, ghost, g?.host?.machine ?? (w.machine ?? null))))
          .when(kids > 0, el => el.child(this.foldButton(t, foldId, g.repo, hiding, ghost))),
      );
    if (ghost) return el;
    return stop(this, t, rowId, el
      .id(rowId)
      .role("button")
      .accessibility_label(w.name)

      .when(w.name.length + where.length + (p && !tree ? 2 + (isNaming ? ((g?.host?.machine ?? w.machine) ?? "").length : 0) : 0) > 22, el => el.tooltip(where ? `${w.name} \u00b7 ${where}` : w.name))
      .when(!on && !this.drag?.moved, (el) => el.hover((s) => s.bg(t.hover)).active((s) => s.bg(t.selected)))

      .on_mouse_down("left", (e) => {
        this.drag = { id: w.id, key: rowId, at: e.position, top:  (this).motion?.at.get(rowId)?.y ?? 0, moved: false };
      })

      .on_mouse_up("left", (_e, cx) => {
        if (this.drag?.id !== w.id || this.drag.moved) return;
        this.drag = null;
        run("space.select", { id: w.id });
        cx.notify();
      })
      .on_mouse_down("right", () => this.menu(w)),

    8, { enter: () => run("space.select", { id: w.id }) });
  }

  dragTo(e, cx) {
    const d = this.drag;
    if (!d) return;
    pointerMoved(e.position);
    d.box = e.bounds;
    const dy = e.position.y - d.at.y;
    if (!d.moved && Math.hypot(e.position.x - d.at.x, dy) <= 6) return;

    if (!d.moved) {
      const watch = cx.timer.every(POINTER_WATCH, (cx) => {
        if (this.drag !== d) return watch.cancel();
        if (!dragGone(d.box)) return;
        watch.cancel();
        this.letGo(cx, true);
      });
    }
    d.moved = true;

    d.dy = dy;
    cx.notify();
  }

  lift(rows, key) {
    const at = rows.findIndex((e) => e.key === key);
    if (at < 0) return null;
    let end = at + 1;
    if (!rows[at].r.tree) while (rows[end]?.r?.tree) end++;
    return { at, block: rows.slice(at, end), rest: [...rows.slice(0, at), ...rows.slice(end)] };
  }

  slot({ at, block, rest }, y) {
    const lead = block[0], kid = Boolean(lead.r.tree);
    const under = rest[Math.min(rest.length - 1, Math.floor((y - ROW / 2) / PITCH))];
    if (under && (under.group !== lead.group || (under.r && under.zone !== lead.zone))) return at;
    let from = at, to = at;
    if (kid) { while (rest[from - 1]?.r?.tree) from--; while (rest[to]?.r?.tree) to++; }
    else { from = 0; to = rest.length; }
    const starts = (e) => e?.r && !e.r.tree && e.zone === lead.zone;
    let best = at;
    for (let j = from; j <= to; j++) {
      const ok = kid || starts(rest[j]) || (rest[j - 1]?.r && rest[j - 1].zone === lead.zone && rest[j]?.zone !== lead.zone);
      if (ok && Math.abs(j * PITCH - y) < Math.abs(best * PITCH - y)) best = j;
    }
    return best;
  }

  dest({ at, block, rest }, { id, slot }) {
    if (slot === at) return null;
    const kid = Boolean(block[0].r.tree), order = spaces().map((s) => s.id), from = order.indexOf(id);
    const unit = (r) => [...(r.head ? [] : [r.w.id]), ...(r.members ?? [])].map((x) => order.indexOf(x)).filter((i) => i >= 0);
    const next = rest[slot];
    if (next?.r && Boolean(next.r.tree) === kid && next.zone === block[0].zone) {
      const u = Math.min(...unit(next.r));
      return from < 0 || u === Infinity ? null : from > u ? u + 1 : u;
    }
    let k = slot - 1;
    while (!kid && rest[k]?.r?.tree) k--;
    const p = rest[k]?.r ? Math.max(...unit(rest[k].r)) : -Infinity;
    return from < 0 || p === -Infinity ? null : from < p ? p + 1 : p + 2;
  }

  letGo(cx, back) {
    const d = this.drag;
    this.drag = null;
    if (d?.drawn) {
      this.landed = { key: d.key, y: d.y };
      const l = this.lift(this.rows, d.key), index = back || !l ? null : this.dest(l,  (d));
      if (index) {
        run("space.move", { id: d.id, index });
        this.landing = { key: d.key, slot: d.slot, at: Date.now() };
        cx.timer.after(1000, (cx) => cx.notify());
      }
    }
    cx.notify();
  }

  render(cx) {
    const t = theme();
    const sp = spaces();

    if (this.drag?.moved) this.hot = this.overMachine = null;

    const colors = Object.fromEntries(sp.filter(p => p.name !== "~").map(p => [p.id, tint(p.name, false)]));
    if (JSON.stringify(colors) !== JSON.stringify(shared("space.colors") ?? {})) setShared("space.colors", colors);
    const showNumbers = this.isCtrlHeld && Boolean(window()?.active);
    const rows = this.rows = this.grouped(t, showNumbers);
    const navRows = { profile: shared("context")?.current ?? null, order: rows.filter((e) => e.navTarget).map((e) => e.navTarget) };
    if (JSON.stringify(navRows) !== JSON.stringify(shared("t3-spaces.rows") ?? null)) setShared("t3-spaces.rows", navRows);

    if (this.hot?.startsWith("machine-new-") && !rows.some((e) => e.key === this.hot)) this.hot = null;

    let d = this.drag, shown = rows, lifted = null;
    if (d && !rows.some((e) => e.key === d.key)) d = this.drag = null;
    if (d?.moved) {
      const l = this.lift(rows, d.key), h = l.block.length * PITCH;
      d.y = Math.max(0, Math.min(d.top + d.dy, l.rest.length * PITCH));

      d.slot = d.drawn ? this.slot(l, d.y) : l.at;
      shown = [...l.rest.slice(0, d.slot), { key: "space-gap", h, el: div().h(h - STACK), ghost: () => div().h(h - STACK) }, ...l.rest.slice(d.slot)];
      lifted = v_flex().id("space-lifted").absolute().left(0).right(0).top(d.y).gap(STACK).rounded(8).bg(t.selected).shadow_lg()
        .children(l.block.map((e) => e.ghost()));
    } else if (this.landing) {

      const l = this.lift(rows, this.landing.key), slot = this.landing.slot;
      if (!l || l.at === slot || Date.now() - this.landing.at >= 1000) this.landing = null;
      else shown = [...l.rest.slice(0, slot), ...l.block, ...l.rest.slice(slot)];
    }

    planMotion(this, shown, cx, { freeze: d?.moved && !d.drawn, from: this.landed });
    if (d?.moved) d.drawn = true;
    this.landed = null;
    const offMachines = new Set(shared("context")?.offMachines ?? []);
    const asks = props()?.newMenu && machines().filter((m) => !m.name || !offMachines.has(m.name)).length > 1;
    const tool = (id, label, icon, fn, more) => tip(this, t, id, label, stop(this, t, id, div().id(id).size(28).flex_none().flex().items_center().justify_center().rounded(8).text_color(this.hot === id ? t.foreground : t.dim).on_hover(glow(this, id)).on_mouse_down("left", () => pressed(this)).role("button").accessibility_label(label).hover(s => s.bg(t.hover))
      .on_click(fn).child(svg(`mods/t3-spaces/icons/${icon}.svg`).size(16)), 8), more);
    return focusRoot(this, v_flex().size_full().min_h(0).bg(t.chrome).text_size(14)
      .on_modifiers_changed((e, cx) => {
        const isHeld = Boolean(e.modifiers?.control);
        if (isHeld !== this.isCtrlHeld) {
          this.isCtrlHeld = isHeld;
          cx.notify();
        }
      })

      .child(h_flex().id("spaces-heading").h(48).flex_none().pl(18).pr(8).items_center().justify_between().text_size(12).font_medium().text_color(t.dim)
        .child(div().text_color(t.muted).child("Spaces"))

        .child(h_flex().flex_none().items_center()
          .child(tool("space-new", "New space", "folder-plus", (_e, cx) => {
            this.hot = null;

            const closing = justClosed(this, `${props()?.newMenu}.pickClosed`);
            if (!asks) run("space.new");
            else if (!closing) openOverlay({ mod: props().newMenu, kind: "popup", frame: "none", at:  ("top"), offset: 96, width: 576, height: 420, props: { pick: true } });
            cx.notify();
          }, { action: asks ? "t3-panels.new-space" : "space.new" }))
          .child(tool("space-new-tab", "New tab", "square-pen", (_e, cx) => { this.hot = null; const menu = props()?.newMenu ?? "new-menu"; if (!justClosed(this, `${menu}.closed`)) run("mod.open", { name: menu }); cx.notify(); }))))
      .child(v_flex().id("space-list").flex_1().min_h(0).overflow_y_scroll()
        .on_mouse_move((e, cx) => this.dragTo(e, cx))

        .on_mouse_up("left", (_e, cx) => this.letGo(cx))

        .on_hover((on, cx) => { if (!on && this.drag) this.letGo(cx, true); })
        .child(v_flex().id("space-content").w_full().flex_none().px(8).pb(8)

          .child(v_flex().id("space-rows").relative().gap(STACK)
            .children(leavingRows(this))
            .children(shown.map((e) => flying(this, e.key, e.el)))
            .when(Boolean(lifted), (el) => el.child(lifted))))));
  }
}
