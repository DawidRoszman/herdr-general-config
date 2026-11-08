// Diagrams on disk, one folder per project, inside the app's own data folder so
// nothing lands in the person's repositories:
//
//   <app home>/data/blueprint/projects/<name>-<hash>/
//     <diagram>.mmd   one Mermaid diagram each: the agent writes, Blueprint reads
//     project.json    { path, agent, asked, pinned: [file], seen: { file: ms }, opened: ms,
//                       files: { file: { sum, at } } }
//     topic.txt       the project's main topic, one line, written by the agent
//
// A project is a checkout: the git top level of the tab's terminal folder, so
// every worktree is its own project (its folder stays put while branches come
// and go), or that folder when it is not in git. Diagrams nobody updated or
// opened for KEEP_DAYS are deleted unless pinned, and past a day old a project
// keeps at most KEEP_COUNT unpinned ones.
//
// More than one Blueprint can have a project open (the panel and a pane), so
// project.json changes through updateMeta: a change applied to what is on disk
// and written only if nobody wrote in between (else read and apply again).
//
// It runs on macOS, Linux and Windows, so no shell and no stat: when a file
// last changed is when Blueprint first saw its current text (files.at).
// Paths use "/" everywhere, Windows ones too.

import * as fs from "fs/promises";
import { exec, appHome, readTextFile, writeTextFile } from "herdr";

export const KEEP_DAYS = 7;
export const KEEP_COUNT = 10;
const DAY = 86400000;

export const slashes = (p) => p.replace(/\\/g, "/");
export const projectsDir = () => `${slashes(appHome())}/data/blueprint/projects`;

const checkouts = new Map(); // machine|folder -> checkout
export async function checkoutOf(cwd, machine = null) {
  const folder = slashes(cwd), key = `${machine ?? ""}|${folder}`;
  if (checkouts.has(key)) return checkouts.get(key);
  let root = folder;
  try {
    const r = await exec("git", ["-C", folder, "rev-parse", "--show-toplevel"], { on: machine });
    if (r.code === 0 && r.stdout.trim()) root = slashes(r.stdout.trim());
    checkouts.set(key, root);
  } catch (_) {} // git didn't run: ask again next time
  return root;
}

// FORK (remote machines): an agent in a space on another machine can't write
// into this app's folder, so it saves its diagrams in
// ~/.herdr/blueprint/<project folder name>/ on its own machine, and Blueprint
// mirrors that folder into the local project folder, where everything else
// (watch, retention, project.json) works as it does for a local agent.
const homes = new Map(); // machine -> its $HOME
export async function remoteDirOf(machine, dir) {
  if (!homes.has(machine)) {
    const r = await exec("sh", ["-c", 'printf %s "$HOME"'], { on: machine });
    if (r.code !== 0 || !r.stdout) throw new Error(`No home folder on ${machine}: ${(r.stderr || "").trim()}`);
    homes.set(machine, r.stdout);
  }
  return `${homes.get(machine)}/.herdr/blueprint/${dir.split("/").pop()}`;
}

async function onMachine(machine, script, args) {
  const r = await exec("sh", ["-c", script, "sh", ...args], { on: machine });
  if (r.code !== 0) throw new Error(`${machine}: ${(r.stderr || r.stdout || `exit ${r.code}`).trim()}`);
  return r.stdout;
}

export const makeRemoteDir = (machine, remote) => onMachine(machine, 'mkdir -p "$1"', [remote]);
export const removeRemote = (machine, remote, file) => onMachine(machine, 'rm -f "$1/$2"', [remote, file]);

const FILE_MARK = "\x1e", NAME_END = "\x1f";
// Makes the local folder's diagrams and topic what the remote folder has.
// Nothing happens before the local folder exists (not connected yet).
export async function pullRemote(machine, remote, dir) {
  if (!(await hasDir(dir))) return;
  const out = await onMachine(machine, 'cd "$1" 2>/dev/null || exit 0; for f in *.mmd topic.txt; do [ -f "$f" ] && printf "\\036%s\\037" "$f" && cat "$f"; done; exit 0', [remote]);
  const there = new Map(out.split(FILE_MARK).slice(1).map((chunk) => {
    const end = chunk.indexOf(NAME_END);
    return [chunk.slice(0, end), chunk.slice(end + 1)];
  }));
  for (const name of await fs.readdir(dir)) {
    if ((name.endsWith(".mmd") || name === "topic.txt") && !there.has(name)) await fs.unlink(`${dir}/${name}`);
  }
  for (const [name, text] of there) {
    if ((await readTextFile(`${dir}/${name}`).catch(() => null)) !== text) await fs.writeFile(`${dir}/${name}`, text);
  }
}

