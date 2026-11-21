import { exec, home, appHome, readTextFile, writeTextFile } from "herdr";
import { loadSections, sourceKey, describe, git, worthReading, ghError, runGh, turnsKey, snapshotTree } from "./lib/sources.js";
import { buildDigest } from "./lib/digest.js";
import { buildPrompt } from "./lib/prompt.js";
import { schemaFor, normalize, VERSION } from "./lib/walkthrough.js";
import { cacheKey, codeKey, placeKey, deadline, MAX_PROMPT_CHARS } from "./lib/cache.js";
import { longHash } from "./lib/hash.js";
import { mergeRead } from "./lib/read.js";
import { jobScript, readOutcome, isRunCommand } from "./lib/job.js";
import { parseListing, resolveEnds, LISTING } from "./lib/turns.js";
import { taskKey, taskCacheKey, parseTranscript, projectSlug, jsonPath, TRANSCRIPTS } from "./lib/task.js";

const MAX_ENTRIES = 200;
export const dataDir = () => `${home()}/.herdr/walkthrough`;
const entryPath = (key) => `${dataDir()}/entries/${key}.json`;
const pointerPath = (place) => `${dataDir()}/pointers/${place}.json`;
const jobDir = (place) => `${dataDir()}/jobs/${place}`;
const readPath = (top) => `${dataDir()}/read/${longHash(top)}.json`;

async function readJson(path) {
  try {
    const text = await readTextFile(path);
    return text ? JSON.parse(text) : null;
  } catch { return null; }
}

async function write(path, text) {
  const old = await readTextFile(path).catch(() => null);
  await writeTextFile(path, text, old);
}

export async function ensureDirs() {
  const d = dataDir();
  await exec("mkdir", ["-p", `${d}/entries`, `${d}/pointers`, `${d}/jobs`, `${d}/read`]);
}

export async function copyText(text) {
  const path = `${dataDir()}/clipboard.md`;
  await write(path, text);
  const r = await exec("sh", ["-c", COPY, "sh", path]);
  if (r.code !== 0) throw new Error((r.stderr || "No clipboard program found (pbcopy, wl-copy or xclip).").trim());
}

const COPY = 'if command -v pbcopy >/dev/null; then LC_ALL=en_US.UTF-8 pbcopy < "$1"; elif command -v wl-copy >/dev/null; then wl-copy --type "text/plain;charset=utf-8" < "$1"; elif command -v xclip >/dev/null; then xclip -selection clipboard -target UTF8_STRING < "$1"; else echo "No clipboard program found (pbcopy, wl-copy or xclip)." >&2; exit 1; fi';

export const MAX_COMMENT_CHARS = 65536;

export async function postComment(top, number, text) {
  if (text.length > MAX_COMMENT_CHARS) throw new Error(`It's too long for a GitHub comment (${text.length.toLocaleString("en")} characters; the limit is ${MAX_COMMENT_CHARS.toLocaleString("en")}).`);
  const path = `${dataDir()}/pr-comment.md`;
  await write(path, text);
  const r = await runGh(exec, top, ["pr", "comment", String(number), "--body-file", path]);
  if (r.code !== 0) throw new Error(ghError(r.stderr || r.stdout));
  return (r.stdout ?? "").trim().split("\n").pop() ?? "";
}

export async function claudeVersion() {
  try {
    const r = await exec("claude", ["--version"]);
    return r.code === 0 ? r.stdout.trim() : null;
  } catch { return null; }
}

export async function readDiff(repo, source) {
  const { sections, unread } = await loadSections(exec, repo.top, source);
  const digest = buildDigest(sections);
  for (const u of unread) digest.files.push({ path: u.path, oldPath: null, status: "added", binary: false, scope: "unread", hunks: [], generated: false, unread: u.why });
  return { ...digest, unread, sk: sourceKey(source), what: describe(source, repo) };
}

export const keyFor = (repo, diff, model, language, preferences = "", task = null) =>
  cacheKey({ top: repo.top, source: diff.sk, model, language, preferences, files: diff.files, task: taskCacheKey(task) });

export async function transcriptMessages(top, since) {

  const prefix = projectSlug(top).slice(0, 120);
  const r = await exec("sh", ["-c", TRANSCRIPTS, prefix, String(Math.floor(since / 1000)), jsonPath(top)]).catch(() => null);
  return parseTranscript(r?.stdout ?? "", { top, since });
}

export const readPreferences = async () => (await readTextFile(`${dataDir()}/preferences.md`).catch(() => null)) ?? "";

