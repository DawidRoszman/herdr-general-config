// Pure helpers for the multirepo dialog. Checked by `node view.test.mjs`.

// The shared key the dialog stamps when a task was made, changed or removed; the Projects tab reloads on it.
export const CHANGED = "multirepo.changed";

// Repos named after the branch when a task is started ("feat/x backend portal=fix/other"), as picked
// repos: a word picks the repo whose short name (mr ls's "shorts") or full name it is, else it's unknown;
// "repo=branch" also names the branch that repo takes (one someone named differently), in branches.
// Nothing is guessed: mr new matches loosely, the picker only ticks what is plainly meant.
export function pickedRepos(words, names, shorts) {
  const picked = [];
  const unknown = [];
  const branches = {};
  for (const word of words) {
    const [short, branch] = word.split("=", 2);
    const name = names.find((n) => n === short) ?? names.find((n) => shorts[n] === short);
    if (!name) unknown.push(word);
    else {
      picked.push(name);
      if (branch) branches[name] = branch;
    }
  }
  return { picked: [...new Set(picked)], unknown, branches };
}

// The repo words mr new / mr add take: "name" or "name=branch" for a repo with a branch of its own.
export function repoArgs(names, branches) {
  return names.map((name) => (branches[name] ? `${name}=${branches[name]}` : name));
}

// "+2 ↑1 ●3" for one repo's status; empty when it matches its base.
export function changeBadge(status) {
  return [status.ahead && `+${status.ahead}`, status.behind && `-${status.behind}`, status.unpushed && `↑${status.unpushed}`, status.dirty && `●${status.dirty}`]
    .filter(Boolean)
    .join(" ");
}

// "on test/X-1 · vs develop" for a repo on a branch of its own in the task, else "vs develop".
export function baseLabel(repo, taskBranch) {
  return [repo.branch && repo.branch !== taskBranch ? `on ${repo.branch}` : "", `vs ${repo.base}`].filter(Boolean).join(" · ");
}

export function prLabel(pr) {
  if (!pr) return "no PR";
  return `PR #${pr.number} ${pr.isDraft && pr.state === "OPEN" ? "draft" : pr.state.toLowerCase()}`;
}

// Quotes each argument for the remote shell ssh hands the command to.
export function remoteCommand(args) {
  return ["python3", "-", ...args].map((a) => (a === "python3" || a === "-" ? a : `'${a.replaceAll("'", "'\\''")}'`)).join(" ");
}
