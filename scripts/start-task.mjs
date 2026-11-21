#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DETAIL_FIELDS, toCard, toDetails, branchFor, projectPlaces } from "../mods/jira/board.js";
import { signIn } from "../mods/jira/account.js";
import { run, shellQuote, sshTarget, UsageError } from "./machine.mjs";
import { create as createSandbox, sandboxName } from "./sandbox.mjs";

const HOME = dirname(dirname(fileURLToPath(import.meta.url)));
const MR = join(HOME, "mods/multirepo/mr.py");
const JIRA_CONFIG = join(HOME, "mods/jira/config.json");
const PROFILES_PY = join(HOME, "mods/t3-context/profiles.py");

function isChatEnabled() {
  try {
    return JSON.parse(readFileSync(join(HOME, "shared.json"), "utf8"))["t3-chat.enabled"] !== false;
  } catch {
    return true;
  }
}

function mr(machine, args) {
  if (!machine) return run("python3", [MR, ...args]);
  const quoted = ["python3", "-", ...args.map(shellQuote)].join(" ");
  return run("ssh", ["-o", "BatchMode=yes", sshTarget(machine), quoted], { input: readFileSync(MR) });
}

async function outcome(command, args) {
  const r = spawnSync(command, args, { encoding: "utf8" });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr || r.error?.message || "" };
}

function currentPlace() {
  const { profile, project } = JSON.parse(run("python3", [PROFILES_PY, "current"]));
  const projects = profile ? JSON.parse(run("python3", [PROFILES_PY, "list"])).profiles[profile].projects : {};
  return { profile, project, projects };
}

async function issue(key) {
  if (!/^[A-Z][A-Z0-9]*-\d+$/.test(key ?? "")) throw new UsageError(`Not a Jira key: ${key}`);
  const config = JSON.parse(readFileSync(JIRA_CONFIG, "utf8"));
  const { profile, project, projects } = currentPlace(), jiraProject = key.split("-")[0];

  if (project && !projects[project].jira.includes(jiraProject)) {
    throw new UsageError(`${key} is not an issue of ${projects[project].label} (Jira: ${projects[project].jira.join(", ") || "none"}); ask that project's coordinator`);
  }
  const { site, authorization } = await signIn({ config, profile, profilesPy: PROFILES_PY, exec: outcome });
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
    branch: branchFor(toCard({ ...raw, fields: { ...raw.fields, project: { key: jiraProject } } })),
    url: `https://${site}/browse/${key}`,
    description: details.description,
    places: projectPlaces(config.projects, projects)[jiraProject] ?? [],
  };
}

function herdrDo(command, args) {
  const out = JSON.parse(run("herdr-app", ["do", command, JSON.stringify(args)]) || "{}");
  if (out.error) throw new Error(`${command}: ${out.error}`);
  return out;
}

function newSpace(args) {
  for (let waited = 0; ; waited++) {
    try {
      return herdrDo("space.new", args);
    } catch (error) {
      if (!String(error.message).includes("has no machine called") || waited >= 60) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    }
  }
}

const IN_LOGIN_SHELL = 'exec "${SHELL:-/bin/sh}" -lic \'exec "$@"\' sh "$@"';

const localId = (id) => id.replace(/^[^/]+\//, "");

function openSpace({ machine, root, name, task }) {
  const { space, tab: terminal } = newSpace({ name, folder: root, machine: machine ?? "", tab: "terminal" });
  const { tab: nvim } = herdrDo("tab.new", { space, folder: root, name: "nvim", argv: ["nvim"] });
  const { tab: claude, terminal: address } = isChatEnabled() ? openChat({ machine, root, space, task })
    : herdrDo("tab.new", { space, folder: root, name: "claude", argv: ["claude"], ...(task ? { task } : {}) });
  [claude, terminal, nvim].forEach((id, index) => herdrDo("tab.move", { id, index: index + 1 }));
  return { space, terminal: address };
}

function openChat({ machine, root, space, task }) {
  const session = randomUUID();
  const { tab: claude } = herdrDo("tab.new", { space, name: "claude", mod: "t3-chat", props: { view: "chat", session, folder: root, machine: machine ?? null, external: true } });
  const labels = [`herdr.space=${localId(space)}`, `herdr.tab=${localId(claude)}`, `t3-chat.session=${session}`];
  const started = JSON.parse(run("hc", ["run", "--bg", "--json", "--no-parent", ...labels.flatMap((label) => ["--label", label]),
    ...(machine ? ["--on", machine] : []), "--cwd", root, "--", "sh", "-c", IN_LOGIN_SHELL, "sh", "claude", "--session-id", session, ...(task ? [task] : [])]));
  return { tab: claude, terminal: started.address };
}

const sandboxNameFor = (text) => sandboxName(text.toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 63).replace(/^-+|-+$/g, ""));

function startInSandbox({ machine, branch, repos, name, task, on, env }) {
  if (!machine) throw new UsageError("--sandbox needs --machine: the machine that holds the project's sandboxes");
  const { project } = currentPlace();
  if (!project) throw new UsageError("--sandbox starts a task of this folder's project: run it from the project's coordinator folder");
  const sandbox = sandboxNameFor(name ?? branch ?? "");
  const made = createSandbox({ machine, name: sandbox, project, branch, repos, base: on, env });
  const { space, terminal } = openSpace({ machine: sandbox, root: made.work, name: name ?? branch, task });
  return { space, sandbox, root: made.work, terminal };
}

function start({ machine, project, branch, repos, name, task, on, sandbox, env, "on-machine": isOnMachineChosen }) {
  if (sandbox && isOnMachineChosen) throw new UsageError("--sandbox and --on-machine: pick one");
  if (sandbox) return startInSandbox({ machine, branch, repos, name, task, on, env });
  if (!project || !branch || !repos) throw new UsageError("start needs --project, --branch and --repos");

  const { profile } = currentPlace();
  const agentsThere = profile && JSON.parse(run("python3", [PROFILES_PY, "list"])).profiles[profile].agents?.machines?.[machine];
  if (machine && Array.isArray(agentsThere) && agentsThere.length === 0 && !isOnMachineChosen) {
    throw new UsageError(`No agent runs on ${machine} itself: start the task in a sandbox there (--sandbox), or with --on-machine when the person chose the machine`);
  }
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
    options: { machine: { type: "string" }, project: { type: "string" }, branch: { type: "string" }, repos: { type: "string" }, name: { type: "string" }, task: { type: "string" }, root: { type: "string" }, on: { type: "string" }, sandbox: { type: "boolean" }, env: { type: "boolean" }, "on-machine": { type: "boolean" } },
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
  throw new UsageError("usage: start-task.mjs issue <KEY> | repos --project <root> | start --project <root> --branch <b> --repos <a,b> | start --sandbox --machine <m> --branch <b> --repos <a,b> | space --root <folder>");
}

main().then(
  (result) => console.log(JSON.stringify(result, null, 2)),
  (error) => {
    console.error(`start-task: ${error.message}`);
    process.exit(error instanceof UsageError ? 2 : 1);
  },
);
