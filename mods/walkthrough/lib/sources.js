import { firstLine } from "./turns.js";

const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.quotePath=false", "-c", "diff.autoRefreshIndex=false"];

const DIFF = ["--no-color", "--no-ext-diff", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/", "-M"];
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const MAX_UNTRACKED = 300;
export const MAX_UNTRACKED_BYTES = 1024 * 1024;

export const SCOPES = [
  { key: "uncommitted", label: "Uncommitted", about: "Everything not committed yet: staged, unstaged and new files" },
  { key: "staged", label: "Staged", about: "What the next commit would hold" },
  { key: "unstaged", label: "Unstaged", about: "The working tree and new files, not staged" },
  { key: "branch", label: "Branch", about: "Everything this branch adds to its base, committed or not" },
  { key: "commit", label: "Commit", about: "One commit, against its first parent" },
  { key: "pr", label: "Pull request", about: "An open pull request on GitHub, as GitHub shows its changes (needs gh)" },
  { key: "turn", label: "Last turn", about: "What an agent changed while answering one prompt (needs the turn hooks)" },
];

export async function git(exec, cwd, args) {
  const r = await exec("git", [...READ, ...args], { cwd });
  return { ok: r.code === 0, code: r.code, out: r.stdout ?? "", err: (r.stderr || "").trim() };
}

async function must(exec, cwd, args) {
  const r = await git(exec, cwd, args);
  if (!r.ok) throw new Error(r.err || `git ${args[0]} failed`);
  return r.out;
}

export async function repoAt(exec, folder) {
  const top = await git(exec, folder, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) return null;
  const root = top.out.trim();
  const head = await git(exec, root, ["rev-parse", "--verify", "-q", "HEAD"]);
  const branch = (await git(exec, root, ["branch", "--show-current"])).out.trim();

  const gitDir = (await git(exec, root, ["rev-parse", "--absolute-git-dir"])).out.trim();
  return { top: root, name: root.split("/").pop(), branch: branch || null, born: head.ok, gitDir: gitDir || `${root}/.git` };
}

export async function currentHead(exec, top) {
  const branch = (await git(exec, top, ["branch", "--show-current"])).out.trim();
  if (branch) return branch;
  const short = (await git(exec, top, ["rev-parse", "--short", "HEAD"])).out.trim();
  return short ? `HEAD@${short}` : "HEAD";
}

export function sourceKey(source) {

  if (source.kind === "branch") return `branch:${source.base}...${source.head ?? "HEAD"}`;
  if (source.kind === "commit") return `commit:${source.hash}`;

  if (source.kind === "pr") return `pr:${source.number}`;
  if (source.kind === "prs") return `prs:${source.key}`;
  if (source.kind === "turn") return `turn:${source.id}`;
  return source.kind;
}

export function describe(source, repo) {
  switch (source.kind) {
    case "uncommitted": return "Uncommitted local changes, staged and unstaged, with new files.";
    case "staged": return "Staged changes: what the next commit would hold.";
    case "unstaged": return "Unstaged changes in the working tree, with new files.";
    case "branch": return `Everything branch "${source.head ?? repo?.branch ?? "HEAD"}" adds to "${source.base}", committed or not. Work that came in from ${source.base} is left out.`;
    case "commit": return `Commit ${source.hash.slice(0, 12)}${source.subject ? ` ("${source.subject}")` : ""}, against its first parent.`;
    case "turn": return `One turn of a coding agent: what changed in the working tree while it answered the prompt "${firstLine(source.prompt, 160)}"${source.endTree ? "" : " (still running: read up to now)"}.`;
    case "prs": return describePullRequests(source.prs);
    case "pr": return `Pull request #${source.number}${source.title ? ` ("${source.title}")` : ""}${source.head && source.base ? `, "${source.head}" into "${source.base}"` : ""}, as GitHub shows its changes.`;
    default: return "Local changes.";
  }
}

export function shortLabel(source, top = "") {
  const repo = String(top).startsWith("prs:") ? "" : String(top).split("/").pop();
  const what = (() => {
    switch (source?.kind) {
      case "prs": return (source.prs ?? []).map((p) => `${p.prefix ? `${p.prefix} ` : ""}#${p.number}`).join(" · ");
      case "pr": return `#${source.number}${source.title ? ` ${source.title}` : ""}`;
      case "branch": return `${source.head ?? "HEAD"} vs ${source.base}`;
      case "commit": return `${String(source.hash).slice(0, 7)}${source.subject ? ` ${source.subject}` : ""}`;
      case "turn": return `last turn "${firstLine(source.prompt, 60) || "(empty prompt)"}"`;
      default: return SCOPES.find((s) => s.key === source?.kind)?.label.toLowerCase() ?? "changes";
    }
  })();
  return repo ? `${repo}: ${what}` : what;
}

function describePullRequests(prs) {
  const one = (p) => `${p.prefix ? `${p.prefix}: ` : ""}#${p.number}${p.title ? ` ("${p.title}")` : ""}${p.head && p.base ? `, "${p.head}" into "${p.base}"` : ""}`;
  if (prs.length === 1) return `Pull request ${one(prs[0])}, as GitHub shows its changes.`;
  return `${prs.length} linked pull requests of one change across repositories, read as one: ${prs.map(one).join("; ")}. Each path starts with its repository. As GitHub shows their changes.`;
}

const memo = new Map();
const MEMO_LIMIT = 4000;

export async function untracked(exec, top) {
  const list = await must(exec, top, ["ls-files", "--others", "--exclude-standard", "-z"]);
  const paths = list.split("\0").filter(Boolean);
  const unread = paths.slice(MAX_UNTRACKED).map((path) => ({ path, why: `Not read: more than ${MAX_UNTRACKED} new files.` }));
  const take = paths.slice(0, MAX_UNTRACKED);
  if (!take.length) return { patches: [], unread };

  const results = new Array(take.length).fill(null);
  const queue = await stamps(exec, top, take);
  const problems = new Array(take.length).fill(null);
  const worker = async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      if (!(item.size >= 0)) { problems[item.i] = "Not read: it can't be opened."; continue; }
      if (item.size > MAX_UNTRACKED_BYTES) { problems[item.i] = "Not read: larger than 1 MB."; continue; }
      const key = `${top}\0${item.path}`;
      const known = memo.get(key);
      if (known && known.stamp === item.stamp) { results[item.i] = known.patch; continue; }

      const r = await git(exec, top, ["diff", "--no-index", ...DIFF, "--", "/dev/null", item.path]);
      if (r.code <= 1) {
        results[item.i] = r.out;
        if (memo.size >= MEMO_LIMIT) memo.clear();
        memo.set(key, { stamp: item.stamp, patch: r.out });
      } else problems[item.i] = `Not read: ${r.err || "git diff failed"}`;
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, queue.length) }, worker));

  const patches = results.filter((p) => typeof p === "string" && p.trim());
  take.forEach((path, i) => { if (problems[i]) unread.push({ path, why: problems[i] }); });
  return { patches, unread };
}

