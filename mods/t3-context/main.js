// The sidebar's profile switch (Work | Personal | ...) and the shown profile's coordinator agent.
//
// Profiles are the app home's profiles.json, read through profiles.py beside this file (`list`),
// which also says which profile a folder or an account belongs to (`match`). This mod works out
// which profile every space and agent is in (context.js) and publishes shared "context":
// { current, coordinators, offSpaces, offAgents, offMachines, profiles, byAgent }. The Spaces,
// Agents and Inbox lists hide what is "off"; profiles (name -> profile) and byAgent (address ->
// the profile its own machine or process says) are for mods that show a profile.
// A space on a shared machine (one in no profile) goes by its folder and by the accounts a new
// terminal there gets (status-accounts' accounts.py).
//
// A coordinator is a space on this Mac per profile, started in the profile's "coordinator" folder.
// Its id is kept here, so it shows as the pinned row rather than in the Spaces list.
//
// `t3-context.next` shows the next profile. The gear opens the profile-edit dialog on the shown profile; without profiles a "Set up profiles"
// row does, and nothing is hidden.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, agents, panes, theme, run, exec, appHome, readTextFile, shared, setShared, window, openOverlay, nextCommand } from "herdr";
import { keyOf } from "./tip.js";
import { machineProfiles, shownProfile, spaceContext, agentContext, offContext } from "./context.js";

const PROFILES_FILE = `${appHome()}/profiles.json`;
const PROFILES_PY = `${appHome()}/mods/t3-context/profiles.py`;
const ACCOUNTS = `${appHome()}/mods/status-accounts/accounts.py`;
const SHARED_KEY = "context";
const STALE_MS = 2 * 60000; // a folder's accounts are looked up again after this, so a changed .envrc shows
const RELOAD_MS = 3000; // profiles.json is read again this often; it is listed again when its text changed or the last listing failed

// Python 3 here: on Windows the py launcher (its python3 can be the Store's stub).
const python = () => (window()?.platform === "windows" ? ["py", "-3"] : ["python3"]);

async function profilesPy(args) {
  const [command, ...pythonArgs] = python();
  return exec(command, [...pythonArgs, PROFILES_PY, ...args]);
}

// profiles.py's `match` for one { machine, folder, env }: the profile's name, or null.
async function matchProfile(item) {
  const r = await profilesPy(["match", JSON.stringify([item])]);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().replace(/^profiles: /, ""));
  return JSON.parse(r.stdout)[0].profile;
}

// The folder a space works in now: its first terminal's, else the one it was made in.
function folderOf(space, allPanes) {
  const tabs = new Set(space.tabs.map((tab) => tab.id));
  return allPanes.find((pane) => tabs.has(pane.tab) && pane.cwd)?.cwd || space.folder;
}

// The environment a new terminal in folder gets, as far as profiles go: accounts.py's `account
// <folder>` on the space's machine, as status-accounts runs it (nothing to install there).
async function folderEnv(machine, folder) {
  const source = await readTextFile(ACCOUNTS);
  if (source === null) throw new Error(`${ACCOUNTS} is missing`);
  const r = await exec("python3", ["-c", source, "account", folder], { on: machine });
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().replace(/^accounts: /, ""));
  const found = JSON.parse(r.stdout);
  return accountEnv({ ...found.claude, profile: found.profile });
}

// What accounts.py knows of an environment, as profiles.py's match takes it; null when unknown.
function accountEnv(account) {
  return account?.configDir ? { CLAUDE_CONFIG_DIR: account.configDir, HERDR_PROFILE: account.profile || null } : null;
}

// The dialog that creates and edits profiles (the profile-edit mod), on a profile or on a new one.
const editProfiles = (profile) => openOverlay({ mod: "profile-edit", kind: "dialog", width: 760, props: { profile } });

const accountKey = (machine, env) => `${machine ?? ""}|${env?.CLAUDE_CONFIG_DIR ?? ""}|${env?.HERDR_PROFILE ?? ""}`;

async function herdrDo(command, args) {
  const r = await exec("herdr-app", ["do", command, JSON.stringify(args)]);
  let out = {};
  try { out = JSON.parse(r.stdout); } catch { /* reported below with stderr */ }
  if (r.code !== 0 || out.error) throw new Error(out.error || r.stderr.trim() || `${command} failed`);
  return out;
}

