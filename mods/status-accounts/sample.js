// The pure half of system.js: the sampling script's output as figures, and how
// figures show.
// Checked by `node sample.test.mjs`.

// macOS's cpu figure takes top a second to measure, so samples are 2 s apart.
export const SAMPLE_MS = 2000;

export const SCRIPT = `
case "$(uname -s)" in
Linux)
  echo "os linux"
  grep '^cpu' /proc/stat
  echo "load $(cut -d' ' -f1-3 /proc/loadavg)"
  grep -E '^(MemTotal|MemAvailable|SwapTotal|SwapFree):' /proc/meminfo
  for h in /sys/class/hwmon/hwmon*; do
    t=$(cat "$h/temp1_input" 2>/dev/null) && echo "temp $(cat "$h/name" 2>/dev/null) $t"
  done
  if command -v nvidia-smi >/dev/null 2>&1; then
    nvidia-smi --query-gpu=temperature.gpu --format=csv,noheader,nounits 2>/dev/null | sed 's/^/temp nvidia /; s/$/000/'
  fi ;;
Darwin)
  echo "os mac"
  top -l 2 -n 0 -s 1 | grep '^CPU usage' | tail -1
  echo "load $(sysctl -n vm.loadavg | tr -d '{}')"
  echo "memsize $(sysctl -n hw.memsize)"
  vm_stat
  echo "swap $(sysctl -n vm.swapusage)"
  if command -v macmon >/dev/null 2>&1; then macmon pipe -s 1 -i 200 2>/dev/null | sed 's/^/macmon /'; fi ;;
esac
df -Pk "$HOME" | tail -1 | sed 's/^/disk /'
`;

// Which hwmon sensors are the cpu and the gpu (Linux), by driver name.
const CPU_SENSORS = ["k10temp", "coretemp", "zenpower", "cpu_thermal", "acpitz"];
const GPU_SENSORS = ["amdgpu", "nvidia", "nouveau", "radeon"];

// `17G`, `7.1G`, `512M`: binary units, one decimal under 10.
export function bytes(n) {
  const units = ["B", "K", "M", "G", "T", "P"];
  let u = 0;
  while (n >= 1024 && u < units.length - 1) { n /= 1024; u++; }
  return n < 10 && u > 0 ? `${n.toFixed(1)}${units[u]}` : `${Math.round(n)}${units[u]}`;
}

export const pct = (v) => `${Math.round(v * 100)}%`;

// A use's colour: blue, yellow from 70%, red from 90%.
export function level(t, v) {
  return v >= 0.9 ? t.ansi1 : v >= 0.7 ? t.ansi3 : t.ansi4;
}

// A temperature's colour: blue, yellow from 70 °C, red from 85 °C.
export function heat(t, celsius) {
  return celsius >= 85 ? t.ansi1 : celsius >= 70 ? t.ansi3 : t.ansi4;
}

const SIZE = { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };

/**
 * The script's output as figures: { os, ticks: [{ idle, total }] (Linux: all cpus then each core),
 * cpu (macOS: 0..1), load, mem, disk, temps: { cpu, gpu } in °C or null }.
 */
export function parseSample(text) {
  const out = { os: null, ticks: [], cpu: null, load: null, mem: null, disk: null, temps: { cpu: null, gpu: null } };
  const meminfo = {};
  const vm = {};
  let pageSize = 4096;
  let memsize = null;
  let swap = null;
  const hottest = (current, celsius) => (Number.isFinite(celsius) && (current === null || celsius > current) ? celsius : current);
  for (const line of text.split("\n")) {
    const words = line.trim().split(/\s+/);
    if (line.startsWith("os ")) out.os = words[1];
    else if (/^cpu\d*\s/.test(line)) {
      const f = words.slice(1).map(Number);
      out.ticks.push({ idle: f[3] + (f[4] ?? 0), total: f.reduce((a, b) => a + b, 0) });
    } else if (line.startsWith("CPU usage:")) {
      const idle = line.match(/([\d.]+)% idle/);
      if (idle) out.cpu = 1 - Number(idle[1]) / 100;
    } else if (line.startsWith("load ")) {
      const load = words.slice(1, 4).map(Number);
      if (load.length === 3 && load.every((x) => !Number.isNaN(x))) out.load = load;
    } else if (/^(MemTotal|MemAvailable|SwapTotal|SwapFree):/.test(line)) meminfo[words[0].slice(0, -1)] = Number(words[1]) * 1024;
    else if (line.startsWith("memsize ")) memsize = Number(words[1]);
    else if (line.startsWith("Mach Virtual Memory Statistics")) pageSize = Number(line.match(/page size of (\d+)/)?.[1] ?? pageSize);
    else if (/^Pages [^:]+:/.test(line)) vm[line.slice(6, line.indexOf(":"))] = Number(line.split(":")[1].replace(".", ""));
    else if (line.startsWith("swap ")) {
      const figure = (name) => {
        const m = line.match(new RegExp(`${name} = ([\\d.]+)([KMGT])`));
        return m ? Number(m[1]) * SIZE[m[2]] : 0;
      };
      swap = { total: figure("total"), used: figure("used") };
    } else if (line.startsWith("temp ")) {
      const celsius = Number(words[2]) / 1000;
      if (CPU_SENSORS.includes(words[1])) out.temps.cpu = hottest(out.temps.cpu, celsius);
      if (GPU_SENSORS.includes(words[1])) out.temps.gpu = hottest(out.temps.gpu, celsius);
    } else if (line.startsWith("macmon ")) {
      try {
        const temp = JSON.parse(line.slice(7)).temp ?? {};
        out.temps.cpu = hottest(out.temps.cpu, temp.cpu_temp_avg);
        out.temps.gpu = hottest(out.temps.gpu, temp.gpu_temp_avg);
      } catch (_) { /* a partial line: no temperature this time */ }
    } else if (line.startsWith("disk ")) {
      const [, , total, used, free, , ...path] = words;
      if (Number(total)) out.disk = { used: Number(used) * 1024, free: Number(free) * 1024, total: Number(total) * 1024, path: path.join(" ") };
    }
  }
  if (meminfo.MemTotal) {
    out.mem = { used: meminfo.MemTotal - meminfo.MemAvailable, total: meminfo.MemTotal, available: meminfo.MemAvailable,
      swapUsed: meminfo.SwapTotal - meminfo.SwapFree, swapTotal: meminfo.SwapTotal };
  } else if (memsize) {
    // Activity Monitor's "memory used": app memory, wired and compressed.
    const used = ((vm.active ?? 0) + (vm["wired down"] ?? 0) + (vm["occupied by compressor"] ?? 0)) * pageSize;
    out.mem = { used, total: memsize, available: memsize - used, swapUsed: swap?.used ?? 0, swapTotal: swap?.total ?? 0 };
  }
  return out;
}