async function stamps(exec, top, paths) {
  const stats = await exec("sh", ["-c", "for f; do s=$(stat -c '%s %.9Y' \"$f\" 2>/dev/null || stat -f '%z %Fm' \"$f\" 2>/dev/null) || s=-1; echo \"${s:--1}\"; done", "sh", ...paths], { cwd: top });
  const lines = (stats.stdout ?? "").split("\n");
  return paths.map((path, i) => {
    const stamp = (lines[i] ?? "-1").trim();
    return { path, i, stamp, size: Number(stamp.split(" ")[0]) };
  });
}

export async function snapshotTree(exec, top, { index, objects }) {
  const real = (await must(exec, top, ["rev-parse", "--path-format=absolute", "--git-path", "index"])).trim();
  const big = await largeUntracked(exec, top);
  const env = [`GIT_INDEX_FILE=${index}`, `GIT_OBJECT_DIRECTORY=${objects}`];
  const run = async (args) => {
    const r = await exec("env", [...env, "git", "-c", "core.fsmonitor=false", "-c", "gc.auto=0", "-c", "maintenance.auto=false", ...args], { cwd: top });
    if (r.code !== 0) throw new Error((r.stderr || `git ${args[0]} failed`).trim());
    return (r.stdout ?? "").trim();
  };
  const snap = async (copy) => {

    if (copy) await exec("sh", ["-c", '[ -f "$1" ] || [ ! -f "$0" ] || cp -p "$0" "$1"', real, index]);

    if (big.length) await run(["update-index", "--force-remove", "--", ...big]);
    await run(["add", "-A", "--", ".", ...big.map((p) => `:(exclude,literal)${p}`)]);
    return run(["write-tree", "--missing-ok"]);
  };
  await exec("mkdir", ["-p", objects]);
  let tree;
  try { tree = await snap(true); } catch {

    await exec("rm", ["-f", index]);
    tree = await snap(false).catch(async (e) => { await exec("rm", ["-f", index]); throw e; });
  }
  return { tree, big };
}

async function largeUntracked(exec, top) {
  const script = `git ${READ.join(" ")} ls-files --others --exclude-standard -z | xargs -0 sh -c '[ $# -gt 0 ] && find "$@" -prune -type f -size +${MAX_UNTRACKED_BYTES}c' sh; exit 0`;
  const r = await exec("sh", ["-c", script], { cwd: top });
  return (r.stdout ?? "").split("\n").filter(Boolean);
}

