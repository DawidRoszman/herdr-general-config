import { notifyAndLog } from "./notifylog.js";
import { shortLabel } from "./lib/sources.js";

export function announceReady(meta) {
  notifyAndLog({ title: "Walkthrough ready", body: shortLabel(meta?.source, meta?.top), level: "success" }, "Walkthrough");
}

export function announceFailed(meta, error) {
  notifyAndLog({ title: "Walkthrough failed", body: `${shortLabel(meta?.source, meta?.top)}: ${String(error?.message ?? error)}`, level: "warning" }, "Walkthrough");
}
