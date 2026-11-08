// The toasts a finished generation posts. Whoever claims a finished job (the open walkthrough, a
// background turn, or the watcher) announces it, so each job is announced once. They go into the
// bell's history too (notifylog.js, the same copy the other mods carry).

import { notifyAndLog } from "./notifylog.js";
import { shortLabel } from "./lib/sources.js";

export function announceReady(meta) {
  notifyAndLog({ title: "Walkthrough ready", body: shortLabel(meta?.source, meta?.top), level: "success" }, "Walkthrough");
}

export function announceFailed(meta, error) {
  notifyAndLog({ title: "Walkthrough failed", body: `${shortLabel(meta?.source, meta?.top)}: ${String(error?.message ?? error)}`, level: "warning" }, "Walkthrough");
}
