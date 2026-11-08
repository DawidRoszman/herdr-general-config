// The notification history the status bar's bell shows (shared NOTIFICATIONS, newest first).
// notifyAndLog(n, source) posts a notification and keeps it there; logNotification(n, source) only
// keeps it (for alerts Herdr already showed). Copied verbatim into every mod that posts
// notifications (a mod can't import from another mod's folder): change the copies together.

import { notify, openOverlay, shared, setShared } from "herdr";

export const NOTIFICATIONS = "notifications.log";
// When the history popup last closed (ms): its close() stamps it, for the bell's toggle.
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

// An agent turning blocked while not on screen, into the history. Finishing is not kept: the bell
// is for what needs you. Pass the statuses it returned last time (null at first: the first look
// only learns them, so nothing from before is announced).
export function logAgentAlerts(agentsNow, statusesBefore) {
  if (statusesBefore) {
    for (const a of agentsNow) {
      if (statusesBefore.get(a.address) === a.status || a.focused || a.status !== "blocked") continue;
      logNotification({
        title: `${a.program?.name ?? a.app ?? "Agent"} needs you`,
        body: [a.space_name, a.tab_name, a.title].filter(Boolean).join(" · "),
        level: "warning",
        action: { name: "agent.focus", args: { terminal: a.address } },
      }, "Agents");
    }
  }
  return new Map(agentsNow.map((a) => [a.address, a.status]));
}

const HISTORY_SIZE = { width: 400, height: 480 };

// The bell toggles the history. A press on the bell is a press outside the open popup, which closes
// it before the click arrives; so the click opens it only when it didn't close during this press.
// `press`: { at, x, y } from the bell's mouse down; `above`: open it above the press (a bottom bar).
export function toggleHistory(press, { above = false } = {}) {
  if (!press || (shared(HISTORY_CLOSED) ?? 0) >= press.at - 50) return;
  const x = Math.max(8, press.x - HISTORY_SIZE.width);
  const y = above ? Math.max(8, press.y - HISTORY_SIZE.height - 12) : press.y + 16;
  openOverlay({ mod: "notifications", kind: "popup", ...HISTORY_SIZE, at: { x, y } });
}
