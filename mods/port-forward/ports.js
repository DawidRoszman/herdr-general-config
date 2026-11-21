const IGNORED_PORTS = new Set([22, 53]);
const WILDCARD_ADDRESSES = new Set(["0.0.0.0", "*", "[::]", "::"]);

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

      address: WILDCARD_ADDRESSES.has(boundAddress) ? "127.0.0.1" : boundAddress,
      process: line.match(/users:\(\("([^"]+)"/)?.[1] ?? "",
    });
  }
  return [...byPort.values()].sort((a, b) => a.port - b.port);
}

export function parseMasterPid(checkOutput) {
  const pid = checkOutput.match(/pid=(\d+)/)?.[1];
  return pid ? Number(pid) : null;
}

export function parseListeningLocalPorts(lsofOutput) {
  const ports = new Set();
  for (const line of lsofOutput.split("\n")) {
    if (!line.startsWith("n")) continue;
    const port = Number(line.slice(line.lastIndexOf(":") + 1));
    if (Number.isInteger(port)) ports.add(port);
  }
  return ports;
}

export function parseListeningLocalPortsFromSs(ssOutput, pid) {
  const ports = new Set();
  const marker = `pid=${pid},`;
  for (const line of ssOutput.split("\n")) {
    if (!line.includes(marker)) continue;
    const columns = line.trim().split(/\s+/);
    if (columns[0] !== "LISTEN" || !columns[3]) continue;
    const port = Number(columns[3].slice(columns[3].lastIndexOf(":") + 1));
    if (Number.isInteger(port)) ports.add(port);
  }
  return ports;
}

export function forwardSpec({ port, address, remotePort = port }) {
  return `${port}:${address}:${remotePort}`;
}

export function sandboxOf(target) {
  const match = /sandbox-via\.sh'?\s+'?([^'\s]+)'?\s+'?([a-z][a-z0-9-]*)'?$/.exec(target ?? "");
  return match ? { host: match[1], name: match[2] } : null;
}

const LOOPBACK_URL = /^(https?):\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::(\d{1,5}))?(?:[/?#]|$)/i;
export function loopbackPort(url) {
  const match = LOOPBACK_URL.exec(url);
  if (!match) return null;
  const port = match[2] ? Number(match[2]) : match[1].toLowerCase() === "https" ? 443 : 80;
  return port > 0 && port < 65536 ? port : null;
}

export function sandboxHostPorts(tables, port) {
  return [...new Set(tables.split("\n").map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([inner, outer]) => inner === port && Number.isInteger(outer)).map(([, outer]) => outer))];
}
