// Herdr's status bar (cloned from workspace-status) plus the accounts the shown space works as:
// the Claude Code account and the gh user a terminal in its focused folder gets, direnv included.
// They come from accounts.py next to this file (`account <folder>`), run on the space's machine.
// It also works out which Claude account every Claude agent in a terminal really runs as (from
// its process's CLAUDE_CONFIG_DIR: a work or a personal config) and publishes it in shared
// "accounts.agents" ({ address: account }) for the pane headers and the Agents list. With props
// { publish: true } it does only that and draws nothing: a layout without this bar (Herdr T3) still
// gets the chips.
// On the right: the shown space's machine's cpu, ram and temperatures (system.js), and the bell:
// how many notifications are unread; a click opens their history (the notifications mod). Agent
// alerts go in that history from here: an agent turning blocked while not on screen.

import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, agents, panes, focused, theme, run, window, keys, exec, hc, appHome, readTextFile, shared, setShared, props } from "herdr";
import { logAgentAlerts, toggleHistory, unreadCount } from "./notifylog.js";
import { System, bytes, pct, level, heat } from "./system.js";

const ACCOUNTS = `${appHome()}/mods/status-accounts/accounts.py`;
const STALE_MS = 2 * 60000; // looked up again after this, so a changed .envrc shows
const PALETTE_ACTIONS = ["app.palette", "mod.open:command-palette"];
const PERSONAL = "personal";
const AGENT_ACCOUNTS = "accounts.agents";
const RECHECK_MS = 15000; // an agent's process is looked at again after this (a restart has a new pid)

// Python 3 on a machine: here on Windows the py launcher (its python3 can be the Store's stub);
// python3 elsewhere, and on other machines, whose platform this can't see.
function python(machine) {
  return !machine && window()?.platform === "windows" ? ["py", "-3"] : ["python3"];
}

// The script's source as `python3 -c`: nothing to install on the machine, always this version.
async function bridge(args, machine) {
  const source = await readTextFile(ACCOUNTS);
  const [command, ...pythonArgs] = python(machine);
  const r = await exec(command, [...pythonArgs, "-c", source, ...args], { on: machine });
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().replace(/^accounts: /, ""));
  return JSON.parse(r.stdout);
}

// The shown space's machine and the folder of its focused (else first) terminal.
function currentPlace() {
  const space = spaces().find((s) => s.id === focused()?.space) ?? spaces().find((s) => s.active);
  if (!space) return null;
  const tabs = new Set(space.tabs.map((t) => t.id));
  const all = panes().filter((p) => tabs.has(p.tab) && p.cwd);
  const pane = all.find((p) => p.focused) ?? all.find((p) => p.tab === space.tabs.find((t) => t.active)?.id) ?? all[0];
  return pane ? { machine: space.machine ?? null, folder: pane.cwd } : null;
}

// "~" for home, else the folder's last name: the bar says which folder the accounts are for.
function shortFolder(folder) {
  const name = folder.split("/").filter(Boolean).pop() ?? folder;
  return /^\/(Users|home)\/[^/]+\/?$/.test(folder) ? "~" : name;
}

export default class StatusAccounts extends View {
  init(_props, cx) {
    this.agentChecks = new Map(); // address -> { at, pid, account }
    cx.timer.every(5000, (cx) => this.lookUpAgents(cx));
    this.isPublishOnly = Boolean(props()?.publish);
    if (this.isPublishOnly) return;
    this.accounts = new Map(); // "machine|folder" -> { at, value | error }
    cx.timer.every(1500, (cx) => this.lookUp(cx));
    this.sys = new System();
    this.sys.start(cx);
    this.agentStatuses = null; // address -> status at the last look; null before the first
    cx.timer.every(1500, () => { this.agentStatuses = logAgentAlerts(agents(), this.agentStatuses); });
  }

