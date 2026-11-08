// Pure helpers for the multirepo dialog. Checked by `node view.test.mjs`.

// Repos named after the branch when a task is started ("feat/x backend portal"), as picked repos:
// a word picks the repo whose short name (mr ls's "shorts") or full name it is, else it's unknown.
// Nothing is guessed: mr new matches loosely, the picker only ticks what is plainly meant.
export function pickedRepos(words, names, shorts) {
  const picked = [];
  const unknown = [];
  for (const word of words) {
    const name = names.find((n) => n === word) ?? names.find((n) => shorts[n] === word);
    if (name) picked.push(name);
    else unknown.push(word);
  }
  return { picked: [...new Set(picked)], unknown };
}

// "+2 ↑1 ●3" for one repo's status; empty when it matches its base.
export function changeBadge(status) {
  return [status.ahead && `+${status.ahead}`, status.behind && `-${status.behind}`, status.unpushed && `↑${status.unpushed}`, status.dirty && `●${status.dirty}`]
    .filter(Boolean)
    .join(" ");
}

export function prLabel(pr) {
  if (!pr) return "no PR";
  return `PR #${pr.number} ${pr.isDraft && pr.state === "OPEN" ? "draft" : pr.state.toLowerCase()}`;
}

// Quotes each argument for the remote shell ssh hands the command to.
export function remoteCommand(args) {
  return ["python3", "-", ...args].map((a) => (a === "python3" || a === "-" ? a : `'${a.replaceAll("'", "'\\''")}'`)).join(" ");
}
