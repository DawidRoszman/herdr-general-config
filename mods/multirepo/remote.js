// IO shared by the multirepo dialog and the Projects tab: the `mr` CLI on a machine (this mod's
// mr.py streamed to python3 over ssh, so nothing has to be installed there), Herdr commands that
// answer with ids, hc's JSON, and opening a task's workspace.

import { exec, hc, appHome } from "herdr";
import { remoteCommand } from "./view.js";

export const MR = `${appHome()}/mods/multirepo/mr.py`;

export async function mrOn(target, args) {
  const r = await exec("sh", ["-c", 'ssh -o BatchMode=yes "$1" "$2" < "$3"', "sh", target, remoteCommand(args), MR]);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().replace(/^mr: /, "") || `mr ${args[0]} failed`);
  return r.stdout;
}

export async function mrJsonOn(target, args) {
  return JSON.parse(await mrOn(target, args));
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


// A new workspace's tabs, as in the `wts` tmux flow: claude, a terminal and nvim, in that order
// (new tabs go next to the selected one, so the order is set at the end). The agent-chat mod is
// not used for now. machine: a Herdr machine name, or null here.
export async function openWorkspace(folder, machine) {
  const { space, tab: claude } = await herdrDo("space.new", { folder, machine: machine ?? "", tab: "claude", argv: ["claude"] });
  const { tab: terminal } = await herdrDo("tab.new", { space, folder, name: "terminal" });
  const { tab: nvim } = await herdrDo("tab.new", { space, folder, name: "nvim", argv: ["nvim"] });
  for (const [index, id] of [claude, terminal, nvim].entries()) await herdrDo("tab.move", { id, index: index + 1 });
  await herdrDo("space.select", { id: space });
  await herdrDo("tab.select", { id: claude });
}

