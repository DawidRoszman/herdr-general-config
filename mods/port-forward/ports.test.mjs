import assert from "node:assert/strict";
import { parseListening, parseMasterPid, parseListeningLocalPorts, forwardSpec, loopbackPort, sandboxOf, sandboxHostPorts } from "./ports.js";

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

assert.equal(loopbackPort("http://localhost:5173/login?x=1"), 5173);
assert.equal(loopbackPort("http://127.0.0.1:8080"), 8080);
assert.equal(loopbackPort("http://[::1]:9000#top"), 9000);
assert.equal(loopbackPort("http://0.0.0.0:3000/"), 3000);
assert.equal(loopbackPort("https://localhost/"), 443);
assert.equal(loopbackPort("HTTP://LOCALHOST:3000"), 3000);
assert.equal(loopbackPort("http://localhost.evil.com:3000/"), null, "only loopback itself");
assert.equal(loopbackPort("http://example.com:3000/"), null);
assert.equal(loopbackPort("http://localhost:70000/"), null);
assert.equal(loopbackPort("file:///tmp/x"), null);
console.log("loopbackPort: ok");

assert.equal(forwardSpec({ port: 8080, address: "127.0.0.1", remotePort: 20000 }), "8080:127.0.0.1:20000");
assert.deepEqual(sandboxOf("'/Users/me/.config/herdr-app/scripts/sandbox-via.sh' 'work-box' 'shop-155'"), { host: "work-box", name: "shop-155" });
assert.deepEqual(sandboxOf("/x/sandbox-via.sh box shop-1"), { host: "box", name: "shop-1" });
assert.equal(sandboxOf("work-box"), null);
assert.equal(sandboxOf(undefined), null);
console.log("sandboxOf: ok");

assert.deepEqual(sandboxHostPorts("8080 20000\n3000 20002\n8080 20001\n", 8080), [20000, 20001]);
assert.deepEqual(sandboxHostPorts("3000 20002\n", 8080), []);
assert.deepEqual(sandboxHostPorts("", 3000), []);
console.log("sandboxHostPorts: ok");
