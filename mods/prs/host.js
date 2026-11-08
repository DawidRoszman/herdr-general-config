// IO for the PR views. GitHub data comes from `mr` on the remote machine, whose gh has
// access to the repos: every call streams the multirepo mod's mr.py to python3 over ssh,
// as the multirepo dialog does.

import { exec, hc, appHome, run, spaces, focused, shared, openOverlay, window } from "herdr";
import { remoteCommand, reviewTab, reviewKey, projectSpace, spaceAt, worktreeOf, machineLabel, OPEN_REVIEWS } from "./model.js";

const MR = `${appHome()}/mods/multirepo/mr.py`;

// This Mac: its spaces have machine null, and mr runs here without ssh.
export const THIS_MAC = { name: null, target: null };

export async function connectedMachines() {
  const r = await hc(["machine", "ls", "--json"]);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || "hc machine ls failed");
  return JSON.parse(r.stdout).machines.filter((m) => !m.temporary && m.state === "connected");
}

export async function sshTarget(machineName) {
  if (machineName === null) return null;
  const machine = (await connectedMachines()).find((m) => m.name === machineName);
  if (!machine) throw new Error(`${machineName} is not connected.`);
  return machine.target;
}

// The command line that runs `mr <args>` on target (here when null): for mr() and for other mods
// that run it themselves, like the walkthrough reading a PR's diff.
export function mrArgv(target, args) {
  return target === null
    ? [...python(), MR, ...args]
    : ["sh", "-c", 'ssh -o BatchMode=yes "$1" "$2" < "$3"', "sh", target, remoteCommand(args), MR];
}

// Python 3 here: Windows has the py launcher (its python3 can be the Store's stub), elsewhere python3.
function python() {
  return window()?.platform === "windows" ? ["py", "-3"] : ["python3"];
}

export async function mr(target, args) {
  const [command, ...argv] = mrArgv(target, args);
  const r = await exec(command, argv);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().replace(/^mr: /, "") || `mr ${args[0]} failed`);
  return r.stdout;
}

export async function mrJson(target, args) {
  return JSON.parse(await mr(target, args));
}

// Where a plain repo has the branch checked out (a worktree can be anywhere), on its machine; null when
// it isn't, or git can't say. A multirepo task's folder is found by its name instead (projectSpace).
async function checkoutOf(machine, repo, branch) {
  try {
    const r = await exec("git", ["-C", repo, "worktree", "list", "--porcelain"], { on: machine ?? undefined });
    return r.code === 0 ? worktreeOf(r.stdout, branch) : null;
  } catch {
    return null;
  }
}

