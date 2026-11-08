// node sample.test.mjs: the sampling script's output from a Linux box and a Mac, as figures.
import assert from "node:assert/strict";
import { parseSample } from "./sample.js";

const linux = parseSample(`os linux
cpu  100 0 50 800 50 0 0 0 0 0
cpu0 50 0 25 400 25 0 0 0 0 0
load 0.29 0.11 0.09
MemTotal:       65536000 kB
MemAvailable:   49152000 kB
SwapTotal:       8192000 kB
SwapFree:        8192000 kB
temp nvme 30850
temp k10temp 52500
temp amdgpu 38000
temp nvidia 33000
disk /dev/nvme1n1p2  1949318196 702334392 1242568456      37% /home
`);
assert.equal(linux.os, "linux");
assert.deepEqual(linux.ticks, [{ idle: 850, total: 1000 }, { idle: 425, total: 500 }]);
assert.deepEqual(linux.load, [0.29, 0.11, 0.09]);
assert.equal(linux.mem.used, 16384000 * 1024);
assert.deepEqual(linux.temps, { cpu: 52.5, gpu: 38 }, "the hottest gpu sensor; nvme and others don't count");
assert.deepEqual(linux.disk, { used: 702334392 * 1024, free: 1242568456 * 1024, total: 1949318196 * 1024, path: "/home" });

const mac = parseSample(`os mac
CPU usage: 8.94% user, 3.36% sys, 87.68% idle 
load  1.51 1.89 2.02 
memsize 25769803776
Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                    53876.
Pages active:                                 488745.
Pages wired down:                             176318.
Pages occupied by compressor:                  10000.
swap total = 2048.00M  used = 512.00M  free = 1536.00M  (encrypted)
macmon {"temp":{"cpu_temp_avg":47.25,"gpu_temp_avg":41.5},"ram_usage":1}
disk /dev/disk3s5   482797652 301021876 160870072    66%    /System/Volumes/Data
`);
assert.ok(Math.abs(mac.cpu - 0.1232) < 1e-9);
assert.deepEqual(mac.load, [1.51, 1.89, 2.02]);
assert.equal(mac.mem.used, (488745 + 176318 + 10000) * 16384);
assert.equal(mac.mem.swapTotal, 2048 * 1024 ** 2);
assert.equal(mac.mem.swapUsed, 512 * 1024 ** 2);
assert.deepEqual(mac.temps, { cpu: 47.25, gpu: 41.5 });
assert.equal(mac.disk.path, "/System/Volumes/Data");
assert.deepEqual(parseSample("os mac\n").temps, { cpu: null, gpu: null }, "no macmon: no temperatures");

console.log("sample.js ok");
