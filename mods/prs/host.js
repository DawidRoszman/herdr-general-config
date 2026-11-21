import { exec, hc, appHome, run, spaces, focused, shared, openOverlay, window, agents } from "herdr";
import { remoteCommand, reviewTab, reviewKey, projectSpace, spaceAt, worktreeOf, machineLabel, OPEN_REVIEWS } from "./model.js";

const MR = `${appHome()}/mods/multirepo/mr.py`;

export const THIS_MAC = { name: null, target: null };

async function hcMachines() {
  const r = await hc(["machine", "ls", "--json"]);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || "hc machine ls failed");
  return JSON.parse(r.stdout).machines;
}

const isSandbox = (machine) => machine.via === true && String(machine.target).includes("sandbox-via.sh");

export async function connectedMachines() {
  return (await hcMachines()).filter((m) => !m.temporary && !isSandbox(m) && m.state === "connected");
}

async function sandboxSpace(machine, project, branch) {
  const sandboxes = new Set((await hcMachines()).filter(isSandbox).map((m) => m.name));
  for (const space of spaces().filter((s) => sandboxes.has(s.machine) && s.folder)) {
    const r = await exec("cat", [`${space.folder}/.mr-task.json`], { on: space.machine });
    if (r.code !== 0) continue;
    let task;
    try { task = JSON.parse(r.stdout); } catch { continue; }
    const isOnBranch = task.branch === branch || Object.values(task.branches ?? {}).includes(branch);
    if (task.host?.machine === machine && task.host?.project === project && isOnBranch) return space;
  }
  return null;
}

export async function sshTarget(machineName) {
  if (machineName === null) return null;
  const machine = (await connectedMachines()).find((m) => m.name === machineName);
  if (!machine) throw new Error(`${machineName} is not connected.`);
  return machine.target;
}

export function mrArgv(target, args) {
  return target === null
    ? [...python(), MR, ...args]
    : ["sh", "-c", 'ssh -o BatchMode=yes "$1" "$2" < "$3"', "sh", target, remoteCommand(args), MR];
}

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

async function checkoutOf(machine, repo, branch) {
  try {
    const r = await exec("git", ["-C", repo, "worktree", "list", "--porcelain"], { on: machine ?? undefined });
    return r.code === 0 ? worktreeOf(r.stdout, branch) : null;
  } catch {
    return null;
  }
}

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

async function herdrDo(command, args) {
  const r = await exec("herdr-app", ["do", command, JSON.stringify(args)]);
  let out = {};
  try { out = JSON.parse(r.stdout); } catch {  }
  if (r.code !== 0 || out.error) throw new Error(out.error || r.stderr.trim() || `${command} failed`);
  return out;
}

export async function openSpaceAt(machine, folder) {
  const space = spaceAt(spaces(), machine, folder);
  if (space) {
    run("space.select", { id: space.id });
    return space.id;
  }
  const { space: id, tab: terminal } = await herdrDo("space.new", { folder, machine: machine ?? "", tab: "terminal" });
  const { tab: claude } = await herdrDo("tab.new", { space: id, name: "claude", ...(shared("t3-chat.enabled") === false ? { folder, argv: ["claude"] } : { mod: "t3-chat", props: { view: "chat", folder, machine: machine ?? null } }) });
  const { tab: nvim } = await herdrDo("tab.new", { space: id, folder, name: "nvim", argv: ["nvim"] });
  for (const [index, tab] of [claude, terminal, nvim].entries()) await herdrDo("tab.move", { id: tab, index: index + 1 });
  await herdrDo("space.select", { id });
  await herdrDo("tab.select", { id: claude });
  return id;
}

async function taskFolder(target, project, branch) {
  const isOn = (t) => t.branch === branch || Object.values(t.branches ?? {}).includes(branch);
  return (await mrJson(target, ["ls", "--json", "--project", project])).tasks.find(isOn)?.root ?? null;
}