export async function turnsKey(exec, top) {
  const r = await exec("sh", ["-c", 'printf %s "$0" | git hash-object --stdin', top], { cwd: top });
  const key = (r.stdout ?? "").trim().slice(0, 16);
  return r.code === 0 && /^[0-9a-f]{16}$/.test(key) ? key : null;
}

export function worthReading(top, paths, gitDir = `${top}/.git`) {
  const out = [];
  for (const path of paths ?? []) {

    if (gitDir !== `${top}/.git` && path.startsWith(`${gitDir}/`)) {
      if (/^(index|HEAD|logs\/HEAD|refs\/)/.test(path.slice(gitDir.length + 1))) return true;
      continue;
    }
    if (!path.startsWith(`${top}/`)) return true;
    const rel = path.slice(top.length + 1);
    if (rel === ".git" || rel.startsWith(".git/")) {
      if (/^\.git\/(index|HEAD|packed-refs|refs\/)/.test(rel)) return true;
      continue;
    }
    if (/(^|\/)node_modules(\/|$)/.test(rel)) continue;
    out.push(rel);
  }
  return out;
}

export async function loadSections(exec, top, source) {
  const sections = [];
  let unread = [];
  const add = (scope, ...patches) => {
    const patch = patches.filter((p) => p && p.trim()).join("\n");
    if (patch.trim()) sections.push({ scope, patch });
  };
  const withUntracked = async (scope, patch) => {
    const u = await untracked(exec, top);
    unread = u.unread;
    add(scope, patch, ...u.patches);
  };

  switch (source.kind) {
    case "uncommitted":
      add("staged", await must(exec, top, ["diff", "--cached", ...DIFF]));
      await withUntracked("working", await must(exec, top, ["diff", ...DIFF]));
      break;
    case "staged":
      add("staged", await must(exec, top, ["diff", "--cached", ...DIFF]));
      break;
    case "unstaged":
      await withUntracked("working", await must(exec, top, ["diff", ...DIFF]));
      break;
    case "branch": {

      const base = (await must(exec, top, ["merge-base", source.base, "HEAD"])).trim();
      await withUntracked("branch", await must(exec, top, ["diff", ...DIFF, base]));
      break;
    }
    case "commit": {
      const parents = (await must(exec, top, ["rev-list", "--parents", "-n", "1", source.hash])).trim().split(" ");
      add("commit", await must(exec, top, ["diff", ...DIFF, parents[1] ?? EMPTY_TREE, source.hash]));
      break;
    }
    case "pr":
      add("pr", await gh(exec, top, ["pr", "diff", String(source.number), "--color=never"]));
      break;
    case "prs":
      sections.push(...await pullRequestSections(exec, source.prs));
      break;
    case "turn": {

      let end = source.endTree, big = source.endBig ?? [];
      if (!end) ({ tree: end, big } = await snapshotTree(exec, top, { index: `${source.dir}/now.index`, objects: `${source.dir}/objects` }));
      const objects = [...new Set([source.dir, source.endDir ?? source.dir])].map((d) => `${d}/objects`).join(":");

      const left = big.map((p) => `:(exclude,literal)${p}`);
      const r = await exec("env", [`GIT_ALTERNATE_OBJECT_DIRECTORIES=${objects}`, "git", ...READ, "diff", ...DIFF, source.startTree, end, ...(left.length ? ["--", ".", ...left] : [])], { cwd: top });
      const before = new Set(source.startBig ?? []);
      unread = big.filter((p) => !before.has(p)).map((path) => ({ path, why: "Not read: larger than 1 MB." }));
      if (r.code !== 0) throw new Error(await snapshotsGone(exec, top, source, r.stderr) ?? (r.stderr || "git diff failed").trim());
      add("turn", r.stdout ?? "");
      break;
    }
    default:
      throw new Error(`Unknown source "${source.kind}"`);
  }
  return { sections, unread };
}

async function snapshotsGone(exec, top, source, stderr) {
  if (!/bad object|not a tree|could not read|unable to read/i.test(stderr ?? "")) return null;
  const dirs = [...new Set([source.dir, source.endDir ?? source.dir])];
  const r = await exec("sh", ["-c", 'for d; do [ -d "$d/objects" ] || exit 1; done', "sh", ...dirs], { cwd: top });
  return r.code !== 0
    ? "This turn's snapshots are gone: only the newest 20 turns are kept."
    : "Part of this turn is gone from the repository: its snapshots point at file contents git keeps there, and git gc has removed some that no commit or index still names.";
}

