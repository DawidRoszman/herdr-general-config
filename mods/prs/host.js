// IO for the PR views. GitHub data comes from `mr` on the remote machine, whose gh has
// access to the repos: every call streams the multirepo mod's mr.py to python3 over ssh,
// as the multirepo dialog does.

import { exec, hc, appHome, run, spaces, focused, shared } from "herdr";
import { remoteCommand, reviewTab, reviewKey, projectSpace, worktreeOf, OPEN_REVIEWS } from "./model.js";

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
    ? ["python3", MR, ...args]
    : ["sh", "-c", 'ssh -o BatchMode=yes "$1" "$2" < "$3"', "sh", target, remoteCommand(args), MR];
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

export async function openUrl(url) {
  const r = await exec("open", [url]);
  if (r.code !== 0) throw new Error(`Could not open ${url}`);
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