export default class Context extends View {
  init(_props, cx) {
    this.profiles = null; // name -> profile, from profiles.py list; null until read
    this.profilesText = undefined; // profiles.json as last listed
    this.error = null; // the last failure, shown on the switch
    this.folderProfiles = new Map(); // "machine|folder" -> { at, profile, isPending }
    this.accountProfiles = new Map(); // "machine|config dir|HERDR_PROFILE" -> { profile, isPending }
    this.coordinators = JSON.parse(localStorage.getItem("coordinators") ?? "{}"); // profile -> space id
    this.lastSpace = JSON.parse(localStorage.getItem("lastSpace") ?? "{}"); // profile -> space shown last
    this.loadProfiles(cx);
    cx.timer.every(RELOAD_MS, (cx) => this.loadProfiles(cx));
    cx.timer.every(1500, (cx) => { this.lookUpFolders(cx); this.lookUpAccounts(cx); });
    // `t3-context.next` (keys.json, the palette): the next profile in the switch.
    cx.spawn(async (cx) => {
      for (;;) if (await nextCommand() === "next") this.switchToNext(cx);
    });
  }

  // An invalid profiles.json keeps the profiles last read, and says why on the switch.
  loadProfiles(cx) {
    if (this.isLoading) return;
    this.isLoading = true;
    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(PROFILES_FILE);
        if (text !== this.profilesText) {
          const r = await profilesPy(["list"]);
          const listed = JSON.parse(r.stdout || "{}");
          if (r.code !== 0) throw new Error(listed.errors?.join("; ") || r.stderr.trim() || `profiles.py exit ${r.code}`);
          // Only once listed: a failure that isn't in the text (a folder made later) is asked again.
          this.profilesText = text;
          this.profiles = listed.profiles;
          this.folderProfiles.clear();
          this.accountProfiles.clear();
          this.error = null;
        }
      } catch (error) {
        this.error = `profiles.json: ${error.message ?? error}`;
        this.profiles ??= {};
      }
      this.isLoading = false;
      cx.notify();
    });
  }

  names() {
    return Object.keys(this.profiles ?? {});
  }

  current() {
    return shownProfile(localStorage.getItem("current"), this.names());
  }

  isCoordinator(space) {
    return this.names().some((name) => this.coordinators[name] === space.id);
  }

  // Spaces on a shared machine whose folder's profile is unknown or stale.
  lookUpFolders(cx) {
    if (!this.names().length) return;
    const allPanes = panes(), machines = machineProfiles(this.profiles);
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
        } catch (error) {
          this.error = `Profile of ${folder}: ${error.message ?? error}`;
        }
        lookedUp.set(key, { at: Date.now(), profile });
        cx.notify();
      });
    }
  }

  // Agents on a shared machine whose own Claude account (status-accounts' shared "accounts.agents")
  // hasn't been matched to a profile. Asked once per account: the answer changes only with profiles.json.
  lookUpAccounts(cx) {
    if (!this.names().length) return;
    const machines = machineProfiles(this.profiles), accounts = shared("accounts.agents") ?? {};
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
        } catch (error) {
          this.error = `Profile of ${env.CLAUDE_CONFIG_DIR}: ${error.message ?? error}`;
        }
        lookedUp.set(key, { profile });
        cx.notify();
      });
    }
  }

  publish(allSpaces) {
    const allPanes = panes(), names = this.names(), machines = machineProfiles(this.profiles), accounts = shared("accounts.agents") ?? {};
    const current = this.current();
    const spaceProfiles = Object.fromEntries(allSpaces.map((space) => [space.id, spaceContext({
      space, names, coordinators: this.coordinators,
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
      coordinators: this.coordinators,
      offSpaces: offContext(spaceProfiles, current),
      offAgents: offContext(agentProfiles, current),
      offMachines: offContext(machines, current),
      profiles: this.profiles,
      byAgent,
    };
    if (JSON.stringify(published) !== JSON.stringify(shared(SHARED_KEY) ?? null)) setShared(SHARED_KEY, published);
    return published;
  }

  // Switching shows the space last shown in that profile, else its coordinator.
  switchTo(context, cx) {
    if (context === this.current()) return;
    localStorage.setItem("current", context);
    const ids = new Set(spaces().map((space) => space.id));
    const next = [this.lastSpace[context], this.coordinators[context]].find((id) => ids.has(id));
    if (next) run("space.select", { id: next });
    cx.notify();
  }

  switchToNext(cx) {
    const names = this.names();
    if (names.length < 2) return;
    this.switchTo(names[(names.indexOf(this.current()) + 1) % names.length], cx);
  }

  openCoordinator(cx) {
    const context = this.current(), id = this.coordinators[context];
    if (spaces().some((space) => space.id === id)) {
      run("space.select", { id });
      return;
    }
    const profile = this.profiles?.[context], coordinator = profile?.coordinator;
    if (!coordinator) {
      this.error = `No coordinator for ${context}: give the profile a "coordinator" folder in profiles.json`;
      cx.notify();
      return;
    }
    // Claude Code with the profile's environment (its account), whatever the folder's own says.
    const argv = [...python(), PROFILES_PY, "run", context, "--", "claude"];
    this.isStarting = true;
    cx.spawn(async (cx) => {
      try {
        // The coordinator is a chat (the t3-chat mod), which starts Claude Code with the profile's command
        // in a pane of its own tab. A space starts with a terminal, which goes once the chat is there.
        const { space, tab: first } = await herdrDo("space.new", { name: `Coordinator · ${profile.label}`, machine: "", folder: coordinator.folder, tab: "terminal" });
        await herdrDo("tab.new", { space, name: "coordinator", mod: "t3-chat", props: { view: "chat", folder: coordinator.folder, machine: null, argv, keepName: true } });
        await herdrDo("tab.close", { id: first, confirmed: true });
        this.coordinators = { ...this.coordinators, [context]: space };
        localStorage.setItem("coordinators", JSON.stringify(this.coordinators));
        await herdrDo("space.select", { id: space });
      } catch (error) {
        this.error = `Coordinator: ${error.message ?? error}`;
      }
      this.isStarting = false;
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

  // No profiles yet: nothing to switch between and nothing hidden.
  setUpRow(t) {
    return h_flex().id("context-set-up").h(30).px(10).gap(8).items_center().rounded(8).bg(t.hover)
      .text_size(12).text_color(this.error ? t.blocked : t.muted).hover((s) => s.text_color(t.foreground))
      .role("button").accessibility_label("Set up profiles")
      .when(Boolean(this.error), (el) => el.tooltip(this.error))
      .on_click(() => editProfiles(null))
      .child(svg("mods/workspace-chrome/settings.svg").size(13))
      .child(div().flex_1().min_w(0).truncate().child(this.error ? "profiles.json has a problem" : "Set up profiles"));
  }

  coordinatorRow(t, allSpaces, current) {
    const space = allSpaces.find((s) => s.id === this.coordinators[current]);
    const status = space?.status ?? null;
    const mark = status === "working" ? svg("mods/workspace-chrome/spinner.svg").size(12).text_color(t.working).spin(900)
      : div().size(6).rounded_full().bg(status === "blocked" ? t.blocked : status === "done" ? t.accent : space ? t.ansi2 : t.dim);
    const note = this.isStarting ? "Starting…" : !space ? "Start" : status === "blocked" ? "Needs you" : status === "done" ? "Done" : "";
    return h_flex().id("coordinator").h(32).px(10).gap(10).items_center().rounded(8)
      .text_size(14).text_color(space?.active ? t.foreground : t.muted)
      .when(Boolean(space?.active), (el) => el.bg(t.selected)).hover((s) => s.bg(t.hover))
      .role("button").accessibility_label(`${this.profiles[current]?.label ?? ""} coordinator`)
      .on_click((_e, cx) => this.openCoordinator(cx))
      .child(div().w(16).flex_none().flex().items_center().justify_center().child(mark))
      .child(div().flex_1().min_w(0).truncate().child("Coordinator"))
      .when(Boolean(note), (el) => el.child(div().flex_none().text_size(12).text_color(status === "blocked" ? t.blocked : t.dim).child(note)));
  }

  render() {
    const t = theme(), allSpaces = spaces();
    const frame = v_flex().size_full().bg(t.chrome).px(8).pt(4).gap(6);
    if (!this.profiles) return frame; // not read yet: what was published stays
    const published = this.publish(allSpaces);
    this.rememberShown(allSpaces, published);
    if (!published.current) return frame.child(this.setUpRow(t));
    return frame
      .child(this.switcher(t, published.current))
      .child(this.coordinatorRow(t, allSpaces, published.current));
  }
}
