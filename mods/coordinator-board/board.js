export const STAGES = ["starting", "implementing", "reviewing", "fixing", "pr-open", "waiting", "merged"];
const DEFAULT_BASE = "develop";

export function boardScope({ spaceId, coordinators, current }) {
  const key = Object.keys(coordinators ?? {}).find((key) => coordinators[key] === spaceId);
  if (!key) return { profile: current ?? null, project: null };
  const [profile, project] = key.split("/");
  return { profile, project };
}

export function boardSources(profile, only = null) {
  return Object.entries(profile?.projects ?? {}).filter(([name, project]) => project.coordinator?.folder && (!only || name === only))
    .map(([name, project]) => ({ project: name, label: project.label ?? name, folder: project.coordinator.folder }));
}

export function parseBoard(text) {
  if (text === null || text === undefined) return { error: "board.json is missing" };
  let board;
  try {
    board = JSON.parse(text);
  } catch (error) {
    return { error: `board.json is not valid JSON: ${error.message}` };
  }
  if (!board || typeof board !== "object" || Array.isArray(board)) return { error: "board.json is not an object" };
  for (const list of ["needsYou", "checked", "tasks", "helpers"]) {
    if (board[list] !== undefined && !Array.isArray(board[list])) return { error: `board.json "${list}" is not a list` };
  }
  return { board: { updated: board.updated ?? null, needsYou: board.needsYou ?? [], checked: board.checked ?? [], tasks: board.tasks ?? [], helpers: board.helpers ?? [] } };
}

export function age(since, now) {
  const at = Date.parse(since ?? "");
  if (Number.isNaN(at)) return null;
  const minutes = Math.max(0, Math.floor((now - at) / 60000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}

export function clock(iso) {
  const at = new Date(iso ?? "");
  if (Number.isNaN(at.getTime())) return null;
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

export function agentAddress(address, machine) {
  if (!address) return null;
  return machine && !address.includes("/") ? `${machine}/${address}` : address;
}

const prLabel = (pr) => ({
  number: pr.number,
  url: pr.url ?? null,
  repo: pr.repo ?? null,
  base: pr.base && pr.base !== DEFAULT_BASE ? pr.base : null,
});

export function buildView(board, statusOf, now) {
  const tasks = board.tasks.map((task) => {
    const address = agentAddress(task.agent, task.machine);
    return {
      key: task.key ?? "?",
      summary: task.summary ?? "",
      url: task.url ?? null,
      machine: task.machine ?? null,
      folder: task.folder ?? null,
      stage: task.stage ?? "unknown",
      isKnownStage: STAGES.includes(task.stage),
      prs: (task.prs ?? []).map(prLabel),
      tests: task.tests ?? "",
      next: task.next ? { who: task.next.who ?? "?", what: task.next.what ?? "" } : null,
      agent: address,
      status: address ? statusOf(address) ?? null : null,
    };
  });
  const helpers = board.helpers.map((helper) => {
    const address = agentAddress(helper.address, helper.machine);
    return { address, name: helper.name ?? "", purpose: helper.purpose ?? "", state: helper.state ?? "", status: address ? statusOf(address) ?? null : null };
  });
  const question = (item) => ({
    id: item.id ?? null,
    task: item.task ?? null,
    text: item.question ?? "",
    isTry: item.kind === "try",
    waited: age(item.since, now),
    agent: null,
  });
  const questions = board.needsYou.map(question);

  const blocked = [...tasks.map((task) => ({ owner: task.key, address: task.agent, status: task.status })),
    ...helpers.map((helper) => ({ owner: helper.name || helper.address, address: helper.address, status: helper.status }))]
    .filter((agent) => agent.status === "blocked")
    .map((agent) => ({ id: `blocked-${agent.address}`, task: agent.owner, text: `${agent.address} is blocked: it waits for you`, waited: null, agent: agent.address }));
  const needsYou = [...questions, ...blocked].map((item, index) => ({ ...item, number: index + 1 }));
  return { updated: board.updated, needsYou, checked: board.checked.map(question), tasks, helpers };
}

export function combineViews(sections) {
  const read = sections.filter((section) => section.view);
  const tagged = (list) => read.flatMap(({ source, view }) => view[list].map((item) => ({
    ...item,
    project: source.label,
    folder: source.folder,
    uid: `${source.project}/${item.id ?? item.number}`,
    taskRef: view.tasks.find((task) => task.key === item.task) ?? null,
  })));
  const updates = read.map(({ view }) => view.updated).filter((updated) => !Number.isNaN(Date.parse(updated ?? "")));
  return {
    needsYou: tagged("needsYou").map((item, index) => ({ ...item, number: index + 1 })),
    checked: tagged("checked"),
    updated: updates.sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1) ?? null,
  };
}

export function checkItem(raw, id, now) {
  const needsYou = raw.needsYou ?? [], checked = raw.checked ?? [];
  const item = needsYou.find((entry) => entry?.id === id);
  if (!item) return { error: checked.some((entry) => entry?.id === id) ? `${id} is already checked` : `No item ${id} waits on you` };
  if (item.kind !== "try") return { error: `${id} is a decision, not something to try` };
  return { board: { ...raw, needsYou: needsYou.filter((entry) => entry !== item), checked: [...checked, { ...item, checkedAt: now }], updated: now } };
}

export function uncheckItem(raw, id, now) {
  const needsYou = raw.needsYou ?? [], checked = raw.checked ?? [];
  const item = checked.find((entry) => entry?.id === id);
  if (!item) return { error: needsYou.some((entry) => entry?.id === id) ? `${id} is not checked` : `No checked item ${id}` };
  const { checkedAt: _checkedAt, ...back } = item;
  const since = Date.parse(back.since ?? "");
  const at = needsYou.findIndex((entry) => Date.parse(entry?.since ?? "") > since);
  const place = at < 0 ? needsYou.length : at;
  return { board: { ...raw, needsYou: [...needsYou.slice(0, place), back, ...needsYou.slice(place)], checked: checked.filter((entry) => entry !== item), updated: now } };
}

const sameMachine = (a, b) => (a ?? null) === (b ?? null);
const isInside = (path, folder) => path === folder || (path ?? "").startsWith(`${folder}/`);

export function taskSpace(task, allSpaces, allPanes) {
  if (!task.folder) return null;
  const onMachine = allSpaces.filter((space) => sameMachine(space.machine, task.machine));
  const byFolder = onMachine.find((space) => space.folder === task.folder);
  if (byFolder) return byFolder;
  const tabsOf = new Map(onMachine.flatMap((space) => space.tabs.map((tab) => [tab.id, space])));
  const pane = allPanes.find((p) => tabsOf.has(p.tab) && isInside(p.cwd, task.folder));
  return pane ? tabsOf.get(pane.tab) : null;
}

export function prGroups(prs) {
  const groups = [];
  for (const pr of prs) {
    const last = groups[groups.length - 1];
    if (last && last.base === pr.base) last.prs.push(pr);
    else groups.push({ base: pr.base, prs: [pr] });
  }
  return groups;
}
