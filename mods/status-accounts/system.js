// What the shown space's machine is using: cpu (all and each core, the load),
// ram (and swap), the disk of its home folder, and how hot its cpu and gpu run.
// Used by this status bar (main.js); sample.js holds its pure half.
//
//   const sys = new System(); sys.start(cx);   then sys.host, sys.cpu, sys.temps, ...
//
// One shell script every SAMPLE_MS on that machine (this Mac or one over ssh):
// Linux reads /proc and /sys/class/hwmon (and nvidia-smi when there); macOS
// asks top, vm_stat and sysctl, and macmon for temperatures when installed
// (macOS has no other way to read them without root).

import { exec, spaces, focused } from "herdr";
import { SAMPLE_MS, SCRIPT, parseSample } from "./sample.js";

export { bytes, pct, level, heat } from "./sample.js";

// The machine of the space on screen: null for this computer.
function shownMachine() {
  const id = focused()?.space;
  return spaces().find((s) => s.id === id)?.machine ?? null;
}

export class System {
  constructor() {
    this.host = null; // the machine measured: null for this computer
    this.cpu = null; // 0..1
    this.cores = []; // 0..1 each (Linux)
    this.load = null; // [1, 5, 15 min]
    this.mem = null; // { used, total, available, swapUsed, swapTotal }
    this.disk = null; // { used, free, total, path }
    this.temps = { cpu: null, gpu: null }; // °C
    this.error = ""; // why the last sample failed (the machine is offline, ...)
    this.prev = null; // last /proc/stat totals, for Linux's cpu use
    this.isSampling = false;
  }

  start(cx) {
    this.sample(cx);
    cx.timer.every(SAMPLE_MS, (cx) => this.sample(cx));
  }

  sample(cx) {
    if (this.isSampling) return;
    this.isSampling = true;
    const host = shownMachine();
    cx.spawn(async (cx) => {
      try {
        const r = await exec("sh", ["-c", SCRIPT], { on: host ?? undefined });
        if (host !== shownMachine()) return; // the space changed while it ran: the next sample is the new machine's
        this.apply(host, parseSample(r.stdout));
        this.error = "";
      } catch (error) {
        if (host !== this.host) this.clear(host);
        this.error = String(error.message ?? error);
      } finally {
        this.isSampling = false;
        cx.notify();
      }
    });
  }

  clear(host) {
    this.host = host;
    this.cpu = null;
    this.cores = [];
    this.load = null;
    this.mem = null;
    this.disk = null;
    this.temps = { cpu: null, gpu: null };
    this.prev = null;
  }

  apply(host, s) {
    if (host !== this.host) this.clear(host);
    if (s.ticks.length) {
      const use = (n, p) => (p && n.total > p.total ? 1 - (n.idle - p.idle) / (n.total - p.total) : null);
      if (this.prev) {
        this.cpu = use(s.ticks[0], this.prev[0]) ?? this.cpu;
        this.cores = s.ticks.slice(1).map((c, i) => use(c, this.prev[i + 1]) ?? 0);
      }
      this.prev = s.ticks;
    } else if (s.cpu !== null) this.cpu = s.cpu;
    this.load = s.load;
    this.mem = s.mem;
    this.disk = s.disk;
    this.temps = s.temps;
  }

  // How full the disk is, 0..1, or null while unknown.
  full() {
    const d = this.disk, room = d ? d.used + d.free : 0;
    return room ? d.used / room : null;
  }
}