export async function matters(top, paths, gitDir) {
  const candidates = worthReading(top, paths, gitDir);
  if (candidates === true) return true;
  if (!candidates.length) return false;
  const sample = candidates.slice(0, 200);
  const ignored = await git(exec, top, ["check-ignore", "--", ...sample]);

  if (ignored.code === 1) return true;
  if (!ignored.ok) return true;
  const out = new Set(ignored.out.split("\n").filter(Boolean));
  return sample.some((p) => !out.has(p)) || candidates.length > sample.length;
}

export async function findShown(repo, diff, key) {
  const exact = await readJson(entryPath(key));
  const place = placeKey(repo.top, diff.sk);
  if (exact?.version === VERSION) {
    await touch(entryPath(key));
    const pointer = await readJson(pointerPath(place));

    if (pointer?.key !== key) await write(pointerPath(place), JSON.stringify({ key, top: repo.top, source: diff.sk })).catch(() => undefined);
    return { entry: exact, exact: true };
  }
  const pointer = await readJson(pointerPath(place));
  const last = pointer?.key ? await readJson(entryPath(pointer.key)) : null;
  if (last?.version !== VERSION) return null;
  await touch(entryPath(pointer.key));
  return { entry: last, exact: false };
}

const touched = new Set();
async function touch(path) {
  if (touched.has(path)) return;
  touched.add(path);
  await exec("touch", [path]).catch(() => undefined);
}

export const hasEntry = async (key) => (await readJson(entryPath(key)))?.version === VERSION;

export const hookScript = () => {
  const path = `${appHome()}/mods/walkthrough/hooks/turn.sh`;
  return path.startsWith(`${home()}/`) ? `$HOME${path.slice(home().length)}` : path;
};

export async function turnsFolder(top) {
  const key = await turnsKey(exec, top);
  if (!key) return null;
  const dir = `${dataDir()}/turns/${key}`;
  await exec("mkdir", ["-p", dir]).catch(() => undefined);
  return dir;
}

export async function listTurns(folder, ends = {}) {
  if (!folder) return [];
  const r = await exec("sh", ["-c", LISTING, folder]).catch(() => null);
  return resolveEnds(parseListing(r?.stdout ?? "", folder), ends);
}

export async function closeTurn(top, turn) {
  const { tree, big } = await snapshotTree(exec, top, { index: `${turn.dir}/now.index`, objects: `${turn.dir}/objects` });
  await write(`${turn.dir}/end.big`, big.map((p) => `${p}\n`).join(""));
  await write(`${turn.dir}/end.meta`, `tree=${tree}\nended=${Math.floor(Date.now() / 1000)}\ninterrupted=1\n`);
}

export async function loadRead(top) {
  const read = await readJson(readPath(top));
  return read && typeof read === "object" && !Array.isArray(read) ? read : {};
}

export async function saveRead(top, read, keys) {
  await ensureDirs();
  const merged = mergeRead(await readJson(readPath(top)), read, keys);
  await write(readPath(top), JSON.stringify(merged));
  return merged;
}

export function preparePrompt(diff, { language, previous, preferences = "", task = null }) {
  return buildPrompt({ digest: diff.text, fileCount: diff.fileCount, hunkCount: diff.hunkCount, what: diff.what, language, previous, preferences, task });
}

export const promptChars = (p) => p.system.length + p.prompt.length;
export const fits = (p) => promptChars(p) <= MAX_PROMPT_CHARS;

export async function jobOf(repo, sk) {
  const dir = jobDir(placeKey(repo.top, sk));
  const meta = await readJson(`${dir}/meta.json`);
  if (!meta) return null;
  const code = await readTextFile(`${dir}/code`).catch(() => null);
  return { dir, meta, done: code !== null, code };
}

