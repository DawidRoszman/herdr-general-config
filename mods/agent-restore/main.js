import { View, div } from "gpui-kit";
import { agents, terminals, hc, machines, notify, checking } from "herdr";

// The core gives a lost terminal a fresh shell at the same address, so a changed
// shell pid is the only sign that a reboot (not the person) ended the agent.
const RESUME_COMMANDS = {
  "claude-code": "claude --continue",
  codex: "codex resume --last",
};
const RESUME_LABEL = "herdr.resume";
const PROMPT_SETTLE_MS = 1000;

async function describeTerminal(address) {
  const result = await hc(["get", address, "--json"]);
  if (result.code !== 0) throw new Error(`hc get ${address}: ${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout);
}

async function setResumeLabel(address, value) {
  const result = await hc(["label", address, `${RESUME_LABEL}=${value}`]);
  if (result.code !== 0) throw new Error(`hc label ${address}: ${result.stderr || result.stdout}`);
}

// Between loss and recovery the core reports no pid; acting then sends input nowhere.
async function waitForShell(cx, address) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const terminal = await describeTerminal(address);
    if (terminal.pid != null) return terminal;
    await cx.sleep(1000);
  }
  throw new Error(`${address}: the core never gave it a new shell`);
}

// A recovered login shell drops input pasted before it draws its first prompt.
async function waitForPrompt(cx, address) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const screen = await hc(["read", address, "--lines", "0"]);
    if (screen.code === 0 && screen.stdout.trim()) {
      await cx.sleep(PROMPT_SETTLE_MS);
      return;
    }
    await cx.sleep(1000);
  }
  throw new Error(`${address}: recovered shell never drew a prompt`);
}

// A terminal on another machine is addressed "<machine>/<id>"; one here has no machine part.
function isMachineUp(address) {
  if (!address.includes("/")) return true;
  const name = address.slice(0, address.indexOf("/"));
  return machines().some((machine) => machine.name === name && machine.layout === "ready");
}

function parseResumeLabel(value) {
  const separator = value.lastIndexOf(":");
  if (separator < 0) return { app: "", shellPid: NaN };
  return { app: value.slice(0, separator), shellPid: Number(value.slice(separator + 1)) };
}

const RECONCILE_BACKOFF_MS = 10000;

export default class AgentRestore extends View {
  init() {
    this.addressesInFlight = new Set();
    this.cooldownUntil = new Map(); // address -> timestamp until next reconcile attempt
    this.lastFailures = new Map(); // address -> the error last notified, so a retry that fails the same way stays quiet
  }

  render(cx) {
    if (checking()) return div();
    const now = Date.now();
    const liveAgentApps = new Map(agents().map((agent) => [agent.address, agent.app]));
    for (const terminal of terminals()) {
      if (terminal.state !== "live") continue;
      const label = terminal.labels?.[RESUME_LABEL];
      const app = liveAgentApps.get(terminal.address);
      if (app && RESUME_COMMANDS[app] && parseResumeLabel(label ?? "").app !== app) {
        this.track(cx, terminal.address, () => this.remember(terminal.address, app));
      } else if (label && !liveAgentApps.has(terminal.address) && (this.cooldownUntil.get(terminal.address) ?? 0) <= now) {
        this.track(cx, terminal.address, (cx) => this.reconcile(cx, terminal.address, label));
      }
    }
    return div();
  }

  track(cx, address, work) {
    if (this.addressesInFlight.has(address)) return;
    this.addressesInFlight.add(address);
    cx.spawn(async (cx) => {
      try {
        await work(cx);
        this.lastFailures.delete(address);
      } catch (error) {
        // The next live-data change retries, e.g. once an unreachable machine is back. A machine
        // that is off fails every retry: say nothing until it is back, and each failure once.
        if (!isMachineUp(address) || this.lastFailures.get(address) === error.message) return;
        this.lastFailures.set(address, error.message);
        notify({ title: "Agent restore failed", body: error.message, level: "error" });
      } finally {
        this.addressesInFlight.delete(address);
      }
    });
  }

  async remember(address, app) {
    const { pid } = await describeTerminal(address);
    await setResumeLabel(address, `${app}:${pid}`);
  }

  async reconcile(cx, address, label) {
    const { app, shellPid } = parseResumeLabel(label);
    const command = RESUME_COMMANDS[app];
    if (!command || !Number.isFinite(shellPid)) {
      await setResumeLabel(address, "");
      return;
    }
    const terminal = await waitForShell(cx, address);
    const isRecoveredShell = terminal.pid !== shellPid;
    const hasAgentExitedNormally = !isRecoveredShell && terminal.foreground?.pid === terminal.pid;
    if (!isRecoveredShell && !hasAgentExitedNormally) {
      this.cooldownUntil.set(address, Date.now() + RECONCILE_BACKOFF_MS);
      return;
    }

    this.cooldownUntil.delete(address);
    await setResumeLabel(address, "");
    if (!isRecoveredShell) return;

    await waitForPrompt(cx, address);
    const result = await hc(["send", address, command]);
    if (result.code !== 0) throw new Error(`hc send ${address}: ${result.stderr || result.stdout}`);
    notify({ title: "Agent restored", body: `${command} in ${terminal.cwd ?? address}`, level: "info" });
  }
}
