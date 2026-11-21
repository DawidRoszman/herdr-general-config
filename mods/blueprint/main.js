import { View, div, svg, PathBuilder } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { theme, settings, agents, panes, spaces, focused, props as given, knownAgents, exec, hc, run, home, readTextFile, watchFolder, nextCommand, shared, setShared, window as host } from "herdr";
import { notifyAndLog } from "./notifylog.js";

const notify = (n) => notifyAndLog(n, "Blueprint");
import { parseFlowchart } from "./mermaid.js";
import { layoutSteps, at } from "./layout.js";
import { checkoutOf, remoteDirOf, makeRemoteDir, removeRemote, pullRemote, projectDir, hasDir, readMeta, updateMeta, isNews, load, pruneAll, KEEP_DAYS } from "./store.js";
import { addButton, removeButton } from "./setup.js";
import { newer, installedVersion, checkUpdate, setUpdateCheck, updatePrompt } from "./update.js";
import { text, pickLang, KEY_ALIASES, LANGS } from "./i18n.js";

const zoomOf = (s) => (Number(s?.zoom) > 0 ? Number(s.zoom) : 1);

const PATHS = { fill: () => PathBuilder.fill(), stroke: (width) => PathBuilder.stroke(width) };

const MOD = "blueprint";
const LANG_KEY = "blueprint.lang";
const HEADER_H = 44, TABS_H = 38, FOOTER_H = 40;
const COMPOSE_H = 136;
const TAB_MIN = 72, TAB_MAX = 200;
const TITLE = 12.5, SUB = 10.5, LABEL = 11;
const ZMIN = 0.2, ZMAX = 3, ZFIT_MAX = 1.4;

const FLOW_MS = 45;
const FLOW_SPOTS = 16;
const FLOW_GAP = 6;
const FLOW_REST = 360;
const RUNS = 8;
const FLOW_BUDGET = 40;

const SLICE_MS = 12;
const BUDGET_MS = [26, 16, 10];
const MEASURE_MAX = 160;
const APPS = { "claude-code": "Claude Code", codex: "Codex", pi: "Pi", gemini: "Gemini", opencode: "OpenCode", grok: "Grok", amp: "Amp" };

const AGENT_KEYS = ["claude", "codex", "gemini", "opencode", "pi", "grok", "amp", "cursor-agent", "aider", "goose", "qwen", "crush", "droid", "copilot"];

const alpha = (c, a) => c.slice(0, 7) + Math.round(a * 255).toString(16).padStart(2, "0");
const rgb = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
const distance = (a, b) => Math.hypot(...rgb(a).map((v, i) => v - rgb(b)[i]));
const clamp = (z) => Math.min(ZMAX, Math.max(ZMIN, z));
const wide = (ch) => ch.codePointAt(0) > 0x2e80;
const estimate = (s, px) => [...(s ?? "")].reduce((w, ch) => w + px * (wide(ch) ? 1 : 0.6), 0);

function palette(t) {
  const active = [t.working, t.accent, t.ansi5, t.ansi3].find((c) => c && distance(c, t.done) > 60) ?? t.working;
  return { active, done: t.done };
}

function nodeSize(n, m) {
  switch (n.shape) {
    case "diamond": return { w: Math.max(2 * m.w + 28, 110), h: Math.max(2 * m.h + 22, 70) };
    case "circle": { const d = Math.max(m.w, m.h) + 40; return { w: d, h: d }; }
    case "cylinder": return { w: Math.max(m.w + 44, 120), h: m.h + 42 };
    case "stadium": return { w: Math.max(m.w + 56, 120), h: Math.max(m.h + 26, 52) };
    default: return { w: Math.max(m.w + 40, 120), h: Math.max(m.h + 26, 52) };
  }
}

const minutesSince = (ts) => Math.floor((Date.now() - ts) / 60000);

const inProgress = (n) => n?.status === "active" || n?.status === "current";

export function tabCap(widths, room, lo, hi) {
  const ws = [...widths].sort((a, b) => a - b);
  let left = room;
  for (let i = 0; i < ws.length; i++) {
    const even = left / (ws.length - i);
    if (ws[i] > even) return Math.max(lo, Math.min(hi, Math.floor(even)));
    left -= ws[i];
  }
  return hi;
}

function statusMark(t, status) {
  if (status === "working") return svg("mods/blueprint/spinner.svg").size(12).flex_none().text_color(t.working).spin(900);
  if (status === "blocked") return div().size(14).flex_none().rounded(4).bg(alpha(t.blocked, 0.15)).text_size(10.5).font_bold()
    .text_color(t.blocked).flex().items_center().justify_center().child("!");
  if (status === "idle") return div().size(7).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim);
  return div().size(7).flex_none().rounded(4).bg(status === "done" ? t.done ?? t.dim : t.dim);
}

