import { exec, spaces, focused } from "herdr";
import { SAMPLE_MS, SCRIPT, parseSample } from "./sample.js";

export { bytes, pct, level, heat } from "./sample.js";

function shownMachine() {
  const id = focused()?.space;
  return spaces().find((s) => s.id === id)?.machine ?? null;
}

export class System {
  constructor() {
    this.host = null;
    this.cpu = null;
    this.cores = [];
    this.load = null;
    this.mem = null;
    this.disk = null;
    this.temps = { cpu: null, gpu: null };
    this.error = "";
    this.prev = null;
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
        if (host !== shownMachine()) return;
        if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `sample exited ${r.code}`);
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

  full() {
    const d = this.disk, room = d ? d.used + d.free : 0;
    return room ? d.used / room : null;
  }
}
