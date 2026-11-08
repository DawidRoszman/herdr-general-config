// The watcher: a walkthrough copy with props { watch: true }, kept in a layout as a block of no
// size. A generation runs on after its dialog closes; this stores what it wrote and announces it,
// so the toast comes even when no walkthrough is open. It draws nothing.

import { div } from "gpui-kit";
import { endedJobs, finishJob } from "./engine.js";
import { announceReady, announceFailed } from "./announce.js";

const LOOK_EVERY_MS = 3000;

export class Watcher {
  init(cx) {
    cx.timer.every(LOOK_EVERY_MS, () => this.look());
  }

  async look() {
    if (this.isLooking) return;
    this.isLooking = true;
    try {
      for (const job of await endedJobs()) {
        try {
          // null: an open walkthrough claimed it first, and announces it itself.
          if (await finishJob(job)) announceReady(job.meta);
        } catch (e) {
          announceFailed(job.meta, e);
        }
      }
    } finally {
      this.isLooking = false;
    }
  }

  render() {
    return div();
  }
}
