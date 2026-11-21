import { exec, hc, appHome, window, spaces, panes, run, shared } from "herdr";
import { remoteCommand } from "./view.js";

export const MR = `${appHome()}/mods/multirepo/mr.py`;

export const THIS_MAC = { name: null, label: "This Mac", target: null, state: "connected" };

export async function machinesWithThisMac() {
  const offMachines = new Set(shared("context")?.offMachines ?? []);
  return [THIS_MAC, ...(await hcJson(["machine", "ls", "--json"])).machines.filter((m) => !m.temporary && !offMachines.has(m.name) && !(m.via === true && String(m.target).includes("sandbox-via.sh")))];
}

export function machineLabel(machine) {
  return machine.label ?? machine.name;
}

export function python() {
  return window()?.platform === "windows" ? ["py", "-3"] : ["python3"];
}

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

export function closeSpacesOn(machine, folder) {
  for (const s of spaces()) {
    const isOnFolder = s.folder === folder || Boolean(s.folder?.startsWith(`${folder}/`));
    if ((s.machine ?? null) === (machine ?? null) && isOnFolder) run("space.close", { id: s.id, confirmed: true });
  }
}

export async function herdrDo(command, args) {
  const r = await exec("herdr-app", ["do", command, JSON.stringify(args)]);
  let out = {};
  try { out = JSON.parse(r.stdout); } catch {  }
  if (r.code !== 0 || out.error) throw new Error(out.error || r.stderr.trim() || `${command} failed`);
  return out;
}

export async function hcJson(args) {
  const r = await hc(args);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `hc ${args[0]} failed`);
  return JSON.parse(r.stdout);
}

export function reviewTab(machine, project, branch) {
  const name = `PR ${branch.match(/[A-Z][A-Z0-9]*-\d+/)?.[0] ?? branch.replace(/^[a-z]+\//, "")}`;
  return { name, mod: "prs", props: { view: "review", machine, project, branch } };
}

export function workspaceOf(folder, machine) {
  const tabs = new Map(spaces().filter((s) => (s.machine ?? null) === (machine ?? null)).flatMap((s) => s.tabs.map((t) => [t.id, s])));
  const pane = panes().find((p) => tabs.has(p.tab) && (p.cwd === folder || Boolean(p.cwd?.startsWith(`${folder}/`))));
  return pane ? tabs.get(pane.tab) : null;
}

export async function openWorkspace(folder, machine) {
  const open = workspaceOf(folder, machine);
  if (open) {
    run("space.select", { id: open.id });
    return;
  }

  const { space, tab: terminal } = await herdrDo("space.new", { folder, machine: machine ?? "", tab: "terminal" });
  const { tab: claude } = await herdrDo("tab.new", { space, name: "claude", ...(shared("t3-chat.enabled") === false ? { folder, argv: ["claude"] } : { mod: "t3-chat", props: { view: "chat", folder, machine: machine ?? null } }) });
  const { tab: nvim } = await herdrDo("tab.new", { space, folder, name: "nvim", argv: ["nvim"] });
  for (const [index, id] of [claude, terminal, nvim].entries()) await herdrDo("tab.move", { id, index: index + 1 });
  await herdrDo("space.select", { id: space });
  await herdrDo("tab.select", { id: claude });
}
