export const CHANGED = "multirepo.changed";

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

export function repoArgs(names, branches) {
  return names.map((name) => (branches[name] ? `${name}=${branches[name]}` : name));
}

export function changeBadge(status) {
  return [status.ahead && `+${status.ahead}`, status.behind && `-${status.behind}`, status.unpushed && `↑${status.unpushed}`, status.dirty && `●${status.dirty}`]
    .filter(Boolean)
    .join(" ");
}

export function baseLabel(repo, taskBranch) {
  return [repo.branch && repo.branch !== taskBranch ? `on ${repo.branch}` : "", `vs ${repo.base}`].filter(Boolean).join(" · ");
}

export function prLabel(pr) {
  if (!pr) return "no PR";
  return `PR #${pr.number} ${pr.isDraft && pr.state === "OPEN" ? "draft" : pr.state.toLowerCase()}`;
}

export function remoteCommand(args) {
  return ["python3", "-", ...args].map((a) => (a === "python3" || a === "-" ? a : `'${a.replaceAll("'", "'\\''")}'`)).join(" ");
}

export function stackOrder(tasks) {
  const parentOf = (task) => task.stackedOn ?? task.on ?? null;
  const listed = new Set(tasks.map((task) => task.branch));
  const childrenOf = (branch) => tasks.filter((task) => parentOf(task) === branch);
  const layersFrom = (task, layers) => {
    if (layers.includes(task.branch)) return layers;
    layers.push(task.branch);
    for (const kid of childrenOf(task.branch)) layersFrom(kid, layers);
    return layers;
  };
  const out = [];
  const seen = new Set();
  const visit = (task, depth, stack) => {
    if (seen.has(task.root)) return;
    seen.add(task.root);
    out.push({ ...task, parent: parentOf(task), depth, stack });
    for (const kid of childrenOf(task.branch)) visit(kid, depth + 1, stack);
  };
  for (const task of tasks.filter((x) => !listed.has(parentOf(x)))) {
    const layers = layersFrom(task, []);
    visit(task, 0, layers.length > 1 || parentOf(task) ? layers : []);
  }
  for (const task of tasks) visit(task, 0, []);
  return out;
}

export function sandboxPlace(context, machine, root) {
  const profile = context?.profiles?.[context.current];
  if (!profile || !machine) return null;
  for (const [project, { places = [], coordinator }] of Object.entries(profile.projects ?? {})) {
    if (!coordinator?.folder || !places.some((p) => p.machine === machine && p.root === root)) continue;
    return { project, coordinator: coordinator.folder, isSandboxFirst: profile.agents?.machines?.[machine]?.length === 0 };
  }
  return null;
}

export const taskName = (branch) => /[A-Z][A-Z0-9]*-\d+/.exec(branch)?.[0] ?? branch;
