import { exec, focused, notify, spaces } from "herdr";

const REMOTE = /^(?:https:\/\/(?<web>[^/]+)\/|ssh:\/\/(?:[^@/]+@)?(?<ssh>[^/:]+)(?::\d+)?\/|(?:[^@/]+@)?(?<scp>[^/:]+):)(?<slug>[^/]+\/[^/]+?)(?:\.git)?\/?$/;

export function parseRemote(url) {
  const groups = url.trim().match(REMOTE)?.groups;
  return groups ? { host: groups.web ?? groups.ssh ?? groups.scp, isSsh: !groups.web, slug: groups.slug } : null;
}

async function sshHostname(host, machine) {
  const r = await exec("ssh", ["-G", host], { on: machine });
  return r.stdout.match(/^hostname (.+)$/m)?.[1] ?? host;
}

export async function openRepoOnGitHub(cx) {
  const fail = (body) => notify({ title: "Open on GitHub", body, level: "error" });
  const at = focused();
  if (!at?.cwd) return fail("The focused pane has no folder.");
  const machine = spaces().find((s) => s.id === at.space)?.machine ?? undefined;
  const r = await exec("git", ["-C", at.cwd, "remote", "get-url", "origin"], { on: machine });
  if (r.code !== 0) return fail(`${at.cwd} has no origin remote.`);
  const remote = parseRemote(r.stdout);
  if (!remote) return fail(`Can't read origin: ${r.stdout.trim()}`);
  const host = remote.isSsh ? await sshHostname(remote.host, machine) : remote.host;
  if (host !== "github.com") return fail(`origin is on ${host}, not GitHub.`);
  cx.open_url(`https://github.com/${remote.slug}`);
}