async function taskCheckoutOf(machine, project, branch) {
  try {
    return await taskFolder(await sshTarget(machine), project, branch);
  } catch {
    return null;
  }
}

export async function ensureTaskFolder(machine, project, branch, repos, report = () => {}) {
  const target = await sshTarget(machine);
  const taskOf = () => taskFolder(target, project, branch);
  const existing = await taskOf();
  if (existing) return existing;
  report(`Checking out ${branch} on ${machineLabel(machine)}…`);
  await mr(target, ["new", branch, ...repos, "--project", project]);
  const made = await taskOf();
  if (!made) throw new Error(`mr new did not make a task for ${branch}.`);
  return made;
}

export async function openBranchCheckout({ machine, project, branch, isRepo, repos }, report = () => {}) {
  if (!isRepo) {
    const sandbox = await sandboxSpace(machine, project, branch);
    if (sandbox) {
      run("space.select", { id: sandbox.id });
      return sandbox.id;
    }
    return openSpaceAt(machine, await ensureTaskFolder(machine, project, branch, repos, report));
  }
  const folder = await checkoutOf(machine, project, branch);
  if (folder) return openSpaceAt(machine, folder);
  report(`Fetching ${branch} on ${machineLabel(machine)}…`);
  await trackOriginBranch(machine, project, branch);
  openOverlay({ mod: "wt-dialog", kind: "dialog", width: 460, height: 280, props: { folder: project, machine, branch, action: "new" } });
}

const CLAUDE_START_MS = 30000;

export async function askClaude(checkout, prompt, wait, report = () => {}) {
  const space = await openBranchCheckout(checkout, report);
  if (!space) throw new Error("Make the branch's worktree in the dialog, then try again.");
  report("Waiting for Claude…");
  for (const start = Date.now(); Date.now() - start < CLAUDE_START_MS; await wait(500)) {
    const claude = agents().find((a) => a.space === space && a.app === "claude-code");
    if (!claude) continue;
    const r = await hc(["send", claude.address, prompt]);
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || "hc send failed");
    return;
  }
  throw new Error("No Claude Code in the branch's space: start one there, then try again.");
}

function openReviewTab(machine, project, branch) {
  const key = reviewKey(machine, project, branch);
  const published = shared(OPEN_REVIEWS) ?? {};
  return spaces().flatMap((s) => s.tabs).find((t) => published[t.id] === key);
}

export async function openReview(machine, project, branch, isRepo = false, name = "", branches = [branch], homeId = null) {
  const open = openReviewTab(machine, project, branch);
  if (open) return run("tab.select", { id: open.id });
  const published = shared(OPEN_REVIEWS) ?? {};
  const tab = reviewTab(machine, project, branch, isRepo, branches);
  const home = spaces().find((s) => s.id === homeId) ?? await branchSpace(machine, project, branch, isRepo, name);
  if (home && home.id !== focused()?.space) run("space.select", { id: home.id });

  const named = home?.tabs.find((t) => t.name === tab.name && !published[t.id]);
  if (named) run("tab.select", { id: named.id });
  else run("tab.new", { ...tab, ...(home ? { space: home.id } : {}) });
}

async function branchSpace(machine, project, branch, isRepo, name) {
  const sandbox = isRepo ? null : await sandboxSpace(machine, project, branch);
  if (sandbox) return sandbox;
  const checkout = await (isRepo ? checkoutOf : taskCheckoutOf)(machine, project, branch);
  return projectSpace(spaces(), { machine, root: project, name, branch, checkout }) ?? spaces().find((s) => s.id === focused()?.space);
}

export function reviewCommand(machine, project, branch, isRepo = false, name = "", checkout = null) {
  const open = openReviewTab(machine, project, branch);
  if (open) return { name: "tab.select", args: { id: open.id } };
  const home = projectSpace(spaces(), { machine, root: project, name, branch, checkout });
  return { name: "tab.new", args: { ...reviewTab(machine, project, branch, isRepo), ...(home ? { space: home.id } : {}) } };
}
