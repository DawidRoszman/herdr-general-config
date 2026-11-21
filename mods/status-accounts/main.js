import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, agents, panes, focused, theme, run, window, keys, exec, hc, appHome, readTextFile, shared, setShared, props, checking } from "herdr";
import { toggleHistory, unreadCount } from "./notifylog.js";
import { System, bytes, pct, level, heat } from "./system.js";
import { USAGE_SHARED_KEY, shouldRefresh, parseClaudeAccounts, claudeAccountFor, claudeAccountsOfProfiles, fetchClaudeUsage, fetchCodexUsage, usageColor, percentText, windowLine, asOf } from "./usage.js";

const ACCOUNTS = `${appHome()}/mods/status-accounts/accounts.py`;
const CONFIG = `${appHome()}/mods/status-accounts/config.json`;

const usageCache = () => shared(USAGE_SHARED_KEY) ?? {};
const setUsage = (key, entry) => setShared(USAGE_SHARED_KEY, { ...usageCache(), [key]: entry });
const STALE_MS = 2 * 60000;
const PALETTE_ACTIONS = ["app.palette", "mod.open:command-palette"];
const PERSONAL = "personal";
const AGENT_ACCOUNTS = "accounts.agents";
const RECHECK_MS = 15000;

function python(machine) {
  return !machine && window()?.platform === "windows" ? ["py", "-3"] : ["python3"];
}

async function bridge(args, machine) {
  const source = await readTextFile(ACCOUNTS);
  const [command, ...pythonArgs] = python(machine);
  const r = await exec(command, [...pythonArgs, "-c", source, ...args], { on: machine });
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().replace(/^accounts: /, ""));
  return JSON.parse(r.stdout);
}

function currentPlace() {
  const space = spaces().find((s) => s.id === focused()?.space) ?? spaces().find((s) => s.active);
  if (!space) return null;
  const tabs = new Set(space.tabs.map((t) => t.id));
  const all = panes().filter((p) => tabs.has(p.tab) && p.cwd);
  const pane = all.find((p) => p.focused) ?? all.find((p) => p.tab === space.tabs.find((t) => t.active)?.id) ?? all[0];
  return pane ? { machine: space.machine ?? null, folder: pane.cwd, terminal: pane.terminal } : null;
}

function shortFolder(folder) {
  const name = folder.split("/").filter(Boolean).pop() ?? folder;
  return /^\/(Users|home)\/[^/]+\/?$/.test(folder) ? "~" : name;
}

const accountName = (account) => (account.kind === "work" ? account.org || account.email : PERSONAL);

const profileNamed = (name) => (name && shared("context")?.profiles?.[name]) || null;

function claudeChip(t, account, profile, label, tooltip) {
  const color = profile ? t[profile.color] ?? t.dim : account.kind === "work" ? t.ansi3 : account.kind === PERSONAL ? t.ansi4 : t.dim;
  return div().id("account-claude").px(7).h(18).flex().items_center().rounded(9).bg(`${color}26`).text_color(color).font_semibold()
    .tooltip(tooltip).child(label);
}

export default class StatusAccounts extends View {
  init(_props, cx) {
    this.agentChecks = new Map();
    this.isPublishOnly = Boolean(props()?.publish);
    this.hasBell = props()?.bell !== false;
    this.accounts = new Map();
    this.sys = new System();
    this.configAccounts = null;
    this.claudeConfigError = null;
    if (checking()) return;
    cx.timer.every(5000, (cx) => this.lookUpAgents(cx));
    if (this.isPublishOnly) return;
    cx.timer.every(1500, (cx) => this.lookUp(cx));
    this.sys.start(cx);
    cx.spawn(async (cx) => {
      try {
        this.configAccounts = parseClaudeAccounts(await readTextFile(CONFIG));
      } catch (error) {
        this.claudeConfigError = `${CONFIG}: ${error.message ?? error}`;
      }
      this.refreshUsage(cx);
      cx.notify();
    });
    cx.timer.every(5000, (cx) => this.refreshUsage(cx));
  }