export async function defaultBase(exec, top, current) {
  const head = await git(exec, top, ["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"]);
  const candidates = [head.ok ? head.out.trim() : "", "origin/main", "origin/master", "main", "master", "trunk", "develop"].filter(Boolean);
  for (const ref of candidates) {
    if (ref === current || ref === `origin/${current}`) continue;
    if ((await git(exec, top, ["rev-parse", "--verify", "-q", `${ref}^{commit}`])).ok) return ref;
  }
  return null;
}

export async function baseChoices(exec, top, current) {
  const r = await git(exec, top, ["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads", "refs/remotes"]);
  return r.out.split("\n").map((s) => s.trim()).filter((s) => s && s !== current && !s.endsWith("/HEAD") && s !== "origin");
}

export async function recentCommits(exec, top, count = 40) {
  const r = await git(exec, top, ["log", `-n${count}`, "--format=%H%x1f%h%x1f%s%x1f%an%x1f%cr"]);
  if (!r.ok) return [];
  return r.out.split("\n").filter(Boolean).map((line) => {
    const [hash, short, subject, author, when] = line.split("\x1f");
    return { hash, short, subject, author, when };
  });
}

export async function pullRequestSections(exec, prs) {
  const read = async (pr) => {
    const [command, ...args] = pr.diff;
    const r = await exec(command, args);
    if (r.code !== 0) throw new Error(`${pr.prefix ? `${pr.prefix} ` : ""}#${pr.number}: ${ghError(r.stderr || r.stdout)}`);
    return { scope: `pr:${pr.prefix || pr.number}`, patch: r.stdout ?? "", prefix: pr.prefix || "" };
  };
  return (await Promise.all(prs.map(read))).filter((section) => section.patch.trim());
}

async function gh(exec, top, args) {
  const r = await runGh(exec, top, args);
  if (r.code !== 0) throw new Error(ghError(r.stderr || r.stdout));
  return r.stdout ?? "";
}

export async function runGh(exec, top, args) {
  try {
    const r = await exec("direnv", ["exec", top, "gh", ...args], { cwd: top });
    if (r.code !== 127) return r;
  } catch {  }
  try { return await exec("gh", args, { cwd: top }); } catch { throw new Error(GH_MISSING); }
}

const GH_MISSING = "Pull requests are read with the GitHub CLI (gh), and it isn't installed. Install it, then run gh auth login.";

export function ghError(text) {
  const t = String(text ?? "").trim();
  if (/gh auth login|not logged in|authentication/i.test(t)) return "The GitHub CLI isn't logged in. Run gh auth login, then try again.";
  if (/no git remotes|none of the git remotes|not a github|could not determine base repo/i.test(t)) return "This repository has no GitHub remote, so it has no pull requests to read.";
  if (/HTTP 406|too_large|diff exceeded|maximum number of (lines|files)/i.test(t)) return "GitHub won't send a diff this large (about 300 files or 20,000 lines). Read it as a Branch instead.";
  if (/could not resolve to a pullrequest|no pull requests? found/i.test(t)) return "That pull request wasn't found.";
  return t.split("\n").filter(Boolean).pop() || "gh failed.";
}

export async function pullRequests(exec, top, branch = null) {
  const out = await gh(exec, top, ["pr", "list", "--state", "open", "--limit", "50", "--json", "number,title,body,headRefName,baseRefName,author,isDraft,updatedAt"]);
  let list;
  try { list = JSON.parse(out || "[]"); } catch { throw new Error("gh answered with something other than a list of pull requests."); }
  return list
    .map((p) => ({ number: p.number, title: p.title ?? "", body: typeof p.body === "string" ? p.body : "", head: p.headRefName ?? "", base: p.baseRefName ?? "", author: p.author?.login ?? "",
      draft: Boolean(p.isDraft), updated: p.updatedAt ?? "", current: Boolean(branch) && p.headRefName === branch }))
    .sort((a, b) => b.updated.localeCompare(a.updated));
}

export async function commitMessage(exec, top, hash) {
  const r = await git(exec, top, ["log", "-1", "--format=%B", hash, "--"]);
  return r.ok ? r.out.trim() : null;
}

export async function taskSince(exec, top, source) {
  let at = "HEAD", label = "the last commit";
  if (source.kind === "branch") {
    const base = await git(exec, top, ["merge-base", source.base, "HEAD"]);
    if (base.ok && base.out.trim()) { at = base.out.trim(); label = `the branch left ${source.base}`; }
  }
  const r = await git(exec, top, ["log", "-1", "--format=%ct", at, "--"]);
  const seconds = r.ok ? Number(r.out.trim()) : 0;
  return { since: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0, label: seconds > 0 ? label : "the repository began" };
}
