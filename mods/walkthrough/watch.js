import { div } from "gpui-kit";
import { appHome, watchFolder, checking } from "herdr";
import { endedJobs, finishJob } from "./engine.js";
import { announceReady, announceFailed } from "./announce.js";

const FALLBACK_MS = 60000;

export class Watcher {
  init(cx) {
    if (checking()) return;
    this.look();
    cx.timer.every(FALLBACK_MS, () => this.look());
    const jobsDir = `${appHome()}/data/walkthrough/jobs`;
    cx.spawn(async () => {
      try {
        for (;;) {
          await watchFolder(jobsDir);
          await this.look();
        }
      } catch {  }
    });
  }

  async look() {
    if (this.isLooking) return;
    this.isLooking = true;
    try {
      for (const job of await endedJobs()) {
        try {

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
