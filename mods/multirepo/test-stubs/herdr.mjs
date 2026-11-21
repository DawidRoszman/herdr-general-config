import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";

export const state = {
  home: process.env.HOME,
  props: {},
  shared: {},
  runs: [],
  overlays: [],
  herdrDo: [],
  closedOverlays: [],
  terminals: [],
};

export const props = () => state.props;
export const closeOverlay = (id) => state.closedOverlays.push(id);
export const openOverlay = (spec) => { state.overlays.push(spec); return "ov1"; };
export const theme = () => new Proxy({}, { get: (_t, key) => `#${key}` });
export const spaces = () => [];
export const focused = () => null;
export const panes = () => [];
export const machines = () => [];
export const settings = () => ({});
export const window = () => ({ platform: "macos" });
export const appHome = () => new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");
export const home = () => state.home;
export const run = (command, args) => state.runs.push([command, args]);
export const readTextFile = (path) => readFile(path, "utf8");
export const nextCommand = () => new Promise(() => {});
export const shared = (key) => state.shared[key];
export const setShared = (key, value) => { state.shared[key] = value; };
export const checking = () => false;

export async function exec(command, argv) {
  if (command === "herdr-app") {
    state.herdrDo.push([argv[1], JSON.parse(argv[2])]);
    return { code: 0, stdout: JSON.stringify({ space: "s1", tab: `t${state.herdrDo.length}` }), stderr: "" };
  }
  const r = spawnSync(command, argv, { encoding: "utf8", env: { ...process.env, HOME: state.home } });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

export async function hc(args) {
  const ok = (out) => ({ code: 0, stdout: typeof out === "string" ? out : JSON.stringify(out), stderr: "" });
  if (args[0] === "machine") return ok({ machines: [] });
  if (args[0] === "run") {
    const name = args[args.indexOf("--name") + 1];
    const argv = args.slice(args.indexOf("--") + 1);
    const r = await exec(argv[0], argv.slice(1));
    state.terminals.push({ name, address: `t${state.terminals.length + 1}`, state: "finished", exit_code: r.code, output: r.stdout + r.stderr });
    return ok({ terminal: name });
  }
  if (args[0] === "ls") return ok({ terminals: state.terminals });
  if (args[0] === "read") return ok(state.terminals.find((t) => t.address === args[1])?.output ?? "");
  if (args[0] === "rm") { state.terminals = state.terminals.filter((t) => t.address !== args[1]); return ok(""); }
  throw new Error(`hc stub: ${args.join(" ")}`);
}

const stored = new Map();
globalThis.localStorage ??= { getItem: (k) => stored.get(k) ?? null, setItem: (k, v) => stored.set(k, String(v)) };
