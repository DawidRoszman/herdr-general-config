import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, agents, panes, machines as appMachines, theme, run, exec, hc, appHome, readTextFile, shared, setShared, window, openOverlay, nextCommand, checking } from "herdr";
import { keyOf } from "./tip.js";
import { machineProfiles, sandboxHosts, shownProfile, coordinatorPlace, liveCoordinators, spaceContext, agentContext, offContext } from "./context.js";

const PROFILES_FILE = `${appHome()}/profiles.json`;
const PROFILES_PY = `${appHome()}/mods/t3-context/profiles.py`;
const ACCOUNTS = `${appHome()}/mods/status-accounts/accounts.py`;
const SHARED_KEY = "context";
const STALE_MS = 2 * 60000;
const RELOAD_MS = 3000;

const python = () => (window()?.platform === "windows" ? ["py", "-3"] : ["python3"]);

async function profilesPy(args) {
  const [command, ...pythonArgs] = python();
  return exec(command, [...pythonArgs, PROFILES_PY, ...args]);
}

async function matchProfile(item) {
  const r = await profilesPy(["match", JSON.stringify([item])]);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().replace(/^profiles: /, ""));
  return JSON.parse(r.stdout)[0].profile;
}

function folderOf(space, allPanes) {
  const tabs = new Set(space.tabs.map((tab) => tab.id));
  return allPanes.find((pane) => tabs.has(pane.tab) && pane.cwd)?.cwd || space.folder;
}

async function folderEnv(machine, folder) {
  const source = await readTextFile(ACCOUNTS);
  if (source === null) throw new Error(`${ACCOUNTS} is missing`);
  const r = await exec("python3", ["-c", source, "account", folder], { on: machine });
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().replace(/^accounts: /, ""));
  const found = JSON.parse(r.stdout);
  return accountEnv({ ...found.claude, profile: found.profile });
}

function accountEnv(account) {
  return account?.configDir ? { CLAUDE_CONFIG_DIR: account.configDir, HERDR_PROFILE: account.profile || null } : null;
}

const editProfiles = (profile) => openOverlay({ mod: "profile-edit", kind: "dialog", width: 760, props: { profile } });

const accountKey = (machine, env) => `${machine ?? ""}|${env?.CLAUDE_CONFIG_DIR ?? ""}|${env?.HERDR_PROFILE ?? ""}`;

async function herdrDo(command, args) {
  const r = await exec("herdr-app", ["do", command, JSON.stringify(args)]);
  let out = {};
  try { out = JSON.parse(r.stdout); } catch {  }
  if (r.code !== 0 || out.error) throw new Error(out.error || r.stderr.trim() || `${command} failed`);
  return out;
}

export default class Context extends View {
  init(_props, cx) {
    this.profiles = null;
    this.sandboxHosts = {};
    this.profilesText = undefined;
    this.errors = {};
    this.machinesKey = null;
    this.folderProfiles = new Map();
    this.accountProfiles = new Map();
    this.coordinators = JSON.parse(localStorage.getItem("coordinators") ?? "{}");
    this.starting = null;
    this.lastSpace = JSON.parse(localStorage.getItem("lastSpace") ?? "{}");
    if (checking()) return;
    this.loadProfiles(cx);
    this.loadSandboxHosts(cx);
    cx.timer.every(RELOAD_MS, (cx) => {
      this.loadProfiles(cx);
      const nextMachinesKey = JSON.stringify(appMachines().map((m) => [m.name, m.layout]));
      if (nextMachinesKey !== this.machinesKey) {
        this.machinesKey = nextMachinesKey;
        this.loadSandboxHosts(cx);
      }
    });
    cx.timer.every(1500, (cx) => { this.lookUpFolders(cx); this.lookUpAccounts(cx); });

    cx.spawn(async (cx) => {
      for (;;) {
        const command = String(await nextCommand());
        if (command === "next") this.switchToNext(cx);
        else if (command.startsWith("coordinator:")) this.openCoordinator(command.slice("coordinator:".length), cx);
      }
    });
  }

