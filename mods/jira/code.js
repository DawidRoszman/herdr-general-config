// The code side of the board: each configured project's PRs and multirepo task branches, read with
// the multirepo mod's mr.py on the project's machine (over ssh, as the PR panel reads them; a copy
// of its few lines: mods can't import across folders).

import { exec, hc, appHome } from "herdr";

const MR = `${appHome()}/mods/multirepo/mr.py`;

async function sshTarget(machineName) {
  if (machineName === null) return null;
  const r = await hc(["machine", "ls", "--json"]);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || "hc machine ls failed");
  const machine = JSON.parse(r.stdout).machines.find((m) => m.name === machineName && m.state === "connected");
  if (!machine) throw new Error(`${machineName} is not connected.`);
  return machine.target;
}

async function mr(target, args) {
  const quoted = args.map((a) => `'${String(a).replaceAll("'", "'\\''")}'`).join(" ");
  const [command, ...argv] = target === null
    ? ["python3", MR, ...args]
    : ["sh", "-c", 'ssh -o BatchMode=yes "$1" "$2" < "$3"', "sh", target, `python3 - ${quoted}`, MR];
  const r = await exec(command, argv);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().replace(/^mr: /, "") || `mr ${args[0]} failed`);
  return r.stdout;
}

async function placeCode({ machine, root }) {
  const target = await sshTarget(machine ?? null);
  const [prs, tasks] = await Promise.all([mr(target, ["prs", "--project", root]), mr(target, ["ls", "--project", root])]);
  return { prs: JSON.parse(prs).prs, branches: tasks.split("\n").filter(Boolean).map((line) => line.split("\t")[0]) };
}

// { prs, branches } of a config.json project: one place ({ machine, root }) or a list of them, its
// checkouts on several computers. The places that answer are enough: a machine that's off only hides
// its tasks; the PRs come from GitHub either way. Throws when none answers.
export async function projectCode(places) {
  const results = await Promise.allSettled([places].flat().map(placeCode));
  const answers = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
  if (!answers.length) throw new Error(results.map((r) => r.reason?.message ?? r.reason).join(" · "));
  const prs = new Map(answers.flatMap((a) => a.prs).map((pr) => [pr.url, pr]));
  return { prs: [...prs.values()], branches: answers.flatMap((a) => a.branches) };
}
