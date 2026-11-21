export const ownStatus = (word, address, all) => (all.find((k) => k.address === address)?.status === "error" ? "blocked" : word);

export const kidStatus = (k, listed) => {
  const s = k.status === "error" ? "error" : listed.get(k.address) ?? k.status;
  return s === "error" ? "blocked" : s === "done" ? "idle" : s;
};

export function descendants(all, addr) {
  return all.filter((k) => k.parent === addr && k.state === "live").flatMap((k) => [k, ...descendants(all, k.address)]);
}

export function treeStatus(own, kids) {
  if (own == null) return own;
  if (own === "blocked" || kids.includes("blocked")) return "blocked";
  return own !== "done" && kids.includes("working") ? "working" : own;
}

export function stillSettled(k, word, kids) {
  const label = k?.labels?.settled;
  if (!label) return false;
  const busy = (s) => s === "working" || s === "blocked";
  return !busy(word) && !kids.some(busy) && (k.turn ?? 0) <= Number(label.split(":")[1]);
}

export function notNews(k, word, kids) {
  return stillSettled(k, word, kids) || Number(k?.labels?.snoozed) > Date.now();
}

export function subAgents(agentList, all) {
  const listed = new Map(agentList.map((a) => [a.address, a.status]));
  return (addr) => descendants(all, addr).map((k) => kidStatus(k, listed));
}