  bell(t) {
    const unread = unreadCount();
    return h_flex().id("bell").gap(4).items_center().cursor_pointer().hover((s) => s.text_color(t.foreground))
      .tooltip(unread ? `${unread} unread notification${unread === 1 ? "" : "s"}` : "Notifications")
      // Above the press: at the pointer, from the bottom status bar, it would be below the window.
      .on_mouse_down("left", (e) => { this.bellPress = { at: Date.now(), x: e.position.x, y: e.position.y }; })
      .on_click(() => toggleHistory(this.bellPress, { above: true }))
      .child(svg("mods/notifications/icons/bell.svg").size(13).text_color(unread ? t.accent : t.muted))
      .when(unread > 0, (el) => el.child(div().px(5).h(15).flex().items_center().rounded(8).bg(t.accent)
        .text_size(10.5).font_semibold().text_color(t.accent_foreground).child(unread > 99 ? "99+" : String(unread))));
  }

  lookUp(cx) {
    const place = currentPlace();
    if (!place) return;
    const key = `${place.machine}|${place.folder}`;
    const known = this.accounts.get(key);
    if (known && (known.isPending || Date.now() - known.at < STALE_MS)) return;
    this.accounts.set(key, { ...known, isPending: true });
    cx.spawn(async (cx) => {
      try {
        this.accounts.set(key, { at: Date.now(), value: await bridge(["account", place.folder], place.machine) });
      } catch (error) {
        this.accounts.set(key, { at: Date.now(), error: String(error.message ?? error) });
      }
      cx.notify();
    });
  }

  // Claude agents in terminals: the program table calls them "claude"; the agents list has the rest.
  claudeTerminals() {
    const fromPanes = panes().filter((p) => p.terminal && p.program?.key === "claude").map((p) => p.terminal);
    const fromAgents = agents().filter((a) => a.program?.key === "claude" || /claude/i.test(a.app ?? "")).map((a) => a.address);
    return [...new Set([...fromPanes, ...fromAgents])];
  }

  lookUpAgents(cx) {
    if (this.isCheckingAgents) return;
    this.isCheckingAgents = true;
    cx.spawn(async () => {
      const addresses = this.claudeTerminals();
      for (const address of addresses) {
        const known = this.agentChecks.get(address);
        if (known && Date.now() - known.at < RECHECK_MS) continue;
        try {
          const r = await hc(["get", address, "--json"]);
          const pid = r.code === 0 ? JSON.parse(r.stdout).foreground?.pid : null;
          if (!pid) continue;
          const machine = address.includes("/") ? address.split("/")[0] : null;
          const account = known?.pid === pid ? known.account : await bridge(["process-account", String(pid)], machine);
          this.agentChecks.set(address, { at: Date.now(), pid, account });
        } catch (error) {
          this.agentChecks.set(address, { at: Date.now(), pid: null, account: { error: String(error.message ?? error) } });
        }
      }
      for (const address of this.agentChecks.keys()) if (!addresses.includes(address)) this.agentChecks.delete(address);
      const published = Object.fromEntries([...this.agentChecks].map(([address, check]) => [address, check.account]));
      if (JSON.stringify(published) !== JSON.stringify(shared(AGENT_ACCOUNTS) ?? {})) setShared(AGENT_ACCOUNTS, published);
      this.isCheckingAgents = false;
    });
  }

  // The palette key as actually bound, not a hardcoded one; without a
  // binding the hint stays useful ("commands") instead of lying.
  hint(t) {
    const mac = window()?.platform === "macos";
    const mod = { cmd: mac ? "⌘" : "Ctrl+", ctrl: mac ? "⌃" : "Ctrl+", shift: mac ? "⇧" : "Shift+", alt: mac ? "⌥" : "Alt+", option: mac ? "⌥" : "Alt+" };
    const b = keys().find((k) => k.section === "global" && PALETTE_ACTIONS.includes(k.action));
    const parts = b && b.keys.endsWith("--") ? [...b.keys.slice(0, -2).split("-"), "-"] : b?.keys.split("-");
    const key = parts && parts.map((p) => mod[p.toLowerCase()] ?? p.toUpperCase()).join("");
    return key ? `${key}  commands` : "commands";
  }