export async function startJob(repo, diff, { key, model, language, prompt, source, auto = false, before = [], task = null }) {
  await ensureDirs();
  const dir = jobDir(placeKey(repo.top, diff.sk));

  await stopRun(dir);
  await exec("rm", ["-rf", dir]);
  await exec("mkdir", ["-p", dir]);
  const meta = {
    key, code: codeKey(diff.files), model, language, top: repo.top, source, sk: diff.sk, started: Date.now(), deadline: Date.now() + deadline(diff.hunkCount),
    idByAlias: diff.idByAlias, digestFiles: diff.digestFiles, hunkCount: diff.hunkCount, auto, before,

    task: task ? { from: task.from, label: task.label, short: task.short, text: task.text, context: task.context ?? "", key: taskKey(task) } : null,
  };
  await writeTextFile(`${dir}/system.txt`, prompt.system, null);
  await writeTextFile(`${dir}/prompt.txt`, prompt.prompt, null);
  await writeTextFile(`${dir}/schema.json`, JSON.stringify(schemaFor(Boolean(task))), null);
  await writeTextFile(`${dir}/run.sh`, jobScript(), null);
  await writeTextFile(`${dir}/meta.json`, JSON.stringify(meta), null);

  const seconds = String(Math.ceil((meta.deadline - meta.started) / 1000));
  const launched = await exec("sh", ["-c", "nohup sh \"$0\" \"$1\" \"$2\" >/dev/null 2>&1 &", `${dir}/run.sh`, model, seconds]);
  if (launched.code !== 0) {
    await exec("rm", ["-rf", dir]);
    throw new Error((launched.stderr || launched.stdout || `sh exited with ${launched.code}`).trim());
  }
  return { dir, meta, done: false, code: null };
}

async function runPid(dir, known = null) {
  const pid = known ?? (await readTextFile(`${dir}/pid`).catch(() => null))?.trim();
  if (!pid || !/^\d+$/.test(pid)) return null;
  const r = await exec("ps", ["-o", "command=", "-p", pid]).catch(() => null);
  return r?.code === 0 && isRunCommand(r.stdout) ? pid : null;
}

async function stopRun(dir) {
  const pid = await runPid(dir);
  if (pid) await exec("kill", [pid]).catch(() => undefined);
}

export async function alive(job) {
  job.pid ??= (await readTextFile(`${job.dir}/pid`).catch(() => null))?.trim() || null;
  if (!job.pid) return Date.now() - job.meta.started < 10_000;
  return (await runPid(job.dir, job.pid)) !== null;
}

export async function endedJobs() {
  const r = await exec("sh", ["-c", 'for d in "$1"/*/; do case "$d" in *.taken-*) ;; *) [ -f "$d/code" ] && printf "%s\n" "${d%/}" ;; esac; done', "sh", `${dataDir()}/jobs`]).catch(() => null);
  const dirs = (r?.stdout ?? "").split("\n").filter(Boolean);
  const jobs = await Promise.all(dirs.map(async (dir) => {
    const meta = await readJson(`${dir}/meta.json`);
    const code = await readTextFile(`${dir}/code`).catch(() => null);
    return meta && code !== null ? { dir, meta, done: true, code } : null;
  }));
  return jobs.filter(Boolean);
}

export async function finished(job) {
  const code = await readTextFile(`${job.dir}/code`).catch(() => null);
  return code === null ? null : { ...job, done: true, code };
}

export async function cancelJob(job) {
  await stopRun(job.dir);
  await exec("rm", ["-rf", job.dir]);
}

export async function finishJob(job) {
  const claimed = `${job.dir}.taken-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const moved = await exec("mv", [job.dir, claimed]).catch(() => ({ code: 1 }));
  if (moved.code !== 0) return null;
  const read = (name) => readTextFile(`${claimed}/${name}`).catch(() => null);
  try {
    const { raw, cost } = readOutcome({ out: await read("out.json"), err: await read("err.txt"), code: job.code });
    const walkthrough = normalize(raw, job.meta.idByAlias, job.meta.digestFiles, { asks: Boolean(job.meta.task) });
    const { key, model, language, top, source, sk } = job.meta;

    const entry = { version: VERSION, key, code: job.meta.code, model, language, top, source, sk, generatedAt: Date.now(), took: Date.now() - job.meta.started, cost, walkthrough, before: job.meta.before ?? [], task: job.meta.task ?? null };
    await ensureDirs();
    await write(entryPath(key), JSON.stringify(entry));
    await write(pointerPath(placeKey(top, sk)), JSON.stringify({ key, top, source: sk }));
    await evict();
    return entry;
  } finally {
    await exec("rm", ["-rf", claimed]);
  }
}

async function evict() {
  await exec("sh", ["-c", `cd "$0" && ls -t -- *.json 2>/dev/null | tail -n +${MAX_ENTRIES + 1} | while read -r f; do rm -f -- "$f"; done`, `${dataDir()}/entries`]).catch(() => undefined);
}

export async function systemLocale() {
  const r = await exec("defaults", ["read", "-g", "AppleLanguages"]).catch(() => null);
  const first = /"?([A-Za-z]{2}[-_A-Za-z]*)"?/.exec(r?.stdout ?? "")?.[1];
  return first ?? (await exec("sh", ["-c", "echo ${LC_ALL:-${LANG:-}}"]).catch(() => null))?.stdout?.trim() ?? "";
}
