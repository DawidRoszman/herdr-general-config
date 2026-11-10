#!/usr/bin/env node
// start-task: what the coordinator agents run to start a task in its own space.
//
//   start-task.mjs issue <KEY>
//       The Jira issue as JSON: key, summary, branch (as the jira mod names it), description, and
//       "places": the machines and multirepo project roots mods/jira/config.json maps its project to.
//       Read as the Jira account of this process's profile (profiles.json), else config.json's.
//   start-task.mjs repos --project <root> [--machine <name>]
//       The project's repos and tasks as JSON (mr ls --json).
//   start-task.mjs start --project <root> --branch <branch> --repos <a,b> [--machine <name>] [--name <space>] [--task <text>] [--on <branch>]
//       Creates the task (mr new), then a space on its folder with a Claude chat (the t3-chat mod; Claude Code is
//       started here, with --task as its first message), a terminal and nvim tabs. --on stacks it on another
//       task's branch. Prints {space, root, terminal} as JSON (terminal: Claude Code's hc address).
//   start-task.mjs space --root <folder> [--machine <name>] [--name <space>] [--task <text>]
//       Only the space of `start`, on a folder that exists. Prints {space, terminal}.
//
// --machine is a Herdr machine name (`hc machine ls`); without it, this Mac.

import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DETAIL_FIELDS, toCard, toDetails, branchFor } from "../mods/jira/board.js";
import { signIn } from "../mods/jira/account.js";

const HOME = dirname(dirname(fileURLToPath(import.meta.url)));
const MR = join(HOME, "mods/multirepo/mr.py");
const JIRA_CONFIG = join(HOME, "mods/jira/config.json");
const PROFILES_PY = join(HOME, "mods/t3-context/profiles.py");

class UsageError extends Error {}

function run(command, args, options = {}) {
  try {
    return execFileSync(command, args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], ...options });
  } catch (error) {
    throw new Error(`${command} ${args[0] ?? ""} failed: ${(error.stderr || error.stdout || error.message).trim()}`);
  }
}

// mr on a machine as the multirepo mod runs it: this copy of mr.py, streamed to python3 over ssh.
function mr(machine, args) {
  if (!machine) return run("python3", [MR, ...args]);
  const quoted = ["python3", "-", ...args.map((a) => `'${a.replaceAll("'", "'\\''")}'`)].join(" ");
  return run("ssh", ["-o", "BatchMode=yes", sshTarget(machine), quoted], { input: readFileSync(MR) });
}

function sshTarget(machine) {
  const known = JSON.parse(run("hc", ["machine", "ls", "--json"])).machines.find((m) => m.name === machine);
  if (!known) throw new UsageError(`Unknown machine ${machine}: see hc machine ls`);
  return known.target;
}

// A command's outcome as the jira mod's sign-in takes it (mods/jira/account.js).
async function outcome(command, args) {
  const r = spawnSync(command, args, { encoding: "utf8" });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr || r.error?.message || "" };
}

// The profile this script runs in (a coordinator's): null when it is no profile's.
function currentProfile() {
  return JSON.parse(run("python3", [PROFILES_PY, "current"])).profile;
}