// FNV-1a: a short id that stays the same for the same path (or text).
function hash(s) {
  let h = 0x811c9dc5;
  for (const ch of s) h = Math.imul(h ^ ch.codePointAt(0), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0");
}

export function projectDir(path) {
  const name = path.split("/").filter(Boolean).slice(-2).join("-").replace(/[^\w.-]+/g, "_").replace(/^_+/, "") || "root";
  return `${projectsDir()}/${name}-${hash(path)}`;
}

export async function hasDir(dir) {
  try {
    return await fs.exists(dir);
  } catch (_) {
    return false;
  }
}

function parseMeta(text, path) {
  let saved = null;
  try {
    saved = text ? JSON.parse(text) : null;
  } catch (_) {}
  return { path, agent: null, pinned: [], seen: {}, files: {}, opened: 0, ...saved };
}

export async function readMeta(dir, path) {
  return parseMeta(await readTextFile(`${dir}/project.json`).catch(() => null), path);
}

// Applies change(meta) to project.json as it is on disk now, makes the folder
// if needed, and returns what was written. Changes from this Blueprint go one
// at a time; another one writing in between makes this read and apply again.
const queues = new Map(); // dir -> the last change's promise
export function updateMeta(dir, path, change) {
  const next = (queues.get(dir) ?? Promise.resolve()).catch(() => {}).then(() => apply(dir, path, change));
  queues.set(dir, next);
  next.finally(() => queues.get(dir) === next && queues.delete(dir)).catch(() => {});
  return next;
}

async function apply(dir, path, change) {
  await fs.mkdir(dir, { recursive: true });
  const file = `${dir}/project.json`;
  for (let tries = 0; ; tries++) {
    const text = await readTextFile(file);
    const meta = parseMeta(text, path);
    change(meta);
    try {
      await writeTextFile(file, JSON.stringify(meta, null, 1), text);
      return meta;
    } catch (err) {
      if (tries >= 3) throw err; // written by someone else meanwhile: again, on theirs
    }
  }
}

// What changed in a project folder is news when it is a diagram or the topic;
// the rest (project.json and whatever saving it leaves) is bookkeeping. Herdr
// sends the folder itself when too much changed to list: anything may have
// (and so may a path not spelled the way dir is).
export const isNews = (f, dir) => /\.mmd$|topic\.txt$/.test(f) || !slashes(f).startsWith(`${dir}/`);

// *.mmd in the folder, read, each with when its text last changed: the time
// recorded with the same text, else now (a new or changed file).
async function listed(dir, meta, now) {
  let names = [];
  try {
    names = (await fs.readdir(dir)).filter((n) => n.endsWith(".mmd"));
  } catch (_) {
    return { list: [], files: {} };
  }
  const list = [], files = {};
  for (const file of names) {
    const src = await readTextFile(`${dir}/${file}`).catch(() => null);
    if (src == null) continue;
    const sum = hash(src), was = meta.files?.[file];
    files[file] = was?.sum === sum ? was : { sum, at: now };
    list.push({ file, src, mtime: files[file].at });
  }
  return { list, files };
}

// The project's diagrams, oldest-touched ones deleted first. Each comes back
// as { file, mtime, touched, pinned, src }, newest first. New or changed
// files get their time recorded in project.json (and in meta).
export async function load(dir, meta, now = Date.now(), onExpired = null) {
  const { list: found, files } = await listed(dir, meta, now);
  const list = found
    .map((f) => ({ ...f, touched: Math.max(f.mtime, meta.seen?.[f.file] ?? 0), pinned: meta.pinned.includes(f.file) }))
    .sort((a, b) => b.touched - a.touched);
  const keep = [];
  let unpinned = 0;
  for (const f of list) {
    const age = now - f.touched;
    const kept = f.pinned || age <= DAY || (age <= KEEP_DAYS * DAY && unpinned < KEEP_COUNT);
    if (!f.pinned) unpinned++;
    if (kept) keep.push(f);
    else {
      await fs.unlink(`${dir}/${f.file}`).catch(() => {});
      await onExpired?.(f.file); // a mirrored file goes on its machine too, or the next pull brings it back
      delete files[f.file];
    }
  }
  const before = meta.files ?? {};
  const changed = Object.keys(files).length !== Object.keys(before).length
    || Object.entries(files).some(([f, r]) => before[f]?.sum !== r.sum);
  meta.files = files;
  if (changed) await updateMeta(dir, meta.path, (m) => (m.files = files)).catch(() => {});
  return keep;
}

// Every project at once, when Blueprint starts: expired diagrams go, and so
// does a project folder left with no diagram and not opened or asked to draw
// for KEEP_DAYS.
export async function pruneAll(now = Date.now()) {
  let names = [];
  try {
    names = await fs.readdir(projectsDir());
  } catch (_) {
    return;
  }
  for (const name of names) {
    const dir = `${projectsDir()}/${name}`;
    const meta = await readMeta(dir, null);
    const kept = await load(dir, meta, now);
    if (kept.length || now - Math.max(meta.opened ?? 0, meta.asked ?? 0) <= KEEP_DAYS * DAY) continue;
    await fs.unlink(`${dir}/project.json`).catch(() => {});
    await fs.unlink(`${dir}/topic.txt`).catch(() => {});
    await fs.rmdir(dir).catch(() => {});
  }
}