  get error() {
    return Object.values(this.errors).find(Boolean) ?? null;
  }

  setError(source, message) {
    const prev = this.errors[source] ?? null;
    if (message) this.errors[source] = message;
    else delete this.errors[source];
    return prev !== (message ?? null);
  }

  loadProfiles(cx) {
    if (this.isLoading) return;
    this.isLoading = true;
    cx.spawn(async (cx) => {
      let hasChanged = false;
      try {
        const text = await readTextFile(PROFILES_FILE);
        if (text !== this.profilesText) {
          const r = await profilesPy(["list"]);
          const listed = JSON.parse(r.stdout || "{}");
          if (r.code !== 0) throw new Error(listed.errors?.join("; ") || r.stderr.trim() || `profiles.py exit ${r.code}`);

          this.profilesText = text;
          this.profiles = listed.profiles;
          this.folderProfiles.clear();
          this.accountProfiles.clear();
          this.setError("profiles", null);
          hasChanged = true;
        }
      } catch (error) {
        hasChanged = this.setError("profiles", `profiles.json: ${error.message ?? error}`) || !this.profiles;
        this.profiles ??= {};
      }
      this.isLoading = false;
      if (hasChanged) cx.notify();
    });
  }

  loadSandboxHosts(cx) {
    if (this.isLoadingHosts) return;
    this.isLoadingHosts = true;
    cx.spawn(async (cx) => {
      let hasChanged = false;
      try {
        const r = await hc(["machine", "ls", "--json"]);
        if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `hc machine ls exit ${r.code}`);
        const nextHosts = sandboxHosts(JSON.parse(r.stdout).machines ?? []);
        if (JSON.stringify(nextHosts) !== JSON.stringify(this.sandboxHosts)) {
          this.sandboxHosts = nextHosts;
          hasChanged = true;
        }
        if (this.setError("hosts", null)) hasChanged = true;
      } catch (error) {
        if (this.setError("hosts", `Machines: ${error.message ?? error}`)) hasChanged = true;
      }
      this.isLoadingHosts = false;
      if (hasChanged) cx.notify();
    });
  }

  names() {
    return Object.keys(this.profiles ?? {});
  }

  current() {
    return shownProfile(localStorage.getItem("current"), this.names());
  }

  live() {
    return liveCoordinators(this.coordinators, this.profiles ?? {});
  }

  isCoordinator(space) {
    return Object.values(this.live()).includes(space.id);
  }

  lookUpFolders(cx) {
    if (!this.names().length) return;
    const allPanes = panes(), machines = machineProfiles(this.profiles, this.sandboxHosts);
    for (const space of spaces()) {
      if (this.isCoordinator(space) || machines[space.machine]) continue;
      const folder = folderOf(space, allPanes);
      if (!folder) continue;
      const key = `${space.machine ?? ""}|${folder}`;
      const known = this.folderProfiles.get(key);
      if (known && (known.isPending || Date.now() - known.at < STALE_MS)) continue;
      this.folderProfiles.set(key, { ...known, isPending: true });
      const lookedUp = this.folderProfiles;
      cx.spawn(async (cx) => {
        let profile = null;
        try {
          profile = await matchProfile({ machine: space.machine ?? null, folder, env: await folderEnv(space.machine, folder) });
          this.setError(`folder:${key}`, null);
        } catch (error) {
          this.setError(`folder:${key}`, `Profile of ${folder}: ${error.message ?? error}`);
        }
        lookedUp.set(key, { at: Date.now(), profile });
        cx.notify();
      });
    }
  }

  lookUpAccounts(cx) {
    if (!this.names().length) return;
    const machines = machineProfiles(this.profiles, this.sandboxHosts), accounts = shared("accounts.agents") ?? {};
    const machineOf = new Map(spaces().map((space) => [space.id, space.machine ?? null]));
    for (const agent of agents()) {
      const machine = machineOf.get(agent.space) ?? null, env = accountEnv(accounts[agent.address]);
      const key = accountKey(machine, env);
      if (machines[machine] || !env || this.accountProfiles.has(key)) continue;
      this.accountProfiles.set(key, { isPending: true });
      const lookedUp = this.accountProfiles;
      cx.spawn(async (cx) => {
        let profile = null;
        try {
          profile = await matchProfile({ machine, env });
          this.setError(`account:${key}`, null);
        } catch (error) {
          this.setError(`account:${key}`, `Profile of ${env.CLAUDE_CONFIG_DIR}: ${error.message ?? error}`);
        }
        lookedUp.set(key, { profile });
        cx.notify();
      });
    }
  }

  publish(allSpaces) {
    const allPanes = panes(), machines = machineProfiles(this.profiles, this.sandboxHosts), accounts = shared("accounts.agents") ?? {};
    const current = this.current(), coordinators = this.live();
    const spaceProfiles = Object.fromEntries(allSpaces.map((space) => [space.id, spaceContext({
      space, coordinators,
      matched: machines[space.machine] ?? this.folderProfiles.get(`${space.machine ?? ""}|${folderOf(space, allPanes)}`)?.profile,
    })]));
    const machineOf = new Map(allSpaces.map((space) => [space.id, space.machine ?? null]));
    const byAgent = {}, agentProfiles = {};
    for (const agent of agents()) {
      const machine = machineOf.get(agent.space) ?? null;
      const matched = machines[machine] ?? this.accountProfiles.get(accountKey(machine, accountEnv(accounts[agent.address])))?.profile;
      if (matched) byAgent[agent.address] = matched;
      agentProfiles[agent.address] = agentContext({ matched, spaceProfile: spaceProfiles[agent.space] });
    }
    const published = {
      current,
      coordinators,
      starting: this.starting,
      offSpaces: offContext(spaceProfiles, current),
      offAgents: offContext(agentProfiles, current),
      offMachines: offContext(machines, current),
      profiles: this.profiles,
      byAgent,
    };
    if (JSON.stringify(published) !== JSON.stringify(shared(SHARED_KEY) ?? null)) setShared(SHARED_KEY, published);
    return published;
  }

  switchTo(context, cx) {
    if (context === this.current()) return;
    localStorage.setItem("current", context);
    const allSpaces = spaces(), allPanes = panes(), coordinators = this.live();
    const machines = machineProfiles(this.profiles, this.sandboxHosts);
    const spaceProfiles = Object.fromEntries(allSpaces.map((space) => [space.id, spaceContext({
      space, coordinators,
      matched: machines[space.machine] ?? this.folderProfiles.get(`${space.machine ?? ""}|${folderOf(space, allPanes)}`)?.profile,
    })]));
    const offForTarget = new Set(offContext(spaceProfiles, context));
    const homeId = shared("t3-home.space");
    const valid = new Set(allSpaces.filter((s) => s.id !== homeId && !offForTarget.has(s.id)).map((s) => s.id));
    const own = Object.entries(coordinators).filter(([key]) => coordinatorPlace(key).profile === context).map(([, id]) => id);
    const fallback = allSpaces.find((s) => valid.has(s.id))?.id;
    const next = [this.lastSpace[context], ...own, fallback].find((id) => id && valid.has(id));
    if (next) run("space.select", { id: next });
    cx.notify();
  }

  switchToNext(cx) {
    const names = this.names();
    if (names.length < 2) return;
    this.switchTo(names[(names.indexOf(this.current()) + 1) % names.length], cx);
  }

  openCoordinator(key, cx) {
    const id = this.coordinators[key];
    if (spaces().some((space) => space.id === id)) {
      run("space.select", { id });
      return;
    }
    if (this.starting) return;
    const { profile: context, project: name } = coordinatorPlace(key);
    const project = this.profiles?.[context]?.projects?.[name], coordinator = project?.coordinator;
    if (!coordinator) {
      this.setError("coordinator", `No coordinator for ${key}: give the project a "coordinator" folder in profiles.json`);
      cx.notify();
      return;
    }
    this.setError("coordinator", null);

    const argv = [...python(), PROFILES_PY, "run", context, "--", "claude"];
    this.starting = key;
    cx.notify();
    cx.spawn(async (cx) => {
      try {

        const { space, tab: first } = await herdrDo("space.new", { name: `Coordinator · ${project.label}`, machine: "", folder: coordinator.folder, tab: "terminal" });

        await herdrDo("tab.new", { space, name: "coordinator", ...(shared("t3-chat.enabled") === false ? { folder: coordinator.folder, argv } : { mod: "t3-chat", props: { view: "chat", folder: coordinator.folder, machine: null, argv, keepName: true } }) });
        await herdrDo("tab.close", { id: first, confirmed: true });
        this.coordinators = { ...this.live(), [key]: space };
        localStorage.setItem("coordinators", JSON.stringify(this.coordinators));
        await herdrDo("space.select", { id: space });
      } catch (error) {
        this.setError("coordinator", `Coordinator: ${error.message ?? error}`);
      }
      this.starting = null;
      cx.notify();
    });
  }

  rememberShown(allSpaces, published) {
    const active = allSpaces.find((space) => space.active)?.id;
    if (!active || !published.current || published.offSpaces.includes(active) || this.lastSpace[published.current] === active) return;
    this.lastSpace = { ...this.lastSpace, [published.current]: active };
    localStorage.setItem("lastSpace", JSON.stringify(this.lastSpace));
  }

  switcher(t, current) {
    const key = keyOf("t3-context.next");
    const option = (context) => {
      const isOn = context === current, label = this.profiles[context].label;
      const tip = isOn ? `${label} is shown` : `Show ${label}`;
      return div().id(`context-${context}`).flex_1().h(26).flex().items_center().justify_center().rounded(6)
        .text_size(12).font_medium().text_color(isOn ? t.foreground : t.dim)
        .when(isOn, (el) => el.bg(t.selected)).when(!isOn, (el) => el.hover((s) => s.text_color(t.foreground)))
        .role("button").accessibility_label(`Show ${label}`).tooltip(key ? `${tip}  ·  ${key} next profile` : tip)
        .on_click((_e, cx) => this.switchTo(context, cx))
        .on_mouse_down("right", () => editProfiles(context))
        .child(div().min_w(0).truncate().child(label));
    };
    const gear = div().id("context-edit").flex_none().size(26).flex().items_center().justify_center().rounded(6)
      .text_color(this.error ? t.blocked : t.dim).hover((s) => s.text_color(t.foreground))
      .role("button").accessibility_label("Edit profiles").tooltip(this.error ?? "Edit profiles")
      .on_click(() => editProfiles(current))
      .child(svg("mods/workspace-chrome/settings.svg").size(13));
    return h_flex().id("context-switch").h(30).p(2).gap(2).rounded(8).bg(t.hover)
      .children(this.names().map(option))
      .child(gear);
  }

  setUpRow(t) {
    return h_flex().id("context-set-up").h(30).px(10).gap(8).items_center().rounded(8).bg(t.hover)
      .text_size(12).text_color(this.error ? t.blocked : t.muted).hover((s) => s.text_color(t.foreground))
      .role("button").accessibility_label("Set up profiles")
      .when(Boolean(this.error), (el) => el.tooltip(this.error))
      .on_click(() => editProfiles(null))
      .child(svg("mods/workspace-chrome/settings.svg").size(13))
      .child(div().flex_1().min_w(0).truncate().child(this.error ? "profiles.json has a problem" : "Set up profiles"));
  }

  render() {
    const t = theme(), allSpaces = spaces();
    const frame = v_flex().size_full().bg(t.chrome).px(8).pt(4).gap(6);
    if (!this.profiles) return frame;
    const published = this.publish(allSpaces);
    this.rememberShown(allSpaces, published);
    if (!published.current) return frame.child(this.setUpRow(t));
    return frame.child(this.switcher(t, published.current));
  }
}