async function issue(key) {
  if (!/^[A-Z][A-Z0-9]*-\d+$/.test(key ?? "")) throw new UsageError(`Not a Jira key: ${key}`);
  const config = JSON.parse(readFileSync(JIRA_CONFIG, "utf8"));
  const { site, authorization } = await signIn({ config, profile: currentProfile(), profilesPy: PROFILES_PY, exec: outcome });
  const response = await fetch(`https://${site}/rest/api/3/issue/${key}?fields=${DETAIL_FIELDS.join(",")}`, {
    headers: { Authorization: authorization, Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Jira answered ${response.status} for ${key}: ${(await response.text()).slice(0, 300)}`);
  const raw = await response.json();
  const details = toDetails(raw);
  return {
    key: details.key,
    summary: details.summary,
    type: details.type,
    status: details.status,
    branch: branchFor(toCard({ ...raw, fields: { ...raw.fields, project: { key: key.split("-")[0] } } })),
    url: `https://${site}/browse/${key}`,
    description: details.description,
    places: config.projects?.[key.split("-")[0]] ?? [],
  };
}

function herdrDo(command, args) {
  const out = JSON.parse(run("herdr-app", ["do", command, JSON.stringify(args)]) || "{}");
  if (out.error) throw new Error(`${command}: ${out.error}`);
  return out;
}

// Claude Code as the chat starts it (mods/t3-chat/host.js): in the login shell, so the folder's
// direnv picks its account.
const IN_LOGIN_SHELL = 'exec "${SHELL:-/bin/sh}" -lic \'exec "$@"\' sh "$@"';
// Ids on the space's machine: Herdr shows remote ones as machine/id.
const localId = (id) => id.replace(/^[^/]+\//, "");

// The workspace the multirepo mod opens (mods/multirepo/remote.js openWorkspace): a Claude chat, a
// terminal and nvim, in that order; new tabs go next to the selected one, so the order is set at
// the end. A chat starts its Claude Code only once it is shown, and a task's space may never be:
// so Claude Code is started here, labelled into the chat's tab, under a session id the chat is
// given (and labelled with it, as the chat looks for it: mods/t3-chat/host.js). The chat is told
// so (external) and waits for it instead of starting its own. Returns the space and Claude Code's address.
function openSpace({ machine, root, name, task }) {
  const { space, tab: terminal } = herdrDo("space.new", { name, folder: root, machine: machine ?? "", tab: "terminal" });
  const session = randomUUID();
  const { tab: claude } = herdrDo("tab.new", { space, name: "claude", mod: "t3-chat", props: { view: "chat", session, folder: root, machine: machine ?? null, external: true } });
  const labels = [`herdr.space=${localId(space)}`, `herdr.tab=${localId(claude)}`, `t3-chat.session=${session}`];
  const started = JSON.parse(run("hc", ["run", "--bg", "--json", "--no-parent", ...labels.flatMap((label) => ["--label", label]),
    ...(machine ? ["--on", machine] : []), "--cwd", root, "--", "sh", "-c", IN_LOGIN_SHELL, "sh", "claude", "--session-id", session, ...(task ? [task] : [])]));
  const { tab: nvim } = herdrDo("tab.new", { space, folder: root, name: "nvim", argv: ["nvim"] });
  [claude, terminal, nvim].forEach((id, index) => herdrDo("tab.move", { id, index: index + 1 }));
  return { space, terminal: started.address };
}

function start({ machine, project, branch, repos, name, task, on }) {
  if (!project || !branch || !repos) throw new UsageError("start needs --project, --branch and --repos");
  const repoList = repos.split(",").map((r) => r.trim()).filter(Boolean);
  if (!repoList.length) throw new UsageError("--repos is empty");
  const output = mr(machine, ["new", branch, ...repoList, "--project", project, ...(on ? ["--on", on] : [])]).trim().split("\n");
  const root = output.at(-1);
  const { space, terminal } = openSpace({ machine, root, name: name ?? branch, task });
  return { space, root, terminal };
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { machine: { type: "string" }, project: { type: "string" }, branch: { type: "string" }, repos: { type: "string" }, name: { type: "string" }, task: { type: "string" }, root: { type: "string" }, on: { type: "string" } },
  });
  const [command, key] = positionals;
  if (command === "issue") return issue(key);
  if (command === "repos") {
    if (!values.project) throw new UsageError("repos needs --project");
    return JSON.parse(mr(values.machine, ["ls", "--project", values.project, "--json"]));
  }
  if (command === "start") return start(values);
  if (command === "space") {
    if (!values.root) throw new UsageError("space needs --root");
    return openSpace({ machine: values.machine, root: values.root, name: values.name, task: values.task });
  }
  throw new UsageError("usage: start-task.mjs issue <KEY> | repos --project <root> | start --project <root> --branch <b> --repos <a,b> | space --root <folder>");
}

main().then(
  (result) => console.log(JSON.stringify(result, null, 2)),
  (error) => {
    console.error(`start-task: ${error.message}`);
    process.exit(error instanceof UsageError ? 2 : 1);
  },
);