  bell(t) {
    const unread = unreadCount();
    return h_flex().id("bell").gap(4).items_center().cursor_pointer().hover((s) => s.text_color(t.foreground))
      .tooltip(unread ? `${unread} unread notification${unread === 1 ? "" : "s"}` : "Notifications")

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

  claudeTerminals() {
    const fromPanes = panes().filter((p) => p.terminal && p.program?.key === "claude").map((p) => p.terminal);
    const fromAgents = agents().filter((a) => a.program?.key === "claude" || /claude/i.test(a.app ?? "")).map((a) => a.address);
    return [...new Set([...fromPanes, ...fromAgents])];
  }

  lookUpAgents(cx) {
    if (this.isCheckingAgents) return;
    this.isCheckingAgents = true;
    cx.spawn(async () => {
      try {
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
      } finally {
        this.isCheckingAgents = false;
      }
    });
  }

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
    if (!place) return [];
    const agent = place.terminal && (shared(AGENT_ACCOUNTS) ?? {})[place.terminal];
    const found = this.accounts.get(`${place.machine}|${place.folder}`);
    const chips = [];
    if (agent?.email) {
      const profile = profileNamed(shared("context")?.byAgent?.[place.terminal] ?? agent.profile);
      chips.push(claudeChip(t, agent, profile, `Claude ${profile?.badge ?? accountName(agent)}`,
        `This agent (${place.terminal}) runs as ${agent.email} (${agent.configDir}), from its own CLAUDE_CONFIG_DIR.`));
    } else if (found?.error) {
      return [div().id("account-error").text_color(t.blocked).tooltip(found.error).child("accounts: unknown")];
    } else if (found?.value) {
      const { claude } = found.value, profile = profileNamed(found.value.profile);
      chips.push(claudeChip(t, claude, profile, `${shortFolder(place.folder)}: Claude ${claude.email ? profile?.badge ?? accountName(claude) : "not signed in"}`,
        `A new terminal in ${place.folder} gets Claude Code as ${claude.email || "nobody"} (${claude.configDir}).`));
    }
    const { gh, warning } = found?.value ?? {};
    if (gh) chips.push(div().id("account-gh").tooltip(`gh in a new terminal in ${place.folder} acts as ${gh}`).child(`gh ${gh}`));
    if (warning) chips.push(div().id("account-warning").text_color(t.blocked).tooltip(warning).child("⚠ direnv"));
    return chips;
  }

  claudeAccounts() {
    return claudeAccountsOfProfiles(shared("context")?.profiles) ?? this.configAccounts;
  }

  usageContext() {
    const context = shared("context")?.current;
    if (context) return context;
    const place = currentPlace();
    return place && this.accounts.get(`${place.machine}|${place.folder}`)?.value?.claude.kind;
  }

  shownAgent() {
    const terminal = currentPlace()?.terminal;
    if (!terminal) return null;
    const pane = panes().find((p) => p.terminal === terminal);
    const agent = agents().find((a) => a.address === terminal);
    const names = [pane?.program?.key, agent?.program?.key, agent?.app].filter(Boolean).join(" ");
    if (/claude/i.test(names)) return "claude";
    if (/codex/i.test(names)) return "codex";
    return agent ? agent.program?.name ?? agent.app ?? "agent" : null;
  }

  usageClaudeAccount() {
    const terminal = currentPlace()?.terminal;
    const own = terminal && (shared(AGENT_ACCOUNTS) ?? {})[terminal];
    const accounts = this.claudeAccounts();
    if (own?.email) {
      const name = shared("context")?.byAgent?.[terminal] ?? own.profile;
      const known = accounts && Object.entries(accounts).find(([n, dir]) => n === name || (dir ?? null) === (own.configDir ?? null));
      return known ? { name: known[0], configDir: known[1] } : { name: own.configDir ?? "default", configDir: own.configDir ?? null };
    }
    return accounts && claudeAccountFor(this.usageContext(), accounts);
  }

