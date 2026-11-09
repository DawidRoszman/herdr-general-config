// IO shared by the multirepo dialog and the Projects tab: the `mr` CLI on a machine (this mod's
// mr.py run by python3 here, or streamed to python3 over ssh, so nothing has to be installed there),
// Herdr commands that answer with ids, hc's JSON, and opening a task's workspace.

import { exec, hc, appHome, window, spaces, panes, run } from "herdr";
import { remoteCommand } from "./view.js";

export const MR = `${appHome()}/mods/multirepo/mr.py`;

// This Mac as a machine: its spaces have machine null, and mr runs here without ssh.
export const THIS_MAC = { name: null, label: "This Mac", target: null, state: "connected" };

// Herdr's ssh machines, this Mac first.
export async function machinesWithThisMac() {
  return [THIS_MAC, ...(await hcJson(["machine", "ls", "--json"])).machines.filter((m) => !m.temporary)];
}

export function machineLabel(machine) {
  return machine.label ?? machine.name;
}

// Python 3 here: Windows has the py launcher (its python3 can be the Store's stub), elsewhere python3.
export function python() {
  return window()?.platform === "windows" ? ["py", "-3"] : ["python3"];
}

// The command line that runs `mr <args>` on target: python3 on this copy here when null, else over ssh.
export function mrArgv(target, args) {
  return target === null
    ? [...python(), MR, ...args]
    : ["sh", "-c", 'ssh -o BatchMode=yes "$1" "$2" < "$3"', "sh", target, remoteCommand(args), MR];
}

export async function mrOn(target, args) {
  const [command, ...argv] = mrArgv(target, args);
  const r = await exec(command, argv);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().replace(/^mr: /, "") || `mr ${args[0]} failed`);
  return r.stdout;
}

export async function mrJsonOn(target, args) {
  return JSON.parse(await mrOn(target, args));
}

// Closes a removed task's spaces (on its folder or inside it). The sidebar shows its project's space after.
export function closeSpacesOn(machine, folder) {
  for (const s of spaces()) {
    const isOnFolder = s.folder === folder || Boolean(s.folder?.startsWith(`${folder}/`));
    if ((s.machine ?? null) === (machine ?? null) && isOnFolder) run("space.close", { id: s.id, confirmed: true });
  }
}

// `herdr-app do` answers with the ids it made; run() does not.
export async function herdrDo(command, args) {
  const r = await exec("herdr-app", ["do", command, JSON.stringify(args)]);
  let out = {};
  try { out = JSON.parse(r.stdout); } catch { /* reported below with stderr */ }
  if (r.code !== 0 || out.error) throw new Error(out.error || r.stderr.trim() || `${command} failed`);
  return out;
}

export async function hcJson(args) {
  const r = await hc(args);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `hc ${args[0]} failed`);
  return JSON.parse(r.stdout);
}

// The prs mod's review tab for a branch (its spec is prs/model.js reviewTab; mods can't import across folders).
export function reviewTab(machine, project, branch) {
  const name = `PR ${branch.match(/[A-Z][A-Z0-9]*-\d+/)?.[0] ?? branch.replace(/^[a-z]+\//, "")}`;
  return { name, mod: "prs", props: { view: "review", machine, project, branch } };
}


// The task's workspace: the space already on its folder (a pane working in it), else a new one with
// claude, a terminal and nvim, in that order, as in the `wts` tmux flow (new tabs go next to the
// selected one, so the order is set at the end). machine: a Herdr machine name, or null here.
export async function openWorkspace(folder, machine) {
  const tabs = new Map(spaces().filter((s) => (s.machine ?? null) === (machine ?? null)).flatMap((s) => s.tabs.map((t) => [t.id, s])));
  const pane = panes().find((p) => p.cwd?.startsWith(folder) && tabs.has(p.tab));
  if (pane) {
    run("space.select", { id: tabs.get(pane.tab).id });
    return;
  }
  const { space, tab: claude } = await herdrDo("space.new", { folder, machine: machine ?? "", tab: "claude", argv: ["claude"] });
  const { tab: terminal } = await herdrDo("tab.new", { space, folder, name: "terminal" });
  const { tab: nvim } = await herdrDo("tab.new", { space, folder, name: "nvim", argv: ["nvim"] });
  for (const [index, id] of [claude, terminal, nvim].entries()) await herdrDo("tab.move", { id, index: index + 1 });
  await herdrDo("space.select", { id: space });
  await herdrDo("tab.select", { id: claude });
}

