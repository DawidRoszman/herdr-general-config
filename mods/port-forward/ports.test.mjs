import assert from "node:assert/strict";
import { parseListening, parseMasterPid, parseListeningLocalPorts, forwardSpec } from "./ports.js";

const ss = `
LISTEN 0 4096 100.64.0.10:443 0.0.0.0:*
LISTEN 0 128 0.0.0.0:22 0.0.0.0:*
LISTEN 0 4096 127.0.0.53%lo:53 0.0.0.0:*
LISTEN 0 511 127.0.0.1:3773 0.0.0.0:* users:(("node-MainThread",pid=1864380,fd=23))
LISTEN 0 511 0.0.0.0:8080 0.0.0.0:*
LISTEN 0 511 [::]:8080 [::]:*
LISTEN 0 511 [::1]:9000 [::]:*
`;
assert.deepEqual(parseListening(ss), [
  { port: 443, address: "100.64.0.10", process: "" },
  { port: 3773, address: "127.0.0.1", process: "node-MainThread" },
  { port: 8080, address: "127.0.0.1", process: "" },
  { port: 9000, address: "[::1]", process: "" },
]);
assert.equal(parseMasterPid("Master running (pid=4321)\r\n"), 4321);
assert.equal(parseMasterPid("Control socket connect(...): No such file or directory"), null);
assert.deepEqual([...parseListeningLocalPorts("p4321\nf5\nn127.0.0.1:3000\nf6\nn[::1]:3000\nn*:8080\n")], [3000, 8080]);
assert.equal(forwardSpec({ port: 3773, address: "127.0.0.1" }), "3773:127.0.0.1:3773");
console.log("ports.js ok");
