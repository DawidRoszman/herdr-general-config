export const readKey = (hunkId) => {
  const at = String(hunkId).indexOf(":");
  return at === -1 ? String(hunkId) : String(hunkId).slice(at + 1);
};

export const pathOf = (key) => key.slice(0, Math.max(0, key.lastIndexOf(":")));

export const hunkRead = (hunkId, read) => Object.hasOwn(read, readKey(hunkId));

export const stepRead = (step, read) => step.hunkIds.length > 0 && step.hunkIds.every((id) => hunkRead(id, read));

export function markStep(step, read, now = Date.now()) {
  const next = { ...read };
  for (const id of step.hunkIds) next[readKey(id)] = now;
  return next;
}

export function unmarkStep(step, read) {
  const next = { ...read };
  for (const id of step.hunkIds) delete next[readKey(id)];
  return next;
}

export function prune(read, max = 5000) {
  const keys = Object.keys(read);
  if (keys.length <= max) return read;
  return Object.fromEntries(Object.entries(read).sort((a, b) => b[1] - a[1]).slice(0, max));
}

export function mergeRead(disk, mine, keys, max = 5000) {
  const next = { ...(disk && typeof disk === "object" ? disk : {}) };
  for (const k of keys) {
    if (Object.hasOwn(mine, k)) next[k] = mine[k];
    else delete next[k];
  }
  return prune(next, max);
}

export function changedSince(steps, read, { before = [], current = [] } = {}) {
  const now = new Set([...current].map(readKey));
  const gone = new Set(before.map(readKey).filter((k) => Object.hasOwn(read, k) && !now.has(k)).map(pathOf));
  return steps.filter((s) => !isRead(s, read)
    && s.hunkIds.some((id) => hunkRead(id, read) || gone.has(pathOf(readKey(id)))));
}

export const isRead = (step, read) => !step.outdated && stepRead(step, read);