  refreshUsage(cx) {
    const shown = this.shownAgent(), account = shown === "claude" && this.usageClaudeAccount();
    const sources = shown === "codex" ? [["codex", () => fetchCodexUsage({ exec })]] : [];
    if (account) sources.push([`claude:${account.name}`, () => fetchClaudeUsage(account.configDir, { exec, fetch })]);
    for (const [key, load] of sources) {
      const known = usageCache()[key];
      if (!shouldRefresh(known, Date.now())) continue;
      setUsage(key, { ...known, claimedAt: Date.now() });
      cx.spawn(async (cx) => {
        try {
          setUsage(key, { at: Date.now(), value: await load() });
        } catch (error) {

          setUsage(key, { at: Date.now(), value: known?.value, error: String(error.message ?? error), retryAt: error.retryAt ?? null });
        }
        cx.notify();
      });
    }
  }

  usageChip(t, id, name, entry, about) {
    const value = entry?.value;
    const figure = (label, w) => h_flex().gap(3).child(div().text_color(t.dim).child(label))
      .child(div().text_color(usageColor(t, w?.percent)).child(percentText(w)));
    const tip = value
      ? [about, windowLine("5-hour", value.fiveHour), windowLine("Weekly", value.week), asOf(value.at),
        ...(entry.error ? [`Last refresh failed: ${entry.error}`] : [])].join("\n")
      : `${about}\n${entry?.error ?? "Loading…"}`;
    return h_flex().id(id).gap(5).items_center().tooltip(tip)
      .child(div().text_color(t.dim).child(name))
      .child(figure("5h", value?.fiveHour)).child(div().text_color(t.dim).child("·")).child(figure("wk", value?.week));
  }

  usageChips(t) {
    const shown = this.shownAgent();
    if (!shown) return [];
    if (shown === "codex") return [this.usageChip(t, "usage-codex", "Codex", usageCache().codex, "Codex, from its last turn's log in ~/.codex/sessions")];
    if (shown !== "claude") {
      return [div().id("usage-other").text_color(t.dim).tooltip(`No usage source for ${shown}: only Claude Code and Codex report their limits.`).child(`${shown}: no usage data`)];
    }
    const context = this.usageContext();
    const accounts = this.claudeAccounts(), account = this.usageClaudeAccount();
    const claude = account ? usageCache()[`claude:${account.name}`]
      : this.claudeConfigError ? { error: this.claudeConfigError }
      : accounts ? { error: `No Claude account for ${context ?? "the shown folder"} in profiles.json or config.json` }
      : null;
    const about = account ? `Claude ${account.name} account (${account.configDir ?? "~/.claude"}), from Claude Code's usage endpoint` : "Claude";
    return [this.usageChip(t, "usage-claude", "Claude", claude, about)];
  }

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

    const offAgents = new Set(shared("context")?.offAgents ?? []);
    const list = agents().filter((a) => !offAgents.has(a.address));
    const needs = list.filter(a => a.status === "blocked").length;
    const label = (icon, text) => h_flex().gap(6).items_center().child(svg(`mods/workspace-chrome/${icon}.svg`).size(13)).child(text);
    return h_flex().size_full().px(14).gap(16).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted)
      .child(label(space?.machine ? "server" : "monitor", space?.machine ?? "This computer"))
      .when(Boolean(space?.branch), el => el.child(label("branch", space.branch)))
      .children(this.accountChips(t))
      .child(h_flex().gap(6).items_center().child(div().size(6).rounded(3).bg(t.dim)).child(`${list.length} agents`)
        .when(needs > 0, el => el.child(div().text_color(t.blocked).child(`· ${needs} needs you`))))
      .child(div().flex_1())
      .children(this.usageChips(t))
      .children(this.machineStats(t))
      .when(this.hasBell, (el) => el.child(this.bell(t)))
      .child(div().id("palette").text_color(t.dim).on_click(() => run("mod.open", { name: "command-palette" })).child(this.hint(t)));
  }
}