  accountChips(t) {
    const place = currentPlace();
    const found = place && this.accounts.get(`${place.machine}|${place.folder}`);
    if (!found || (!found.value && !found.error)) return [];
    if (found.error) return [div().id("account-error").text_color(t.blocked).tooltip(found.error).child("accounts: unknown")];
    const { claude, gh, warning } = found.value;
    const isWork = claude.kind === "work";
    const color = isWork ? t.ansi3 : claude.kind === PERSONAL ? t.ansi4 : t.dim;
    const chips = [
      div().id("account-claude").px(7).h(18).flex().items_center().rounded(9).bg(`${color}26`).text_color(color).font_semibold()
        .tooltip(`A new Claude Code in ${place.folder} signs in as ${claude.email || "nobody"} (${claude.configDir}). Running agents show their own account in their pane header.`)
        .child(`${shortFolder(place.folder)}: Claude ${claude.email ? (isWork ? claude.org || claude.email : PERSONAL) : "not signed in"}`),
    ];
    if (gh) chips.push(div().id("account-gh").tooltip(`gh in ${place.folder} acts as ${gh}`).child(`gh ${gh}`));
    if (warning) chips.push(div().id("account-warning").text_color(t.blocked).tooltip(warning).child("⚠ direnv"));
    return chips;
  }

  // cpu, ram and temperatures of the shown space's machine; a reading it can't get stays out.
  machineStats(t) {
    const s = this.sys;
    if (s.error) return [div().id("stats-error").text_color(t.blocked).tooltip(s.error).child("stats: unreachable")];
    const stat = (id, name, value, color, tip) => h_flex().id(id).gap(4).items_center().tooltip(tip)
      .child(div().text_color(t.dim).child(name)).child(div().text_color(color).child(value));
    const items = [];
    if (s.cpu !== null) {
      items.push(stat("stat-cpu", "cpu", pct(s.cpu), level(t, s.cpu), s.load ? `load ${s.load.map((x) => x.toFixed(2)).join("  ")}` : "cpu use"));
    }
    if (s.mem) {
      const m = s.mem, use = m.used / m.total;
      items.push(stat("stat-ram", "ram", `${bytes(m.used)}/${bytes(m.total)}`, level(t, use),
        `${pct(use)} used${m.swapTotal ? ` · swap ${bytes(m.swapUsed)} of ${bytes(m.swapTotal)}` : ""}`));
    }
    for (const [name, celsius] of [["cpu", s.temps.cpu], ["gpu", s.temps.gpu]]) {
      if (celsius !== null) items.push(stat(`stat-${name}-temp`, `${name} °C`, String(Math.round(celsius)), heat(t, celsius), `${name} temperature`));
    }
    return items;
  }

  render() {
    if (this.isPublishOnly) return div();
    const t = theme();
    const space = spaces().find(s => s.active);
    const list = agents();
    const needs = list.filter(a => a.status === "blocked").length;
    const label = (icon, text) => h_flex().gap(6).items_center().child(svg(`mods/workspace-chrome/${icon}.svg`).size(13)).child(text);
    return h_flex().size_full().px(14).gap(16).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted)
      .child(label(space?.machine ? "server" : "monitor", space?.machine ?? "This computer"))
      .when(Boolean(space?.branch), el => el.child(label("branch", space.branch)))
      .children(this.accountChips(t))
      .child(h_flex().gap(6).items_center().child(div().size(6).rounded(3).bg(t.dim)).child(`${list.length} agents`)
        .when(needs > 0, el => el.child(div().text_color(t.blocked).child(`· ${needs} needs you`))))
      .child(div().flex_1())
      .children(this.machineStats(t))
      .child(this.bell(t))
      .child(div().id("palette").text_color(t.dim).on_click(() => run("mod.open", { name: "command-palette" })).child(this.hint(t)));
  }
}
