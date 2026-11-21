import { notify, openOverlay, shared, setShared } from "herdr";

export const NOTIFICATIONS = "notifications.log";

export const HISTORY_CLOSED = "notifications.closedAt";
const MAX_KEPT = 200;

export function logNotification(n, source) {
  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    at: new Date().toISOString(),
    title: n.title,
    body: n.body ?? "",
    level: n.level ?? "info",
    action: n.action ?? null,
    source,
    isRead: false,
  };
  setShared(NOTIFICATIONS, [entry, ...(shared(NOTIFICATIONS) ?? [])].slice(0, MAX_KEPT));
}

export function notifyAndLog(n, source) {
  logNotification(n, source);
  return notify(n);
}

export function unreadCount() {
  return (shared(NOTIFICATIONS) ?? []).filter((entry) => !entry.isRead).length;
}

const HISTORY_SIZE = { width: 400, height: 480 };

export function toggleHistory(press, { above = false } = {}) {
  if (!press || (shared(HISTORY_CLOSED) ?? 0) >= press.at - 50) return;
  const x = Math.max(8, press.x - HISTORY_SIZE.width);
  const y = above ? Math.max(8, press.y - HISTORY_SIZE.height - 12) : press.y + 16;
  openOverlay({ mod: "notifications", kind: "popup", ...HISTORY_SIZE, at: { x, y } });
}