// A local branch tracking origin's, so a worktree can check it out: a PR's branch is often only on
// origin here. Nothing to do when the branch is local already.
async function trackOriginBranch(machine, repo, branch) {
  const git = async (args) => {
    const r = await exec("git", ["-C", repo, ...args], { on: machine ?? undefined });
    return { isOk: r.code === 0, message: (r.stderr || r.stdout).trim() };
  };
  if ((await git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).isOk) return;
  const fetched = await git(["fetch", "--quiet", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
  if (!fetched.isOk) throw new Error(`Could not fetch ${branch} from origin: ${fetched.message}`);
  const made = await git(["branch", "--quiet", "--track", branch, `origin/${branch}`]);
  if (!made.isOk) throw new Error(`Could not make a local ${branch}: ${made.message}`);
}

// `herdr-app do` answers with the ids it made; run() does not.
async function herdrDo(command, args) {
  const r = await exec("herdr-app", ["do", command, JSON.stringify(args)]);
  let out = {};
  try { out = JSON.parse(r.stdout); } catch { /* reported below with stderr */ }
  if (r.code !== 0 || out.error) throw new Error(out.error || r.stderr.trim() || `${command} failed`);
  return out;
}

// The space already on folder, else a new one there with the wts tabs (claude, terminal, nvim), as
// multirepo/remote.js and wt-dialog open a workspace (mods can't import across folders).
export async function openSpaceAt(machine, folder) {
  const space = spaceAt(spaces(), machine, folder);
  if (space) return run("space.select", { id: space.id });
  const { space: id, tab: claude } = await herdrDo("space.new", { folder, machine: machine ?? "", tab: "claude", argv: ["claude"] });
  const { tab: terminal } = await herdrDo("tab.new", { space: id, folder, name: "terminal" });
  const { tab: nvim } = await herdrDo("tab.new", { space: id, folder, name: "nvim", argv: ["nvim"] });
  for (const [index, tab] of [claude, terminal, nvim].entries()) await herdrDo("tab.move", { id: tab, index: index + 1 });
  await herdrDo("space.select", { id });
  await herdrDo("tab.select", { id: claude });
}

// A multirepo task's folder for branch, made with mr new on repos (their short names) when missing;
// a branch another tool already has checked out is linked, not checked out again. report: progress.
export async function ensureTaskFolder(machine, project, branch, repos, report = () => {}) {
  const target = await sshTarget(machine);
  const taskOf = async () => (await mrJson(target, ["ls", "--json", "--project", project])).tasks.find((t) => t.branch === branch)?.root;
  const existing = await taskOf();
  if (existing) return existing;
  report(`Checking out ${branch} on ${machineLabel(machine)}…`);
  await mr(target, ["new", branch, ...repos, "--project", project]);
  const made = await taskOf();
  if (!made) throw new Error(`mr new did not make a task for ${branch}.`);
  return made;
}

// A PR branch's checkout in a space (the one already on it, else a new one), for the review tab and
// the sidebar: the multirepo task (ensureTaskFolder), or the plain repo's worktree. A plain repo
// without one gets it from the worktree dialog, made where the project's wt config says, from
// origin's branch. report: progress lines for the slow steps.
export async function openBranchCheckout({ machine, project, branch, isRepo, repos }, report = () => {}) {
  if (!isRepo) return openSpaceAt(machine, await ensureTaskFolder(machine, project, branch, repos, report));
  const folder = await checkoutOf(machine, project, branch);
  if (folder) return openSpaceAt(machine, folder);
  report(`Fetching ${branch} on ${machineLabel(machine)}…`);
  await trackOriginBranch(machine, project, branch);
  openOverlay({ mod: "wt-dialog", kind: "dialog", width: 460, height: 280, props: { folder: project, machine, branch, action: "new" } });
}

// The branch's review tab: the one already open in any space (it goes there), else a new one in the
// project's space (projectSpace: name is the project's or repo's name), else in the shown space.
export async function openReview(machine, project, branch, isRepo = false, name = "", branches = [branch]) {
  const key = reviewKey(machine, project, branch);
  const published = shared(OPEN_REVIEWS) ?? {};
  for (const space of spaces()) {
    const open = space.tabs.find((t) => published[t.id] === key);
    if (open) {
      run("space.select", { id: space.id });
      run("tab.select", { id: open.id });
      return;
    }
  }
  const tab = reviewTab(machine, project, branch, isRepo, branches);
  const checkout = isRepo ? await checkoutOf(machine, project, branch) : null;
  const home = projectSpace(spaces(), { machine, root: project, name, branch, checkout }) ?? spaces().find((s) => s.id === focused()?.space);
  if (home && home.id !== focused()?.space) run("space.select", { id: home.id });
  // A review tab opened before tabs published themselves: found by its name, in that space. Not one
  // published for another branch: several branches share a name (PR SHOP-110).
  const named = home?.tabs.find((t) => t.name === tab.name && !published[t.id]);
  if (named) run("tab.select", { id: named.id });
  else run("tab.new", { ...tab, ...(home ? { space: home.id } : {}) });
}

// The command that opens a PR's review in its project's space (for a notification's action).
export function reviewCommand(machine, project, branch, isRepo = false, name = "") {
  const home = projectSpace(spaces(), { machine, root: project, name, branch });
  return { name: "tab.new", args: { ...reviewTab(machine, project, branch, isRepo), ...(home ? { space: home.id } : {}) } };
}
