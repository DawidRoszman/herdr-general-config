// Pure parsing for the port-forward dialog, kept apart from IO so it can be checked
// with `node ports.test.mjs` in this folder.

// Ports nobody wants tunnelled: ssh itself and the resolver stubs.
const IGNORED_PORTS = new Set([22, 53]);
const WILDCARD_ADDRESSES = new Set(["0.0.0.0", "*", "[::]", "::"]);

// `ss -ltn[p]H` lines: "LISTEN 0 511 127.0.0.1:3773 0.0.0.0:* users:(("node",pid=1,fd=23))".
export function parseListening(ssOutput) {
  const byPort = new Map();
  for (const line of ssOutput.split("\n")) {
    const columns = line.trim().split(/\s+/);
    if (columns[0] !== "LISTEN" || !columns[3]) continue;
    const separator = columns[3].lastIndexOf(":");
    const port = Number(columns[3].slice(separator + 1));
    const boundAddress = columns[3].slice(0, separator).replace(/%.*$/, "");
    if (!Number.isInteger(port) || IGNORED_PORTS.has(port) || byPort.has(port)) continue;
    byPort.set(port, {
      port,
      // A service bound to every interface answers on loopback; one bound to a
      // single address (a tailnet IP) only answers there.
      address: WILDCARD_ADDRESSES.has(boundAddress) ? "127.0.0.1" : boundAddress,
      process: line.match(/users:\(\("([^"]+)"/)?.[1] ?? "",
    });
  }
  return [...byPort.values()].sort((a, b) => a.port - b.port);
}

// `ssh -O check` answers "Master running (pid=1234)".
export function parseMasterPid(checkOutput) {
  const pid = checkOutput.match(/pid=(\d+)/)?.[1];
  return pid ? Number(pid) : null;
}

// `lsof -Fn` lines: "n127.0.0.1:3000", "n[::1]:3000", "n*:3000".
export function parseListeningLocalPorts(lsofOutput) {
  const ports = new Set();
  for (const line of lsofOutput.split("\n")) {
    if (!line.startsWith("n")) continue;
    const port = Number(line.slice(line.lastIndexOf(":") + 1));
    if (Number.isInteger(port)) ports.add(port);
  }
  return ports;
}

// Same port number on both ends, so a remote http://localhost:3000 is local :3000 too.
export function forwardSpec({ port, address }) {
  return `${port}:${address}:${port}`;
}
