// Pure rules for the coordinator board: parsing board.json (its shape is in
// coordinators/<context>/CLAUDE.md, section Board), joining herdr's live agent status, and finding a
// task's space. Checked by `node board.test.mjs`.

export const STAGES = ["starting", "implementing", "reviewing", "fixing", "pr-open", "waiting", "merged"];
const DEFAULT_BASE = "develop";

// The board's context: the coordinator whose space holds this pane, else the shown context.
export function boardContext({ spaceId, coordinators, current }) {
  return Object.keys(coordinators ?? {}).find((context) => coordinators[context] === spaceId) ?? current ?? null;
}

// { board } or { error }: a missing file, invalid JSON or a wrong shape is an error line, never a blank.
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

// "12s", "5m", "3h 20m", "2d 4h": how long since an ISO time. Null when the time is unknown.
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

// "21:07": an ISO time's local hours and minutes. The app's JS engine ignores toLocaleTimeString's
// options (it gives "09:07:31 PM"), so it is built by hand. Null when the time is unknown.
export function clock(iso) {
  const at = new Date(iso ?? "");
  if (Number.isNaN(at.getTime())) return null;
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

// The address herdr's agents() use: a remote task's bare "t7" is "machine/t7".
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

// The panel's three sections. statusOf(address) is herdr's live agent status (or null).
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
  // A blocked agent needs the person even while board.json lags behind.
  const blocked = [...tasks.map((task) => ({ owner: task.key, address: task.agent, status: task.status })),
    ...helpers.map((helper) => ({ owner: helper.name || helper.address, address: helper.address, status: helper.status }))]
    .filter((agent) => agent.status === "blocked")
    .map((agent) => ({ id: `blocked-${agent.address}`, task: agent.owner, text: `${agent.address} is blocked: it waits for you`, waited: null, agent: agent.address }));
  const needsYou = [...questions, ...blocked].map((item, index) => ({ ...item, number: index + 1 }));
  return { updated: board.updated, needsYou, checked: board.checked.map(question), tasks, helpers };
}

// Try items (needsYou with kind "try": something to try by hand) are ticked off in the panel:
// checkItem moves one by id to "checked" with checkedAt, uncheckItem moves it back into needsYou in
// its place by "since". Both take board.json as parsed (raw: every other field is kept) and return
// { board } (a new object, "updated" set to now) or { error }.
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
  const at = needsYou.findIndex((entry) => Date.parse(entry?.since ?? "") > since); // NaN since: never greater, so last
  const place = at < 0 ? needsYou.length : at;
  return { board: { ...raw, needsYou: [...needsYou.slice(0, place), back, ...needsYou.slice(place)], checked: checked.filter((entry) => entry !== item), updated: now } };
}

const sameMachine = (a, b) => (a ?? null) === (b ?? null);
const isInside = (path, folder) => path === folder || (path ?? "").startsWith(`${folder}/`);

// The space working on a task: same machine, and its folder (or a terminal's live folder) is the task's.
export function taskSpace(task, allSpaces, allPanes) {
  if (!task.folder) return null;
  const onMachine = allSpaces.filter((space) => sameMachine(space.machine, task.machine));
  const byFolder = onMachine.find((space) => space.folder === task.folder);
  if (byFolder) return byFolder;
  const tabsOf = new Map(onMachine.flatMap((space) => space.tabs.map((tab) => [tab.id, space])));
  const pane = allPanes.find((p) => tabsOf.has(p.tab) && isInside(p.cwd, task.folder));
  return pane ? tabsOf.get(pane.tab) : null;
}

// PRs grouped by base, in order, so a shared non-develop base is said once: "#111 #39 → feat/x".
export function prGroups(prs) {
  const groups = [];
  for (const pr of prs) {
    const last = groups[groups.length - 1];
    if (last && last.base === pr.base) last.prs.push(pr);
    else groups.push({ base: pr.base, prs: [pr] });
  }
  return groups;
}
