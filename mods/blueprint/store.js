import * as fs from "fs/promises";
import { exec, appHome, readTextFile, writeTextFile } from "herdr";

export const KEEP_DAYS = 7;
export const KEEP_COUNT = 10;
const DAY = 86400000;

export const slashes = (p) => p.replace(/\\/g, "/");
export const projectsDir = () => `${slashes(appHome())}/data/blueprint/projects`;

const checkouts = new Map();
export async function checkoutOf(cwd, machine = null) {
  const folder = slashes(cwd), key = `${machine ?? ""}|${folder}`;
  if (checkouts.has(key)) return checkouts.get(key);
  let root = folder;
  try {
    const r = await exec("git", ["-C", folder, "rev-parse", "--show-toplevel"], { on: machine });
    if (r.code === 0 && r.stdout.trim()) root = slashes(r.stdout.trim());
    checkouts.set(key, root);
  } catch (_) {}
  return root;
}

const homes = new Map();
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

const queues = new Map();
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
      if (tries >= 3) throw err;
    }
  }
}

export const isNews = (f, dir) => /\.mmd$|topic\.txt$/.test(f) || !slashes(f).startsWith(`${dir}/`);

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
      await onExpired?.(f.file);
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