function fenced(text, lang) {
  const n = Math.max(3, ...(text.match(/`+/g) ?? []).map((r) => r.length + 1));
  return `${"`".repeat(n)}${lang}\n${text.replace(/\n+$/, "")}\n${"`".repeat(n)}`;
}

function inline(text) {
  text = text.trim();
  if (!text.includes("`")) return `\`${text}\``;
  const f = "`".repeat(Math.max(...text.match(/`+/g).map((r) => r.length)) + 1);
  return `${f} ${text} ${f}`;
}

function pointPrompt(G, n, note, path) {
  const label = [n.title, n.sub].filter(Boolean).join(" ");
  const where = n.line ? `, line ${n.line}: ${inline(n.lineText)}` : "";
  const stands = n.ref ? ` It stands for \`${n.ref}\`.` : "";
  const work = "Make this change in the code there and anything that depends on it, run the tests, then ";

  const save = `update the diagram in \`${path}\` (the Blueprint app shows that file; don't use herdr-blueprint send).`;
  const todo = n.ref ? `${work}${save}` : `Change it and anything it describes, then ${save}`;

  const live = "While you work, mark the boxes you are adding or changing `class <ids> active` (the one you are on `current`) in that file, and `done` once they work.";
  const text = `In Blueprint I pointed at the box "${label}" in the diagram you sent ('${G.g.title ?? G.tab}')${where}.${stands}\n${note}\n${todo} ${live}\n${fenced(G.src, "mermaid")}\n`;
  return clean(text);
}

const clean = (text) => text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
const LANG_NAMES = { en: "English", ko: "Korean", ja: "Japanese" };

function diagramRules(lang) {
  return `- Start the file with YAML frontmatter: \`title: ...\`. The title is the diagram's tab in Blueprint: keep it short, 2 to 4 words (e.g. "Login flow", "DB tables"), no parentheses. Write the labels in ${LANG_NAMES[lang] ?? "English"}; a box can carry a second line with \`<br/>\` (e.g. the class, route or columns).
- Blueprint draws Mermaid flowcharts only. For a database, draw one cylinder box per table (\`users[("users<br/>id · email")]\`) and label the edges with the relation (\`-->|1:N|\`).
- Draw only what the code has. If the project has no such thing (say, no database), tell me so in your reply and draw what plays that part instead, titled for what it really is (e.g. "Data files"), with plain boxes: a cylinder means a real database table.
- Every box is a piece of the code, not a step of your task. Tie each box to it: \`%% code: <node id> <path>:<line>\`.
- Mark progress: \`class <ids> done\` for finished parts, \`class <ids> active\` for work in progress, \`class <id> current\` for what you are on right now.
- After each unit of work, update that file in place (change only what changed). Skip it when the flow did not change. Diagrams nobody uses for ${KEEP_DAYS} days are deleted.`;
}

function drawPrompt(dir, lang) {
  return clean(`Blueprint (the Herdr app panel) is now connected to you for this project. Draw the code you are working on as a Mermaid flowchart and save it as a .mmd file in \`${dir}/\` (the folder exists; one file per diagram, a short kebab-case name such as \`auth-flow.mmd\`). Blueprint shows it as soon as it is saved.
- Also write the project's main topic, one short line in ${LANG_NAMES[lang] ?? "English"}, to \`${dir}/topic.txt\`: Blueprint's header shows it above the diagrams, whose titles name the part each one covers.
${diagramRules(lang)}
`);
}

function newPrompt(dir, request, lang, files) {
  const taken = files.length ? ` Don't overwrite ${files.map((f) => `\`${f}\``).join(", ")}.` : "";
  return clean(`In Blueprint I asked for a new diagram of this project: ${request}
Look at the code it is about, draw it as a Mermaid flowchart and save it as a new .mmd file in \`${dir}/\` (a short kebab-case name).${taken} Blueprint opens it as a new tab as soon as it is saved.
${diagramRules(lang)}
`);
}

const EMPTY = { nodes: new Map(), edges: [], title: null, dir: "LR" };

const HEADLESS_NAME = "Claude (headless)";
const HEADLESS_TOOLS = "Read,Glob,Grep,Write,Edit,Bash(git log:*),Bash(git diff:*),Bash(git show:*),Bash(git status)";
const fixedFolder = () => given()?.folder ?? null;
const ASK_WAIT = 10 * 60000;
const POLL_MS = 5000;

export default class Blueprint extends View {
  init(props, cx) {

    this.inPanel = !!(given()?.panel ?? props?.panel);

    if (!this.inPanel) this.ownTab = given()?.tab ?? null;
    this.tab = 0;
    this.graphs = [];
    this.views = {};
    this.dirs = {};
    this.measured = {};
    this.vers = {};
    this.whole = new Set();
    this.revs = 0;
    this.cache = new Map();
    this.prev = {};
    this.failed = new Set();
    this.job = null;
    this.lite = 0;
    this.paths = {};
    this.project = null;
    this.useLang("en");

    const follow = (cx) => cx.spawn(async (cx) => {
      try {
        const picked = shared(LANG_KEY);
        let lang = LANGS.includes(picked) ? picked : null;
        if (!lang) {
          const raw = await readTextFile(`${home()}/.claude/settings.json`);
          lang = pickLang(raw ? JSON.parse(raw).language : null);
        }
        if (lang !== this.lang) {
          this.useLang(lang);
          this.redraw(cx);
        }
      } catch (_) {}
    });
    this.followLang = follow;

    this.lookForUpdate = (cx) => cx.spawn(async (cx) => {
      try {
        this.version ??= await installedVersion();
        const { latest } = await checkUpdate();
        if (latest !== this.latest) {
          this.latest = latest;
          this.redraw(cx);
        }
      } catch (_) {}
    });
    this.lookForUpdate(cx);
    cx.timer.every(6 * 3600000, (cx) => this.lookForUpdate(cx));
    follow(cx);
    cx.timer.every(60000, (cx) => follow(cx));
    this.size = null;
    this.zoom = 1;
    this.width = 0;
    this.selected = null;
    this.hovered = null;
    this.drag = null;
    this.bounds = null;
    this.exporting = false;
    this.editing = false;
    this.compose = null;
    this.target = null;
    this.typing = false;
    this.sending = false;

    this.input = InputState.new();
    this.noteEmpty = true;
    this.input.on("change", (_e, cx) => { this.noteEmpty = !this.input.value(); cx.notify(); });
    this.input.on("submit", (_e, cx) => this.send(cx));
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.focus = cx.focus_handle();
    this.agentKeys = new Set(AGENT_KEYS);
    cx.spawn(async (cx) => {
      try {
        for (const a of await knownAgents()) this.agentKeys.add(a.key);
        cx.notify();
      } catch (_) {}
    });
    cx.timer.every(30000, (cx) => cx.notify());

    cx.timer.every(700, (cx) => {
      this.syncProject(cx);
      this.prepare(cx);
    });
    cx.timer.every(POLL_MS, (cx) => this.poll(cx));
    cx.spawn(async () => {
      try {
        await pruneAll();
      } catch (_) {}
    });
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        try {
          this.command(c, cx);
        } catch (_) {}
        this.redraw(cx);
      }
    });
  }

  useLang(lang) {
    this.lang = lang;
    this.T = text(lang);
  }

  syncProject(cx) {
    if (this.syncing) return;
    if (!this.ctxPending) return this.lookForFolder(cx);
    this.ctxPending = false;
    this.syncing = true;
    cx.spawn(async (cx) => {
      try {
        await this.openProject(this.ctxCwd, cx);
      } catch (_) {}
      this.syncing = false;
    });
  }

  lookForFolder(cx) {
    const p = this.project;
    if (!p || p.known || Date.now() - (p.looked ?? 0) < 3000) return;
    p.looked = Date.now();
    this.syncing = true;
    cx.spawn(async (cx) => {
      try {
        if (await hasDir(p.dir) && p === this.project) {
          p.known = true;
          p.meta = await readMeta(p.dir, p.path);
          await this.reload(cx);
          this.watch(cx, p);
        }
      } catch (_) {}
      this.syncing = false;
    });
  }

  async openProject(cwd, cx) {

    const seq = (this.opens = (this.opens ?? 0) + 1), tab = this.ctxTab;
    const stale = () => seq !== this.opens || tab !== this.ctxTab;
    const machine = this.ctxMachine ?? null;
    const root = cwd ? await checkoutOf(cwd, machine) : null;

    const path = root && machine ? `${machine}:${root}` : root;
    if (stale()) return;
    if (path === (this.project?.path ?? null)) {
      this.loading = false;
      return this.redraw(cx);
    }
    this.watchGen = (this.watchGen ?? 0) + 1;
    if (!path) {
      this.project = null;
      this.setDiagrams([]);
      this.loading = false;
      return this.redraw(cx);
    }

    const dir = projectDir(path);
    const remote = machine ? await remoteDirOf(machine, dir) : null;
    const known = await hasDir(dir);
    let meta = await readMeta(dir, path);
    if (known) meta = await updateMeta(dir, path, (m) => (m.opened = Date.now()));
    if (stale()) return;
    this.forget();
    this.project = { path, dir, meta, known, machine, remote, name: path.split("/").filter(Boolean).pop() ?? path };
    await this.reload(cx);
    this.loading = false;
    this.redraw(cx);
    if (known) this.watch(cx, this.project);
    const p = this.project;
    if (given()?.draw && !this.graphs.length && !this.targetList?.length && Date.now() - (p.meta.asked ?? 0) > ASK_WAIT) this.startDrawing(p, cx);
  }

  startDrawing(p, cx) {
    cx.spawn(async (cx) => {
      try {
        const at = Date.now();
        await this.saveMeta(p, (m) => Object.assign(m, { agent: null, asked: at, opened: at }));
        if (p.remote) await makeRemoteDir(p.machine, p.remote);
        this.watch(cx, p);
        const r = await this.runHeadless(p, drawPrompt(p.remote ?? p.dir, this.lang));
        if (r.code !== 0) throw new Error((r.stderr || r.stdout || `hc run ${r.code}`).trim());
      } catch (err) {
        await this.saveMeta(p, (m) => (m.asked = 0)).catch(() => {});
        notify({ title: this.T.sendFailed, body: String(err?.message ?? err), level: "error" });
      }
      this.redraw(cx);
    });
  }

  async runHeadless(p, prompt) {
    const { folder, about } = given();
    const name = `bp-draw-${Date.now() % 1000000}`;
    const r = await hc(["run", "--bg", "--json", "--no-parent", "--name", name, ...(p.machine ? ["--on", p.machine] : []), "--cwd", folder,
      "--", "claude", "-p", about ? `${prompt}\n\nContext: ${about}` : prompt, "--allowedTools", HEADLESS_TOOLS, "--add-dir", p.remote ?? p.dir]);
    if (r.code === 0) this.headless = { address: JSON.parse(r.stdout).address, at: Date.now() };
    return r;
  }

  checkHeadless(cx) {
    const h = this.headless;
    if (!h || this.checkingHeadless) return;
    this.checkingHeadless = true;
    cx.spawn(async (cx) => {
      try {
        const listed = await hc(["ls", "--json", "--all"]);
        if (listed.code !== 0) throw new Error((listed.stderr || "hc ls failed").trim());
        const term = JSON.parse(listed.stdout).terminals.find((t) => t.address === h.address);
        if (!term || term.state === "finished") {
          this.headless = null;
          if (term && term.exit_code !== 0) {
            const out = (await hc(["read", h.address, "--lines", "12"])).stdout.trim().split("\n").slice(-4).join("\n");
            notify({ title: `${HEADLESS_NAME} stopped (exit ${term.exit_code})`, body: out, level: "error" });
          }
          if (term) await hc(["rm", h.address]);
          this.redraw(cx);
        }
      } catch (err) {
        notify({ title: `Blueprint lost track of ${HEADLESS_NAME}`, body: String(err?.message ?? err), level: "warning" });
        this.headless = null;
      } finally {
        this.checkingHeadless = false;
      }
    });
  }

  forget() {
    this.graphs = [];
    this.views = {};
    this.dirs = {};
    this.measured = {};
    this.vers = {};
    this.whole.clear();
    this.cache.clear();
    this.prev = {};
    this.failed.clear();
    this.job = null;
    this.paths = {};
  }

  refresh(cx) {
    const views = { ...this.views }, dirs = this.dirs, graphs = this.graphs.map((d) => ({ ...d, src: null }));
    const p = this.project, tab = this.ctxTab;
    this.forget();
    Object.assign(this, { graphs, views: { ...views }, dirs, measuredFont: null, lite: 0, ctxPending: true });
    cx.spawn(async (cx) => {
      try {
        await this.reload(cx);
      } catch (_) {}

      if (this.project === p && this.ctxTab === tab) Object.assign(this.views, views);
      if (this.project?.known) this.watch(cx, this.project);
      this.redraw(cx);
    });
  }

  async saveMeta(p, change) {
    change(p.meta);
    const merged = await updateMeta(p.dir, p.path, change);
    p.known = true;
    if (p === this.project) p.meta = merged;
    return merged;
  }

  watch(cx, p) {
    if (!p || p !== this.project) return;
    const gen = this.watchGen, key = `${gen}:${p.dir}`;
    if (this.watching === key) return;
    this.watching = key;
    cx.spawn(async (cx) => {
      try {
        for (;;) {
          const changed = await watchFolder(p.dir);
          if (gen !== this.watchGen) {

            if (this.project?.dir === p.dir) await this.reload(cx);
            return;
          }
          if (changed.some((f) => isNews(f, p.dir))) await this.reload(cx);
          else await this.rereadMeta(p, cx);
        }
      } catch (_) {
      } finally {
        if (this.watching === key) this.watching = null;
      }
    });
  }

  poll(cx) {
    this.checkHeadless(cx);
    const p = this.project;
    if (!p?.known || this.syncing || this.polling) return;
    this.watch(cx, p);
    this.polling = true;
    cx.spawn(async (cx) => {
      try {
        await this.reload(cx, true);
      } catch (_) {}
      this.polling = false;
    });
  }

  async rereadMeta(p, cx) {
    const meta = await readMeta(p.dir, p.path);
    if (p !== this.project) return;
    p.meta = meta;
    for (const d of this.graphs) d.pinned = meta.pinned.includes(d.key);
    this.redraw(cx);
  }

  async reload(cx, quiet = false) {
    const p = this.project;
    if (!p) return;
    if (p.remote) await this.pull(p);
    const items = await load(p.dir, p.meta, Date.now(), p.remote && ((file) => removeRemote(p.machine, p.remote, file)));

    const topic = (await readTextFile(`${p.dir}/topic.txt`))?.split("\n")[0].trim() || null;
    if (p !== this.project) return;
    if (quiet && topic === p.topic && items.length === this.graphs.length && items.every((f) => this.graphs.some((d) => d.key === f.file && d.src === f.src))) return;
    p.topic = topic;
    this.setDiagrams(items);
    this.markSeen(cx);
    this.redraw(cx);
  }

  async pull(p) {
    try {
      await pullRemote(p.machine, p.remote, p.dir);
      p.pullError = null;
    } catch (err) {
      const message = String(err?.message ?? err);
      if (message !== p.pullError) notify({ title: `Blueprint could not read ${p.remote}`, body: message, level: "error" });
      p.pullError = message;
    }
  }

  setDiagrams(items) {
    const before = new Map(this.graphs.map((d) => [d.key, d]));
    const shown = this.graphs[this.tab]?.key;
    this.graphs = [...items].sort((a, b) => a.file.localeCompare(b.file)).map((f) => {
      const old = before.get(f.file);
      const rev = old && old.src === f.src ? old.rev : ++this.revs;
      if (old && rev !== old.rev) delete this.views[f.file];
      const g = old && rev === old.rev ? old.g : parseFlowchart(f.src);
      return { key: f.file, rev, src: f.src, g, tab: g.title ?? f.file.replace(/\.mmd$/, ""), loaded: f.mtime, pinned: f.pinned };
    });
    const newest = items[0]?.file;
    const i = this.graphs.findIndex((d) => d.key === shown);
    this.tab = i >= 0 ? i : Math.max(0, this.graphs.findIndex((d) => d.key === newest));

    const ask = this.asking();
    const arrived = ask ? this.graphs.findIndex((d) => !ask.known.has(d.key)) : -1;
    if (arrived >= 0) {
      this.tab = arrived;
      this.expectNew = null;
    } else if (before.size && !this.selected && !this.compose) {

      const added = items.find((f) => !before.has(f.file));
      if (added) this.tab = this.graphs.findIndex((d) => d.key === added.file);
    }

    if (this.graphs[this.tab]?.key !== shown) {
      this.selected = null;
      if (this.compose?.id) this.compose = null;
    }
    if (this.selected && !this.graph.nodes.has(this.selected)) this.selected = null;
    if (this.compose?.id && !this.graph.nodes.has(this.compose.id)) this.compose = null;
  }

  asking() {
    const ask = this.expectNew;
    if (ask && Date.now() - ask.since > ASK_WAIT) this.expectNew = null;
    return this.expectNew && this.expectNew.dir === this.project?.dir ? this.expectNew : null;
  }

  markSeen(cx) {
    const p = this.project, d = this.graphs[this.tab];

    if (!p || !p.known || !d || Date.now() - (p.meta.seen[d.key] ?? 0) < 60000) return;
    const at = Date.now(), file = d.key;
    cx.spawn(async () => {
      try {
        await this.saveMeta(p, (m) => (m.seen = { ...m.seen, [file]: at }));
      } catch (_) {}
    });
  }

  togglePin(cx) {
    const p = this.project, d = this.graphs[this.tab];
    if (!p || !d) return;
    const on = !d.pinned, file = d.key;
    d.pinned = on;
    cx.spawn(async () => {
      try {
        await this.saveMeta(p, (m) => (m.pinned = on ? [...new Set([...m.pinned, file])] : m.pinned.filter((f) => f !== file)));
      } catch (_) {}
    });
  }

  connect(target, cx) {
    const p = this.project;
    if (!p || !target) return;
    const at = Date.now();
    this.target = null;
    cx.spawn(async (cx) => {
      try {

        await this.saveMeta(p, (m) => Object.assign(m, { agent: target.address, asked: at, opened: at }));
        if (p.remote) await makeRemoteDir(p.machine, p.remote);
        this.watch(cx, p);
        const r = await hc(["send", target.address, drawPrompt(p.remote ?? p.dir, this.lang)]);
        if (r.code !== 0) throw new Error((r.stderr || r.stdout || `hc send ${r.code}`).trim());
        notify({ title: this.T.asked(target.name), body: p.path, level: "success", timeout: 4000 });
      } catch (err) {

        await this.saveMeta(p, (m) => (m.asked = 0)).catch(() => {});
        notify({ title: this.T.sendFailed, body: String(err?.message ?? err), level: "error" });
      }
      this.redraw(cx);
    });
  }

  pending(list) {
    const p = this.project;
    const agent = list.find((x) => x.address === p?.meta.agent);
    if (!agent || !p.meta.asked) return null;
    const recent = Date.now() - p.meta.asked < ASK_WAIT;
    return agent.status === "working" || recent ? agent : null;
  }

  openPane() {
    const tab = this.servedTab(panes());
    const there = panes().find((p) => p.mod === MOD && p.tab === tab);
    if (there) run("pane.focus", { pane: there.pane });
    else run("pane.split", { direction: "right", pane: this.ctxPane ?? focused()?.pane ?? undefined, mod: MOD, props: { tab } });
    if (this.inPanel) run("layout.hide", { id: "panel" });
  }

  redraw(cx) {
    this.prepare(cx);
    cx.notify();
    this.heal(cx);
  }

  heal(cx) {
    this.wanted = (this.wanted ?? 0) + 1;
    if (this.healing) return;
    this.healing = true;
    const check = (cx, tries) => {
      if (this.rendered >= this.wanted || tries > 4) {
        this.healing = false;
        return;
      }
      cx.notify();
      cx.timer.after(250 * (tries + 1), (cx) => check(cx, tries + 1));
    };
    cx.timer.after(250, (cx) => check(cx, 0));
  }

  get graph() {
    return this.graphs[this.tab]?.g ?? EMPTY;
  }

  mkey(i) {
    const d = this.graphs[i];
    return `${d.key}@${d.rev}`;
  }

  get vkey() {
    return this.graphs[this.tab]?.key ?? "";
  }

  labelBox(mk, n) {
    return this.measured[`n:${mk}:${n.id}`] ?? {
      w: Math.max(estimate(n.title, TITLE), estimate(n.sub, SUB)),
      h: TITLE * 1.3 + (n.sub ? SUB * 1.3 + 2 : 0),
    };
  }

  edgeLabelBox(mk, g, e) {
    g.edgeIndex ??= new Map(g.edges.map((x, k) => [x, k]));
    return this.measured[`e:${mk}:${g.edgeIndex.get(e)}`] ?? { w: estimate(e.label, LABEL) + 10, h: LABEL * 1.4 + 4 };
  }

  missing(i) {
    const mk = this.mkey(i), g = this.graphs[i].g;
    if (this.whole.has(mk)) return false;
    const some = [...g.nodes.keys()].some((id) => !this.measured[`n:${mk}:${id}`])
      || g.edges.some((e, k) => e.label && !this.measured[`e:${mk}:${k}`]);
    if (!some) this.whole.add(mk);
    return some;
  }

  lkey(i, dir) {
    const mk = this.mkey(i);
    return `${mk}:${dir}:${this.vers[mk] ?? 0}`;
  }

  laid(i, dir) {
    return this.cache.get(this.lkey(i, dir)) ?? null;
  }

  nextLayout() {
    const order = [this.tab, ...this.graphs.keys()].filter((i, k, a) => a.indexOf(i) === k && this.graphs[i]);
    for (const i of order) {
      if (i !== this.tab && (this.cache.size >= 16 || this.missing(i))) continue;
      const pref = this.graphs[i].g.dir;
      for (const dir of [pref, pref === "LR" ? "TB" : "LR"]) {
        const key = this.lkey(i, dir);
        if (!this.cache.has(key) && !this.failed.has(key)) return { i, dir, key };
      }
    }
    return null;
  }

  prepare(cx) {
    if (this.job || !this.graphs[this.tab]) return;
    const next = this.nextLayout();
    if (!next) return;
    const { i, dir, key } = next, d = this.graphs[i];
    if (i === this.tab && this.prev[d.key] && this.missing(i)) {
      this.waiting ??= Date.now();
      if (Date.now() - this.waiting < 1500) {
        if (!this.waitCheck) {
          this.waitCheck = true;
          cx.timer.after(1600, (cx) => {
            this.waitCheck = false;
            this.redraw(cx);
          });
        }
        return;
      }
    }
    this.waiting = null;
    const mk = this.mkey(i), g = d.g;
    const job = { key, mk, g, shown: i === this.tab, since: Date.now(), steps: layoutSteps(g, dir, (n) => nodeSize(n, this.labelBox(mk, n)), (e) => this.edgeLabelBox(mk, g, e)) };
    this.job = job;
    cx.timer.after(1, (cx) => this.pump(cx, job));
  }

  pump(cx, job) {
    if (this.job !== job) return;
    if (job.g !== this.graph && this.nextLayout()?.i === this.tab) {

      this.job = null;
      return this.redraw(cx);
    }
    const t0 = Date.now();
    try {
      for (;;) {
        const r = job.steps.next();
        if (r.done) {
          const L = Object.assign(r.value, { g: job.g, key: job.key, mk: job.mk });

          this.reach(L);
          this.scope(L);
          if (this.cache.size > 24) this.cache.clear();
          this.cache.set(job.key, L);
          break;
        }
        if (Date.now() - t0 >= SLICE_MS) {

          if (job.shown && !job.noted && Date.now() - job.since > 150) {
            job.noted = true;
            cx.notify();
          }
          return void cx.timer.after(1, (cx) => this.pump(cx, job));
        }
      }
    } catch (_) {
      this.failed.add(job.key);
    }
    this.job = null;
    this.redraw(cx);
  }

  fitView(L) {
    const { width: W, height: H } = this.size, pad = 40;
    const b = L.bounds, gw = b.maxX - b.minX, gh = b.maxY - b.minY;
    const z = clamp(Math.min(ZFIT_MAX, (W - 2 * pad) / gw, (H - 2 * pad) / gh));
    return { z, x: (W - gw * z) / 2 - b.minX * z, y: (H - gh * z) / 2 - b.minY * z };
  }

  current() {
    const i = this.tab, d = this.graphs[i];
    if (!d) return null;
    const pref = d.g.dir, other = pref === "LR" ? "TB" : "LR";
    const a = this.laid(i, pref), b = this.laid(i, other);
    const made = (L, dir) => L || this.failed.has(this.lkey(i, dir));
    let L = a ?? b, dir = a ? pref : other;
    if (a && b && this.size && this.fitView(b).z > this.fitView(a).z * 1.2) [L, dir] = [b, other];
    if (!L || (this.prev[d.key] && !(made(a, pref) && made(b, other)))) {
      if (!this.prev[d.key]) return null;
      ({ L, dir } = this.prev[d.key]);
    } else {
      if (this.dirs[d.key] !== dir) {
        this.dirs[d.key] = dir;
        delete this.views[d.key];
      }
      this.prev[d.key] = { L, dir };
    }
    return { L, dir, v: this.views[d.key] ?? this.fitView(L) };
  }

  flow(L, id) {
    L.flows ??= new Map();
    if (L.flows.has(id)) return L.flows.get(id);
    const g = L.g ?? this.graph, from = new Map(), to = new Map();
    for (const e of g.edges) {
      if (!from.has(e.from)) from.set(e.from, []);
      if (!to.has(e.to)) to.set(e.to, []);
      from.get(e.from).push(e);
      to.get(e.to).push(e);
    }
    const nodes = new Set([id]), edges = new Set();
    for (const fwd of [true, false]) {
      const queue = [id], seen = new Set([id]);
      while (queue.length) {
        const v = queue.shift();
        for (const e of (fwd ? from : to).get(v) ?? []) {
          const b = fwd ? e.to : e.from;
          edges.add(e);
          nodes.add(b);
          if (!seen.has(b)) seen.add(b), queue.push(b);
        }
      }
    }
    L.flows.set(id, { nodes, edges });
    return L.flows.get(id);
  }

  scope(L) {
    return (L.work ??= this.findWork(L, L.g ?? this.graph));
  }

  findWork(L, g) {
    const fwd = L.edges.filter((ed) => !ed.back);
    const busy = (id) => inProgress(g.nodes.get(id));
    const inner = fwd.filter((ed) => busy(ed.e.from) && busy(ed.e.to));
    const entries = [];
    for (const n of g.nodes.values()) {
      if (!inProgress(n) || inner.some((ed) => ed.e.to === n.id)) continue;
      const ins = fwd.filter((ed) => ed.e.to === n.id);
      const lead = ins.find((ed) => g.nodes.get(ed.e.from)?.status === "done") ?? ins[0];
      entries.push({ id: n.id, lead });
    }
    const yellow = new Set([...inner, ...entries.map((x) => x.lead).filter(Boolean)].map((ed) => ed.e));
    const runs = [];

    const walk = (path, id, seen) => {
      if (runs.length >= RUNS) return;
      const next = inner.filter((ed) => ed.e.from === id && !seen.has(ed.e.to));
      if (!next.length) return path.length && runs.push(path);
      for (const ed of next) walk([...path, ed], ed.e.to, new Set([...seen, ed.e.to]));
    };
    for (const { id, lead } of entries) walk(lead ? [lead] : [], id, new Set([id]));
    return { yellow, runs };
  }

  servedTab(all) {
    if (!this.inPanel) return this.ownTab ?? null;
    return this.shownTab();
  }

  shownTab() {
    return spaces().find((sp) => sp.active)?.tabs?.find((t) => t.active)?.id ?? focused()?.tab ?? null;
  }

  laidOut() {
    if (this.inPanel || given()?.tab) return;
    const shown = this.shownTab();
    if (panes().some((p) => p.mod === MOD && p.tab === shown)) this.ownTab = shown;
  }

  ownPane(cx) {
    if (this.inPanel) return;
    cx.timer.after(120, (cx) => {
      const me = panes().find((p) => p.mod === MOD && p.focused);
      if (me && me.tab !== this.ownTab) {
        this.ownTab = me.tab;
        this.redraw(cx);
      }
    });
  }

  targets(all = panes(), tab = this.servedTab(all)) {
    const list = agents().filter((a) => !tab || a.tab === tab).sort((a, b) => b.seq - a.seq)
      .map((a) => ({ address: a.address, name: APPS[a.app] ?? a.program?.name ?? a.app ?? a.address, status: a.status }));
    for (const p of all) {
      const agent = p.program && (p.program.agent || this.agentKeys.has(p.program.key));
      if (p.terminal && (!tab || p.tab === tab) && agent && !list.some((x) => x.address === p.terminal)) {
        list.push({ address: p.terminal, name: p.program.name, status: p.status });
      }
    }
    return list;
  }

  pickTarget(list) {

    return list.find((x) => x.address === this.target)
      ?? list.find((x) => x.address === this.project?.meta.agent) ?? list[0] ?? null;
  }

  command(c, cx) {
    if (c === "fit") this.views[this.vkey] = null;
    else if (c === "zoom-in") this.zoomCenter(1.25);
    else if (c === "zoom-out") this.zoomCenter(0.8);
    else if (c === "zoom-100") this.size && this.current() && this.zoomCenter(1 / this.current().v.z);
    else if (c === "clear") this.selected = null;
    else if (c === "export") this.exportPng(cx);
    else if (c === "add-button" || c === "remove-button") this.setup(c, cx);
    else if (c === "update") this.askUpdate(cx);
    else if (c === "update-check-off") {
      setUpdateCheck(false);
      this.latest = null;
    } else if (c === "update-check-on") {
      setUpdateCheck(true);
      this.lookForUpdate(cx);
    }
    else if (/^tab-\d$/.test(c)) this.setTab(Number(c.slice(4)) - 1, cx);
    else if (c.startsWith("select-")) this.selected = c.slice(7);
    else if (c === "edit") this.editKey();
    else if (c.startsWith("compose-")) this.openCompose(c.slice(8));
    else if (c.startsWith("note-")) {
      this.input.set_value(c.slice(5).replaceAll("_", " "));
      this.noteEmpty = !this.input.value();
    }
    else if (c === "send") this.send(cx);
    else if (c === "cancel") this.closeCompose();
    else if (c.startsWith("target-")) this.target = c.slice(7) || null;
    else if (c.startsWith("connect-")) this.connect(this.targets().find((x) => x.address === c.slice(8)) ?? { address: c.slice(8), name: c.slice(8) }, cx);
    else if (c === "pin") this.togglePin(cx);
    else if (c === "new") this.openCreate();
    else if (c === "pane") this.openPane();
    else if (c === "refresh" || c === "reload") this.refresh(cx);
    else if (c === "lang-auto") {
      setShared(LANG_KEY, null);
      this.followLang?.(cx);
    } else if (/^lang-(en|ko|ja)$/.test(c)) {
      setShared(LANG_KEY, c.slice(5));
      this.useLang(c.slice(5));
    }
  }

  askUpdate(cx) {
    if (!this.latest) return;
    const target = this.pickTarget(this.targetList ?? []);
    if (!target) {
      notify({ title: this.T.updateTitle(this.latest), body: this.T.updateNoAgent, level: "info", timeout: 8000 });
      return;
    }
    const text = updatePrompt(this.latest, this.version);
    cx.spawn(async () => {
      try {
        const r = await hc(["send", target.address, text]);
        if (r.code !== 0) throw new Error((r.stderr || r.stdout || `hc send ${r.code}`).trim());
        notify({ title: this.T.updateAsked(target.name), body: `${this.version ?? "?"} → ${this.latest}`, level: "success", timeout: 5000 });
      } catch (err) {
        notify({ title: this.T.sendFailed, body: String(err?.message ?? err), level: "error" });
      }
    });
  }

  setup(c, cx) {
    cx.spawn(async (cx) => {
      const wait = (ms) => new Promise((done) => cx.timer.after(ms, () => done()));
      try {
        const said = await (c === "add-button" ? addButton : removeButton)(wait);
        notify({ title: "Blueprint", body: said, level: "success", timeout: 6000 });
      } catch (err) {
        notify({ title: "Blueprint", body: String(err?.message ?? err), level: "error" });
      }
    });
  }

  setEditing(on) {
    this.editing = on;
    if (!on) this.closeCompose();
  }

  editKey() {
    if (!this.compose && this.selected && this.graph.nodes.has(this.selected)) this.openCompose(this.selected);
    else this.setEditing(!this.editing);
  }

  openCompose(id) {
    if (!this.graph.nodes.has(id)) return;
    this.editing = true;
    this.selected = id;
    if (this.compose?.id !== id) {
      this.input.set_value("");
      this.noteEmpty = true;
    }
    this.compose = { id };
    this.input.focus();
    this.keepAbove(id);
  }

  keepAbove(id) {
    const cur = this.size && this.current();
    if (!cur) return;
    const { L, v } = cur;
    const item = L.nodes.find((x) => x.node.id === id);
    if (!item) return;
    const bottom = (item.y + item.h / 2) * v.z + v.y, limit = this.size.height - COMPOSE_H - 16;
    if (bottom > limit) this.views[this.vkey] = { ...v, y: v.y - (bottom - limit) };
  }

  openCreate() {
    if (!this.project) return;
    this.editing = false;
    this.selected = null;
    if (this.compose?.kind !== "new") {
      this.input.set_value("");
      this.noteEmpty = true;
    }
    this.compose = { kind: "new" };
    this.input.focus();
  }

  closeCompose() {
    this.compose = null;
    this.focus.focus();
  }

  send(cx) {
    if (this.sending || !this.compose) return;
    const note = this.input.value().trim();
    const fresh = this.compose.kind === "new";
    const n = fresh ? null : this.graph.nodes.get(this.compose.id);
    if (!note || (!fresh && !n) || !this.project) return;
    const target = this.pickTarget(this.targets());
    const isHeadless = !target && !!fixedFolder();
    if (!target && !isHeadless) {
      notify({ title: this.T.noTarget, body: this.T.noAgentBody, level: "warning", timeout: 4000 });
      return;
    }
    const p = this.project;
    const agentDir = p.remote ?? p.dir;
    const text = fresh
      ? newPrompt(agentDir, note, this.lang, this.graphs.map((d) => d.key))
      : pointPrompt(this.graphs[this.tab], n, note, `${agentDir}/${this.vkey}`);
    this.sending = true;
    this.redraw(cx);
    cx.spawn(async (cx) => {
      try {
        if (fresh) {

          const at = Date.now();
          await this.saveMeta(p, (m) => Object.assign(m, { opened: at, asked: at }));
          if (p.remote) await makeRemoteDir(p.machine, p.remote);
          this.watch(cx, p);
        }
        const r = isHeadless ? await this.runHeadless(p, text) : await hc(["send", target.address, text]);
        if (r.code !== 0) throw new Error((r.stderr || r.stdout || `hc send ${r.code}`).trim());
        notify({ title: this.T.sent(target?.name ?? HEADLESS_NAME), body: fresh ? note : `${n.title}: ${note}`, level: "success", timeout: 4000 });

        if (fresh) this.expectNew = { dir: p.dir, known: new Set(this.graphs.map((d) => d.key)), since: Date.now(), label: note };

        this.selected = null;
        this.input.set_value("");
        this.noteEmpty = true;
        this.compose = null;
        this.editing = false;
        this.focus.focus();
      } catch (err) {
        notify({ title: this.T.sendFailed, body: String(err?.message ?? err), level: "error" });
      }
      this.sending = false;
      this.redraw(cx);
    });
  }

  setTab(i, cx) {
    if (i < 0 || i >= this.graphs.length) return;
    this.tab = i;
    this.selected = null;
    this.compose = null;
    if (cx) this.markSeen(cx);
  }

  zoomAt(f, px, py) {
    const cur = this.size && this.current();
    if (!cur) return;
    const { v } = cur;
    const z = clamp(v.z * f), k = z / v.z;
    this.views[this.vkey] = { z, x: px - (px - v.x) * k, y: py - (py - v.y) * k };
  }

  zoomCenter(f) {
    if (this.size) this.zoomAt(f, this.size.width / 2, this.size.height / 2);
  }

  clickNode(n) {
    if (this.editing) this.openCompose(n.id);
    else this.selected = this.selected === n.id ? null : n.id;
  }

  exportPng(cx) {
    if (this.exporting || !this.size || !this.graphs.length || !canExport()) return;
    if (!this.bounds) {
      return notify({ title: "PNG", body: this.T.pngHover, level: "info", timeout: 4000 });
    }
    const saved = { view: this.views[this.vkey], selected: this.selected, hovered: this.hovered };
    Object.assign(this, { exporting: true, selected: null, hovered: null });
    this.views[this.vkey] = null;
    this.redraw(cx);
    const done = (cx) => {
      this.exporting = false;
      this.selected = saved.selected;
      this.views[this.vkey] = saved.view;
      this.redraw(cx);
    };
    cx.timer.after(250, (cx) => cx.spawn(async (cx) => {
      try {
        const dir = `${home()}/Downloads`, tmp = `${dir}/.blueprint-shot.png`;
        const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
        const out = `${dir}/blueprint-${stamp}.png`;
        await shot(tmp);
        const pw = Number((await exec("sips", ["-g", "pixelWidth", tmp])).stdout.match(/pixelWidth:\s*(\d+)/)?.[1]);
        const s = pw / window.viewport_size().width;

        const Z = this.zoom, b = this.bounds, top = b.y + (HEADER_H + (this.rowH ?? TABS_H)) * Z;
        const raw = this.rawSize ?? { width: this.size.width * Z, height: this.size.height * Z };
        const crop = [raw.height, raw.width, top, b.x].map((v) => String(Math.round(v * s)));
        const r = await exec("sips", ["-c", crop[0], crop[1], "--cropOffset", crop[2], crop[3], tmp, "--out", out]);
        await exec("rm", ["-f", tmp]);
        if (r.code !== 0) throw new Error(r.stderr || r.stdout);
        await exec("osascript", ["-e", `set the clipboard to (read (POSIX file "${out}") as «class PNGf»)`]);
        notify({ title: this.T.pngSaved, body: out, level: "success", timeout: 5000 });
      } catch (err) {
        notify({ title: this.T.pngFailed, body: String(err?.message ?? err), level: "error" });
      }
      done(cx);
    }));
  }

  render(cx) {
    const now = Date.now();
    if (this.inRender) {
      this.lite = Math.min(BUDGET_MS.length - 1, this.lite + 1);
      this.liteAt = now;
    } else if (this.lite && now - this.liteAt > 20000) this.lite = 0;
    this.inRender = true;
    this.deadline = now + BUDGET_MS[this.lite];
    this.cut = false;
    let el;
    try {
      el = this.renderBody(cx);
    } catch (err) {
      el = this.broken(err);
    }
    this.inRender = false;
    this.rendered = this.wanted ?? 0;
    return el;
  }

  broken(err) {
    const t = theme();
    return v_flex().id("bp-root").size_full().bg(t.background).items_center().justify_center().gap(10).p(16)
      .child(div().text_size(12.5).text_color(t.muted).child(this.T.broken))
      .child(div().max_w(420).text_size(11).text_color(t.dim).child(String(err?.message ?? err)))
      .child(this.refreshButton(t));
  }

  renderBody(cx) {

    const t = theme(), pal = palette(t);
    this.mono = settings().font_family;
    const all = panes();
    this.paneFocused = this.inPanel ? !!this.hovering : !!all.find((p) => p.mod === MOD && p.tab === this.ownTab && p.focused);
    const tabId = this.servedTab(all);
    this.targetList = this.targets(all, tabId);

    if (tabId !== this.ctxTab) {
      this.ctxTab = tabId;
      this.ctxCwd = undefined;
      this.ctxTerm = null;
      this.project = null;
      this.watchGen = (this.watchGen ?? 0) + 1;
      this.forget();
      this.selected = null;
      this.compose = null;
      this.target = null;
      this.loading = true;
    }

    const terms = all.filter((p) => p.terminal && p.tab === tabId && this.targetList.some((x) => x.address === p.terminal));
    const pick = terms.find((p) => p.terminal === this.ctxTerm)
      ?? terms.find((p) => p.terminal === this.project?.meta.agent) ?? terms[0];
    this.ctxTerm = pick?.terminal ?? null;
    this.ctxPane = pick?.pane ?? null;
    this.ctxBranch = pick?.branch ?? null;

    const fixed = fixedFolder() ? given() : null;
    if (fixed) this.ctxBranch = fixed.branch ?? null;
    const cwd = fixed ? fixed.folder : pick?.cwd ?? null;
    const machine = fixed ? fixed.machine ?? null : pick?.terminal?.includes("/") ? pick.terminal.split("/")[0] : null;
    if (cwd !== this.ctxCwd || machine !== this.ctxMachine || this.ctxCwd === undefined) {
      this.ctxCwd = cwd;
      this.ctxMachine = machine;
      this.ctxPending = true;
    }
    const G = this.graphs[this.tab];
    const narrow = this.width > 0 && this.width < 420;
    return v_flex()
      .id("bp-root")
      .size_full()
      .bg(t.background)

      .when(this.inPanel, (el) => el.min_h(0).rounded(10).overflow_hidden().border_1().border_color(t.border))
      .text_size(13)
      .track_focus(this.focus)
      .on_size_change((s, cx) => {

        const width = s.width / this.zoom;
        if (Math.abs(width - this.width) < 0.5) return;
        this.width = width;
        this.laidOut();
        this.redraw(cx);
      })
      .on_mouse_move((e) => (this.bounds = e.bounds ?? this.bounds))
      .when(this.inPanel, (el) => el.on_hover((on, cx) => {
        this.hovering = on;
        this.redraw(cx);
      }))
      .on_mouse_down("left", (_e, cx) => {
        this.focus.focus();
        this.ownPane(cx);
      })
      .on_key_down((e, cx) => {

        const k = KEY_ALIASES[e.key_char] ?? KEY_ALIASES[e.key] ?? e.keystroke;
        if (k === "escape") {
          if (this.compose) this.closeCompose();
          else if (this.editing) this.setEditing(false);
          else this.selected = null;
        } else if (this.typing) return;
        else if (k === "e") this.editKey();
        else if (k === "f") this.command("fit", cx);
        else if (k === "0") this.command("zoom-100", cx);
        else if (k === "=" || k === "shift-=") this.command("zoom-in", cx);
        else if (k === "-") this.command("zoom-out", cx);
        else if (/^[1-9]$/.test(k)) this.setTab(Number(k) - 1, cx);
        else return;
        cx.stop_propagation();
        this.redraw(cx);
      })
      .child(this.header(t, pal, G, narrow))
      .child(this.tabs(t))
      .child(this.canvas(t, pal, cx))
      .child(this.footer(t, narrow))
      .children(this.measuring());
  }

  iconButton(t, id, file, tip, on, onClick) {
    return div().id(id).flex_none().size(28).flex().items_center().justify_center()
      .rounded(6).cursor_pointer().tooltip(tip).text_color(on ? t.accent : t.muted)
      .when(on, (el) => el.bg(alpha(t.accent, 0.16)))
      .when(!on, (el) => el.hover((s) => s.bg(t.hover).text_color(t.foreground)))
      .on_click((_e, cx) => {
        onClick(cx);
        this.redraw(cx);
      })
      .child(svg(`mods/blueprint/${file}`).size(15));
  }

  refreshButton(t) {
    return this.iconButton(t, "bp-refresh", "refresh.svg", this.T.refreshTip, false, (cx) => this.refresh(cx));
  }

  header(t, pal, G, narrow) {
    const T = this.T;
    const icon = (...a) => this.iconButton(t, ...a);

    const a = this.pickTarget(this.targetList);
    const pill = h_flex().id("bp-agent").flex_none().gap(6).px(10).h(24).rounded_full().items_center().bg(t.raised)
      .tooltip(a?.status ? T.status[a.status] ?? a.status : a?.name ?? T.noAgent)
      .when(!!a, (el) => el.child(statusMark(t, a.status)))
      .child(div().text_size(12).text_color(a ? t.muted : t.dim).max_w(160).truncate().child(a ? a.name : T.noAgent));
    return h_flex().h(HEADER_H).flex_none().pl(16).pr(10).gap(8).items_center().border_b(1).border_color(t.border)
      .child(h_flex().flex_1().min_w(0).gap(8).items_center()

        .child(div().min_w(0).truncate().font_semibold().text_color(t.foreground)
          .child(this.project ? this.project.topic ?? this.project.name : this.loading ? "" : T.noProject))
        .when(!!this.project && !!this.ctxBranch && !narrow, (el) => el.child(div().flex_none().text_size(11.5).font_family(this.mono).text_color(t.dim).child(this.ctxBranch))))

      .when(!!this.version && newer(this.latest, this.version), (el) => el.child(div().id("bp-update").flex_none().mr(2).px(8).h(22)
        .rounded_full().flex().items_center().text_size(11.5).font_medium().bg(alpha(t.accent, 0.16)).text_color(t.accent)
        .cursor_pointer().tooltip(T.updateTip(this.latest, this.version)).hover((s) => s.bg(alpha(t.accent, 0.28)))
        .on_click((_e, cx) => {
          this.askUpdate(cx);
          this.redraw(cx);
        })
        .child(T.update)))
      .child(div().mr(4).child(pill))
      .child(this.refreshButton(t))
      .when(!!G, (el) => el.child(icon("bp-pin", G.pinned ? "pin-on.svg" : "pin.svg", G.pinned ? T.unpinTip : T.pinTip, G.pinned, (cx) => this.togglePin(cx))))
      .when(this.inPanel, (el) => el.child(icon("bp-pane", "pane.svg", T.openPane, false, () => this.openPane())))
      .when(!!G, (el) => el.child(icon("bp-edit", "edit.svg", T.editTip, this.editing, () => this.editKey())));
  }

  tabs(t) {
    const p = this.project, G = this.graphs[this.tab];
    this.rowH = TABS_H;

    const age = G ? this.T.ago(minutesSince(G.loaded)) : "";
    const room = this.width - 20 - (p ? 32 : 0) - (this.asking() ? 96 : 0) - (G ? estimate(age, 11.5) + 16 : 0);
    const natural = this.graphs.map((d) => estimate(d.tab, 12) + 22 + (d.pinned ? 16 : 0) + 4);
    const tabMax = this.width > 0 ? tabCap(natural, room, TAB_MIN, TAB_MAX) : TAB_MAX;
    return h_flex().h(TABS_H).flex_none().px(10).gap(4).items_center().border_b(1).border_color(t.border).overflow_hidden()
      .children(this.graphs.map((d, i) => {
        const on = i === this.tab;
        return h_flex().id(`bp-tab-${i}`).flex_none().max_w(tabMax).h(26).gap(5).px(10).items_center().rounded(6).text_size(12)
          .border_1().border_color(on ? t.input : t.border).tooltip(d.tab)
          .cursor_pointer().text_color(on ? t.foreground : t.muted)
          .when(on, (el) => el.bg(t.raised))
          .when(!on, (el) => el.hover((s) => s.bg(t.hover).text_color(t.foreground)))
          .on_click((_e, cx) => {
            this.setTab(i, cx);
            this.redraw(cx);
          })
          .when(d.pinned, (el) => el.child(svg("mods/blueprint/pin-on.svg").size(11).flex_none()))
          .child(div().min_w(0).truncate().child(d.tab));
      }))
      .when(!!this.asking(), (el) => el.child(div().flex_none().px(10).py(4).rounded(6).text_size(12).text_color(t.dim)
        .border(1).border_color(t.border).child(this.T.drawingNew)))
      .when(!!p, (el) => el.child(div().id("bp-new").flex_none().size(26).ml(2).flex().items_center().justify_center().rounded(6)
        .cursor_pointer().tooltip(this.T.newTip).text_color(this.compose?.kind === "new" ? t.accent : t.muted)
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => {
          this.openCreate();
          this.redraw(cx);
        })
        .child(svg("mods/blueprint/plus.svg").size(14))))
      .child(div().flex_1())
      .when(!!G, (el) => el.child(div().flex_none().pl(8).pr(4).text_size(11.5).text_color(t.dim).child(age)));
  }

  canvas(t, pal, cx) {
    this.zoom = zoomOf(settings());

    if (this.rawSize) {
      const Z = this.zoom;
      this.size = { width: this.rawSize.width / Z, height: this.rawSize.height / Z };
    }
    const el = div().id("bp-canvas").flex_1().min_h(0).relative().overflow_hidden().bg(t.canvas)
      .when(!!this.drag?.moved, (el) => el.cursor_grabbing())
      .when(!this.drag?.moved, (el) => el.cursor_grab())
      .on_size_change((s, cx) => {
        const r = this.rawSize;
        if (r && Math.abs(s.width - r.width) < 0.5 && Math.abs(s.height - r.height) < 0.5) return;
        this.rawSize = { width: s.width, height: s.height };
        const Z = this.zoom;
        this.size = { width: s.width / Z, height: s.height / Z };
        this.redraw(cx);
      })
      .on_scroll_wheel((e, cx) => {
        const cur = this.size && this.current();
        if (!cur) return;
        const v = cur.v, Z = this.zoom;
        const r = e.local_position ?? (e.bounds ? { x: e.position.x - e.bounds.x, y: e.position.y - e.bounds.y } : null);
        const p = r ? { x: r.x / Z, y: r.y / Z } : { x: this.size.width / 2, y: this.size.height / 2 };
        if (e.modifiers.control || e.modifiers.platform) this.zoomAt(Math.exp(e.delta.y * 0.003), p.x, p.y);
        else this.views[this.vkey] = { ...v, x: v.x + e.delta.x / Z, y: v.y + e.delta.y / Z };
        this.redraw(cx);
      })
      .on_mouse_down("left", (e) => {
        const cur = this.size && this.current();
        if (!cur) return;
        this.drag = { x: e.position.x, y: e.position.y, v: { ...cur.v }, moved: false };
      })
      .on_mouse_move((e, cx) => {
        const d = this.drag;
        if (!d) return;
        const Z = this.zoom, dx = (e.position.x - d.x) / Z, dy = (e.position.y - d.y) / Z;
        if (!d.moved && Math.hypot(dx, dy) < 3) return;
        d.moved = true;
        this.views[this.vkey] = { ...d.v, x: d.v.x + dx, y: d.v.y + dy };
        this.redraw(cx);
      })
      .on_mouse_up("left", (_e, cx) => {

        if (this.drag && !this.drag.moved) this.selected = null;
        this.drag = null;
        this.redraw(cx);
      })
      .on_hover((h) => {
        if (!h) this.drag = null;
      });
    if (!this.size) return el;
    if (!this.graphs.length) {
      if (this.loading) return el;
      return el.child(this.emptyCard(t)).when(this.compose?.kind === "new", (el) => el.child(this.composer(t)));
    }

    let cur = this.current(), els = null, error = null;
    for (let tries = 0; cur && !els && tries < 2; tries++) {
      try {
        els = this.drawing(t, pal, cur);
      } catch (err) {
        error = err;
        this.drop(cur.L);
        cur = this.current();
      }
    }
    if (!els) {
      const failed = error || ["LR", "TB"].every((dir) => this.failed.has(this.lkey(this.tab, dir)));
      if (!failed && !this.job?.noted) return el;
      return el.child(div().absolute().inset_0().flex().flex_col().items_center().justify_center().gap(8)
        .child(div().text_size(12).text_color(t.dim).child(failed ? this.T.drawFailed : this.T.laying))
        .when(!!failed, (el) => el.child(this.refreshButton(t))));
    }
    return el.children(els)
      .when(this.editing, (el) => el.child(h_flex().absolute().left(12).top(12).gap(6).px(10).h(26).items_center().rounded(6)
        .bg(alpha(t.accent, 0.16)).border(1).border_color(alpha(t.accent, 0.5)).text_size(12).text_color(t.accent)
        .child(div().font_semibold().child(this.T.editMode))
        .child(div().text_color(t.muted).child(this.compose ? this.T.enterSend : this.T.pickNode))))
      .when(!!this.compose, (el) => el.child(this.composer(t)));
  }

  emptyCard(t) {
    const T = this.T, p = this.project, list = this.targetList ?? [];
    const W = this.size.width, cw = Math.min(440, W - 32);
    const body = v_flex().w(cw).gap(10).p(18).rounded(12).bg(t.background).border(1).border_color(t.border)
      .child(div().text_size(14).font_semibold().text_color(t.foreground).child(p ? T.emptyTitle : T.noProject));
    if (!p) {
      return div().absolute().inset_0().flex().items_center().justify_center()
        .child(body.child(div().text_size(12.5).text_color(t.muted).child(T.noAgentHere)));
    }
    const where = [p.path, this.ctxBranch].filter(Boolean).join(" · ");
    let out = body.child(div().text_size(11).font_family(this.mono).text_color(t.dim).truncate().child(where));
    if (fixedFolder() && !list.length) {
      const isDrawing = !!this.headless || Date.now() - (p.meta.asked ?? 0) < ASK_WAIT;
      out = isDrawing
        ? out.child(div().pt(4).text_size(12.5).text_color(t.accent).child(`${HEADLESS_NAME} is drawing this on ${p.machine ?? "this computer"}…`))
          .child(div().text_size(12).text_color(t.muted).child("Diagrams show up here as they are saved."))
        : out.child(div().id("bp-draw").h(34).px(12).flex().items_center().rounded(8).border(1).border_color(t.input).bg(t.raised)
          .cursor_pointer().hover((s) => s.border_color(t.accent)).text_size(13).text_color(t.foreground)
          .on_click((_e, cx) => { this.startDrawing(p, cx); this.redraw(cx); })
          .child(`Draw with ${HEADLESS_NAME}`));
      return div().absolute().inset_0().flex().items_center().justify_center().child(out);
    }
    const asked = this.pending(list);
    if (asked) {
      out = out.child(div().pt(4).text_size(12.5).text_color(t.accent).child(T.asked(asked.name)))
        .child(div().text_size(12).text_color(t.muted).child(T.waitingBody));
    } else if (list.length) {
      out = out.child(div().pt(4).text_size(12.5).text_color(t.muted).child(T.pickAgent))
        .child(v_flex().gap(6).children(list.map((a, i) => h_flex().id(`bp-agent-${i}`).h(34).px(12).gap(8).items_center().rounded(8)
          .border(1).border_color(t.input).bg(t.raised).cursor_pointer().hover((s) => s.border_color(t.accent))
          .on_click((_e, cx) => {
            this.connect(a, cx);
            this.redraw(cx);
          })
          .child(div().flex_1().text_size(13).text_color(t.foreground).child(a.name))
          .child(div().text_size(11).font_family(this.mono).text_color(t.dim).child(a.address)))));
    } else {
      out = out.child(div().pt(4).text_size(12.5).text_color(t.muted).child(T.noAgentHere));
    }
    out = out.child(div().pt(6).text_size(11).text_color(t.dim).child(`${T.emptyHint} · ${T.keepHint}`));
    return div().absolute().inset_0().flex().items_center().justify_center().child(out);
  }

  composer(t) {
    const fresh = this.compose.kind === "new";
    const n = fresh ? null : this.graph.nodes.get(this.compose.id);
    if (!fresh && !n) return div();
    const list = this.targetList ?? [], target = this.pickTarget(list);
    const W = this.size.width, cw = Math.min(560, W - 24);
    const button = (id, label, primary, enabled, onClick) =>
      div().id(id).h(28).px(12).flex().items_center().rounded(7).text_size(12).font_medium()
        .border(1).border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
        .text_color(primary ? t.solid_foreground : t.foreground)
        .when(!enabled, (el) => el.opacity(0.45))
        .when(enabled, (el) => el.cursor_pointer().hover((s) => s.opacity(0.88)).on_click((_e, cx) => {
          onClick(cx);
          this.redraw(cx);
        }))
        .child(label);
    const next = () => {

      if (list.length < 2) return;
      const i = list.findIndex((x) => x.address === target?.address);
      this.target = list[(i + 1) % list.length].address;
    };
    const ready = (!!target || !!fixedFolder()) && !this.sending;
    return v_flex().id("bp-compose").absolute().left((W - cw) / 2).bottom(12).w(cw).p(12).gap(8).rounded(10)
      .bg(t.popover).border(1).border_color(alpha(t.accent, 0.6)).shadow_lg().cursor_default()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(h_flex().gap(8).items_center()
        .child(div().flex_none().text_size(12.5).font_semibold().text_color(t.foreground).child(fresh ? this.T.newDiagram : n.title))
        .when(!!n?.ref, (el) => el.child(div().min_w(0).truncate().text_size(11).font_family(this.mono).text_color(t.muted).child(n.ref)))
        .child(div().flex_1())
        .child(div().id("bp-target").flex_none().px(8).h(22).flex().items_center().rounded(6).text_size(11.5)
          .bg(alpha(target ? t.accent : t.blocked, 0.12)).text_color(target ? t.accent : t.blocked)
          .when(list.length > 1, (el) => el.cursor_pointer().on_click((_e, cx) => { next(); this.redraw(cx); }))
          .child(target ? `→ ${target.name}${list.length > 1 ? " ⇄" : ""}` : fixedFolder() ? `→ ${HEADLESS_NAME}` : this.T.noTarget)))
      .child(div().relative()
        .child(Input.new(this.input).h(34).px(10).rounded(8).border(1).border_color(this.typing ? t.accent : t.input)
          .bg(t.background).text_size(13).text_color(t.foreground))
        .when(this.noteEmpty, (el) => el.child(div().absolute().left(11).top(0).h(34).flex().items_center()
          .text_size(13).text_color(t.dim).child(fresh ? this.T.newPlaceholder : this.T.placeholder))))

      .when(fresh, (el) => el.child(h_flex().gap(6).flex_wrap().children(this.T.suggest.map((x, i) =>
        div().id(`bp-suggest-${i}`).px(8).h(24).flex().items_center().rounded(6).border(1).border_color(t.input)
          .text_size(11.5).text_color(t.muted).cursor_pointer().hover((s) => s.border_color(t.accent).text_color(t.foreground))
          .on_click((_e, cx) => {
            this.input.set_value(x);
            this.noteEmpty = false;
            this.input.focus();
            this.redraw(cx);
          })
          .child(x)))))
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim)
          .child(!target ? this.T.openAgent : fresh ? this.T.newHint : this.T.sendsWith))
        .child(button("bp-cancel", this.T.cancel, false, true, () => this.closeCompose()))
        .child(button("bp-send", this.sending ? this.T.sending : this.T.send, true, ready, (cx) => this.send(cx))));
  }

  drawing(t, pal, cur = this.current()) {
    const { L, v } = cur, g = L.g ?? this.graph;
    const { z } = v, W = this.size.width, H = this.size.height;
    const X = (x) => x * z + v.x, Y = (y) => y * z + v.y;
    const sel = this.selected && g.nodes.has(this.selected) ? this.flow(L, this.selected) : null;
    const layer = (path, color) => div().absolute().left(0).top(0).w(W).h(H).child(window.paint_path(path, color));
    const ZPath = PATHS;
    L.id ??= (this.layouts = (this.layouts ?? 0) + 1);

    const m = 24 / z, x0 = -v.x / z - m, x1 = (W - v.x) / z + m, y0 = -v.y / z - m, y1 = (H - v.y) / z + m;
    const seen = (b) => b.x1 >= x0 && b.x0 <= x1 && b.y1 >= y0 && b.y0 <= y1;
    const reach = this.reach(L);
    let cut = false, count = 0;
    const late = () => cut || (++count % 8 === 0 && (cut = Date.now() > (this.deadline ?? Infinity)));

    const nodes = [];
    L.nodes.forEach((item, k) => {
      if (seen(reach.nodes[k]) && !late()) nodes.push(...this.node(item, t, pal, sel, X, Y, z, ZPath));
    });

    let s = 20 * z;
    while (s < 12) s *= 2;
    while (s > 40) s /= 2;
    const dot = 1.6, ox = ((v.x % s) + s) % s, oy = ((v.y % s) + s) % s;
    const gridKey = [s, ox, oy, W, H, this.zoom].join(":");
    if (this.paths.grid?.key !== gridKey) {
      let grid = ZPath.stroke(dot).dash_array([dot, s - dot]);
      for (let y = oy; y < H; y += s) grid = grid.move_to(ox - dot / 2, y).line_to(W + s, y);
      this.paths.grid = { key: gridKey, path: grid.build() };
    }
    const els = [layer(this.paths.grid.path, alpha(t.foreground, 0.11))];

    const head = Math.max(4, 7 * Math.sqrt(z));
    const work = this.scope(L);
    const edgeKey = [L.id, v.x, v.y, z, W, H, this.zoom, sel ? this.selected : "", t.muted, t.foreground, pal.active].join(":");
    if (this.paths.edges?.key !== edgeKey) {
      const lines = new Map(), arrows = new Map();
      const lineGroup = (key, color, width, dash) => {
        if (!lines.has(key)) {
          let b = ZPath.stroke(width);
          if (dash) b = b.dash_array(dash.map((d) => d * Math.max(0.6, z)));
          lines.set(key, { b, color });
        }
        return lines.get(key);
      };
      const arrowGroup = (color) => {
        if (!arrows.has(color)) arrows.set(color, { b: ZPath.fill(), color });
        return arrows.get(color);
      };
      const colors = {
        active: [alpha(pal.active, 0.45), alpha(pal.active, 0.95)], dim: alpha(t.muted, 0.18), lit: t.foreground,
        plain: alpha(t.muted, 0.75), plainArrow: alpha(t.muted, 0.9),
      };
      const tips = new Set();
      L.edges.forEach((ed, k) => {
        if (!seen(reach.edges[k]) || late()) return;
        const lit = !sel || sel.edges.has(ed.e);
        const active = work.yellow.has(ed.e) && lit;
        const dashed = ed.e.style === "dashed" || active;
        const look = active ? "active" : !lit ? "dim" : sel ? "lit" : "plain";

        const strong = !!sel && lit;
        const color = look === "active" ? colors.active[strong ? 1 : 0] : colors[look];
        const width = strong ? 2 : active ? 1.6 : 1.25;
        const gr = lineGroup(`${look}:${dashed}:${width}`, color, width, dashed ? [4, 4] : null);
        const segs = ed.segs, last = segs[segs.length - 1][3], d = ed.dir;
        const end = { x: X(last.x), y: Y(last.y) };
        const stop = ed.e.arrow ? { x: end.x - d.x * head * 0.8, y: end.y - d.y * head * 0.8 } : end;
        gr.b = gr.b.move_to(X(segs[0][0].x), Y(segs[0][0].y));
        segs.forEach(([, c1, c2, p], i) => {
          const to = i === segs.length - 1 ? stop : { x: X(p.x), y: Y(p.y) };
          gr.b = gr.b.cubic_bezier_to(to.x, to.y, X(c1.x), Y(c1.y), X(c2.x), Y(c2.y));
        });

        const tip = `${Math.round(end.x)}:${Math.round(end.y)}`;
        if (ed.e.arrow && !tips.has(tip)) {
          tips.add(tip);
          const side = { x: -d.y, y: d.x }, w = head * 0.55;
          const a = arrowGroup(active ? pal.active : look === "plain" ? colors.plainArrow : color);
          a.b = a.b.add_polygon([[end.x, end.y], [end.x - d.x * head + side.x * w, end.y - d.y * head + side.y * w], [end.x - d.x * head - side.x * w, end.y - d.y * head - side.y * w]], true);
        }
      });
      const groups = [...lines.values(), ...arrows.values()].map((gr) => ({ path: gr.b.build(), color: gr.color }));

      this.paths.edges = cut ? null : { key: edgeKey, groups };
      for (const gr of groups) els.push(layer(gr.path, gr.color));
    } else for (const gr of this.paths.edges.groups) els.push(layer(gr.path, gr.color));

    const runs = this.exporting || !this.paneFocused || cut ? [] : work.runs.filter((path) => !sel || path.every((ed) => sel.edges.has(ed.e)));
    const tracks = runs.map((path) => {
      const pts = [];
      path.forEach((ed, i) => {
        const segs = ed.segs.map((sg) => sg.map((p) => ({ x: X(p.x), y: Y(p.y) })));
        if (i > 0) pts.push({ ...segs[0][0], cross: true });
        for (const sg of segs) for (let k = i > 0 ? 1 : 0; k <= 16; k++) pts.push(at(sg, k / 16));
      });
      let len = 0;
      return { pts: pts.map((p, k) => ({ ...p, d: k ? (len += Math.hypot(p.x - pts[k - 1].x, p.y - pts[k - 1].y)) : 0 })), len };
    });
    if (tracks.length) {
      const longest = Math.max(...tracks.map((l) => l.len));
      const per = Math.max(6, Math.min(FLOW_SPOTS, Math.floor(FLOW_BUDGET / tracks.length)));
      const step = Math.max(FLOW_GAP, longest / per);
      const cycle = Math.ceil(longest / step) + Math.round(FLOW_REST / FLOW_MS);
      const built = new Set();
      for (const l of tracks) {
        for (let d = step / 2, k = 0, tick = 0; d < l.len - head * 1.2; d += step, tick++) {
          while (k < l.pts.length - 1 && l.pts[k + 1].d < d) k++;
          const p = l.pts[k], key = `${Math.round(p.x)}:${Math.round(p.y)}:${tick}`;
          if (l.pts[k + 1]?.cross || built.has(key) || p.x < -6 || p.x > W + 6 || p.y < -7 || p.y > H + 7) continue;
          built.add(key);
          const frames = Array.from({ length: cycle }, (_, i) => (i === tick ? "●" : ""));
          els.push(div().absolute().left(p.x - 6).top(p.y - 7).w(12).h(14).flex().items_center().justify_center()
            .text_size(10).text_color(pal.active).frames(frames, FLOW_MS));
        }
      }
    }

    const mk = L.mk ?? this.mkey(this.tab);
    for (const ed of L.edges) {
      if (!ed.label) continue;
      const m = this.edgeLabelBox(mk, g, ed.e);
      const box = { x0: ed.label.x - m.w / 2, x1: ed.label.x + m.w / 2, y0: ed.label.y - m.h / 2, y1: ed.label.y + m.h / 2 };
      if (!seen(box) || late()) continue;
      const lit = !sel || sel.edges.has(ed.e);
      els.push(div().absolute().left(X(ed.label.x) - (m.w * z) / 2).top(Y(ed.label.y) - (m.h * z) / 2).w(m.w * z).h(m.h * z)
        .flex().items_center().justify_center().rounded(4 * z).bg(t.canvas)
        .text_size(LABEL * z).text_color(lit ? t.muted : alpha(t.muted, 0.3)).child(ed.e.label));
    }

    this.cut = cut;
    return els.concat(nodes);
  }

  reach(L) {
    return (L.reach ??= {
      nodes: L.nodes.map((it) => ({ x0: it.x - it.w / 2, x1: it.x + it.w / 2, y0: it.y - it.h / 2, y1: it.y + it.h / 2 })),
      edges: L.edges.map((ed) => {
        const pts = ed.segs.flat();
        return { x0: Math.min(...pts.map((p) => p.x)), x1: Math.max(...pts.map((p) => p.x)), y0: Math.min(...pts.map((p) => p.y)), y1: Math.max(...pts.map((p) => p.y)) };
      }),
    });
  }

  drop(L) {
    if (L.key) {
      this.failed.add(L.key);
      this.cache.delete(L.key);
    }
    for (const [file, p] of Object.entries(this.prev)) if (p.L === L) delete this.prev[file];
  }

  measuring() {
    const els = [], mono = this.mono;
    if (this.measuredFont !== mono) {

      this.measuredFont = mono;
      this.measured = {};
      this.whole.clear();
      for (const k of Object.keys(this.vers)) this.vers[k]++;
    }
    if (!this.graphs.length) return els;
    const order = [this.tab, ...this.graphs.keys()].filter((i, k, a) => a.indexOf(i) === k);
    const next = order.find((i) => this.missing(i));
    if (next === undefined) return els;

    const room = () => els.length < MEASURE_MAX && Date.now() < (this.deadline ?? Infinity) + 8;
    const { g } = this.graphs[next], mk = this.mkey(next);
    for (const n of g.nodes.values()) {
      const key = `n:${mk}:${n.id}`;
      if (this.measured[key]) continue;
      if (!room()) return els;
      els.push(v_flex().id(`bp-m-${key}`).absolute().left(0).top(0).opacity(0).items_center().gap(2)
        .child(div().whitespace_nowrap().text_size(TITLE).font_semibold().child(n.title))
        .when(!!n.sub, (el) => el.child(div().whitespace_nowrap().text_size(SUB).font_family(mono).child(n.sub)))
        .on_size_change((s, cx) => this.measure(key, mk, s, cx)));
    }
    g.edges.forEach((e, k) => {
      const key = `e:${mk}:${k}`;
      if (!e.label || this.measured[key] || !room()) return;
      els.push(div().id(`bp-m-${key}`).absolute().left(0).top(0).opacity(0).px(5).py(1).whitespace_nowrap().text_size(LABEL)
        .child(e.label).on_size_change((s, cx) => this.measure(key, mk, s, cx)));
    });
    return els;
  }

  measure(key, mk, real, cx) {

    const s = { width: real.width / this.zoom, height: real.height / this.zoom };
    const old = this.measured[key];
    if (old && Math.abs(old.w - s.width) < 0.5 && Math.abs(old.h - s.height) < 0.5) return;
    this.measured[key] = { w: s.width, h: s.height };
    this.vers[mk] = (this.vers[mk] ?? 0) + 1;
    if (this.measurePending) return;
    this.measurePending = true;
    cx.timer.after(16, (cx) => {
      this.measurePending = false;
      this.redraw(cx);
    });
  }

  node(item, t, pal, sel, X, Y, z, ZPath) {
    const n = item.node, w = item.w * z, h = item.h * z;
    const left = X(item.x) - w / 2, top = Y(item.y) - h / 2;
    const lit = !sel || sel.nodes.has(n.id);
    const picked = this.selected === n.id && !this.exporting;
    const hover = this.hovered === n.id && !this.exporting;
    const status = inProgress(n) ? "active" : n.status === "done" ? "done" : null;
    const aiming = (this.editing && hover) || this.compose?.id === n.id;
    const stroke = picked || aiming ? t.accent : status === "active" ? pal.active : status === "done" ? alpha(pal.done, 0.8) : hover ? alpha(t.foreground, 0.55) : t.input;
    const bw = picked || aiming || status === "active" ? 2 : 1;
    const mono = this.mono;
    const label = v_flex().items_center().gap(2 * z)
      .child(div().whitespace_nowrap().text_size(TITLE * z).font_semibold().text_color(t.foreground).child(n.title))
      .when(!!n.sub, (el) => el.child(div().whitespace_nowrap().text_size(SUB * z).font_family(mono).text_color(t.muted).child(n.sub)));
    const bg = hover ? t.raised : t.background;

    let box = div().id(`bp-n-${this.tab}-${n.id}`).absolute().left(left).top(top).w(w).h(h)
      .flex().items_center().justify_center().cursor_pointer()
      .opacity(lit ? 1 : 0.28).transition("opacity", 160)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_hover((on, cx) => {
        this.hovered = on ? n.id : this.hovered === n.id ? null : this.hovered;
        this.redraw(cx);
      })
      .on_click((_e, cx) => {
        this.clickNode(n);
        this.redraw(cx);
      });
    const full = (path, color) => div().absolute().left(0).top(0).w(w).h(h).child(window.paint_path(path, color));

    const shape = (part, make) => {
      const cache = (this.paths.shapes ??= new Map()), key = `${n.shape}:${part}:${w}:${h}:${bw}:${z}:${this.zoom}`;
      if (!cache.has(key)) {
        if (cache.size > 4000) cache.clear();
        cache.set(key, make().build());
      }
      return cache.get(key);
    };
    const i = bw / 2;
    if (n.shape === "diamond") {
      const poly = [[w / 2, i], [w - i, h / 2], [w / 2, h - i], [i, h / 2]];
      box = box.child(full(shape("fill", () => ZPath.fill().add_polygon(poly, true)), bg))
        .child(full(shape("line", () => ZPath.stroke(bw).add_polygon(poly, true)), stroke));
    } else if (n.shape === "cylinder") {
      const rx = w / 2 - i, ry = 7 * z;
      const body = (b) => b.move_to(i, ry).arc_to(rx, ry - i, 0, false, true, w - i, ry).line_to(w - i, h - ry)
        .arc_to(rx, ry - i, 0, false, true, i, h - ry).close();
      const outline = () => body(ZPath.stroke(bw)).move_to(i, ry).arc_to(rx, ry - i, 0, false, false, w - i, ry);
      box = box.child(full(shape("fill", () => body(ZPath.fill())), bg)).child(full(shape("line", outline), stroke)).pt(ry);
    } else {
      const r = n.shape === "stadium" ? h / 2 : n.shape === "circle" ? w / 2 : n.shape === "round" ? 14 * z : 8 * z;
      box = box.bg(bg).border(bw).border_color(stroke).rounded(r);
      if (picked) box = box.shadow_md();
    }
    box = box.child(label);

    const out = [box];
    if (picked) {

      const g = 4;
      if (n.shape !== "diamond" && n.shape !== "cylinder") {
        const r = n.shape === "stadium" ? h / 2 + g : n.shape === "circle" ? w / 2 + g : 8 * z + g;
        out.unshift(div().absolute().left(left - g).top(top - g).w(w + 2 * g).h(h + 2 * g).rounded(r).border(3).border_color(alpha(t.accent, 0.25)));
      }
    }
    if (status) {

      const cx = X(item.x), cy = Y(item.y);
      const [bx, by] =
        n.shape === "diamond" ? [cx + w / 4, cy - h / 4]
        : n.shape === "circle" ? [cx + w * 0.354, cy - h * 0.354]
        : n.shape === "stadium" ? [cx + w / 2 - h * 0.146, cy - h / 2 + h * 0.146]
        : n.shape === "cylinder" ? [cx + w / 2 - 2, cy - h / 2 + 7 * z]
        : [cx + w / 2 - 3, cy - h / 2 + 3];
      const op = lit ? 1 : 0.28;
      if (status === "done") {
        const d = Math.max(12, 16 * z);
        out.push(div().absolute().left(bx - d / 2).top(by - d / 2).w(d).h(d).rounded_full().bg(pal.done).opacity(op)
          .flex().items_center().justify_center().text_size(d * 0.62).font_semibold().text_color(t.background).child("✓"));
      } else {

        const d = Math.max(8, 11 * z), ring = d + 6;
        if (n.status === "current") {
          out.push(div().absolute().left(bx - ring / 2).top(by - ring / 2).w(ring).h(ring).rounded_full().bg(alpha(pal.active, 0.28)).opacity(op));
        }
        out.push(div().absolute().left(bx - d / 2).top(by - d / 2).w(d).h(d).rounded_full().bg(pal.active).opacity(op));
      }
    }
    return out;
  }

  footer(t, narrow) {
    const n = this.selected ? this.graph.nodes.get(this.selected) : null;
    const has = this.graphs.length > 0;
    const { v } = (this.size && has && this.current()) || { v: { z: 1 } };
    const fitted = !this.views[this.vkey];
    const button = (id, label, onClick, extra = (el) => el) =>
      extra(div().id(id).h(26).px(10).flex().items_center().rounded(6).border(1).border_color(t.border).text_size(12)
        .text_color(t.foreground).cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => {
          onClick(cx);
          this.redraw(cx);
        })
        .child(label));
    const zoom = h_flex().h(26).items_center().rounded(6).border(1).border_color(t.border).text_size(12).text_color(t.foreground)
      .child(div().id("bp-zoom-out").w(24).h_full().flex().items_center().justify_center().cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { this.command("zoom-out", cx); this.redraw(cx); }).child("−"))
      .child(div().id("bp-zoom-100").min_w(48).h_full().px(4).flex().items_center().justify_center().cursor_pointer().hover((s) => s.bg(t.hover))
        .border_l(1).border_r(1).border_color(t.border)
        .on_click((_e, cx) => { this.command("zoom-100", cx); this.redraw(cx); }).child(`${Math.round(v.z * 100)}%`))
      .child(div().id("bp-zoom-in").w(24).h_full().flex().items_center().justify_center().cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { this.command("zoom-in", cx); this.redraw(cx); }).child("+"));
    const mono = this.mono;
    const info = n
      ? h_flex().flex_1().min_w(0).gap(8).items_center().overflow_hidden()
        .child(div().flex_none().text_size(12).font_semibold().text_color(t.foreground).child(n.title))
        .when(!!n.ref, (el) => el.child(div().min_w(0).truncate().text_size(11).font_family(mono).text_color(t.accent).child(n.ref)))
        .when(!narrow && !this.editing, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(this.T.hintEdit)))
      : div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted)
        .child(this.cut ? this.T.partial : this.editing ? this.T.hintEditing : narrow ? this.T.hintNarrow : this.T.hint);
    return h_flex().h(FOOTER_H).flex_none().px(12).gap(6).items_center().border_t(1).border_color(t.border)
      .child(info)
      .when(has, (el) => el
        .child(button("bp-fit", this.T.fit, (cx) => this.command("fit", cx), (e) => e.when(fitted, (e) => e.text_color(t.muted))))
        .child(zoom)
        .when(canExport(), (el) => el.child(button("bp-png", this.exporting ? this.T.saving : "PNG", (cx) => this.exportPng(cx)))));
  }
}

let platform;
const canExport = () => (platform ??= host()?.platform ?? "") === "macos";

async function shot(file) {
  for (const bin of ["herdr-app", `${home()}/.local/bin/herdr-app`, "/Applications/Herdr.app/Contents/MacOS/Herdr"]) {
    try {
      const r = await exec(bin, ["shot", file]);
      if (r.code === 0) return;
    } catch (_) {}
  }
  throw new Error("herdr-app shot failed");
}
