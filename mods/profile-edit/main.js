import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextView } from "gpui-base";
import { exec, hc, home, appHome, theme, props, closeOverlay, knownAgents, window, checking } from "herdr";
import { toDraft, newDraft, duplicateOf, toProfile, projectLines, moved, takenMachines, errorLines, LOCAL_MACHINE } from "./draft.js";

const PROFILES_PY = `${appHome()}/mods/t3-context/profiles.py`;

const COLORS = { ansi1: "Red", ansi2: "Green", ansi3: "Yellow", ansi4: "Blue", ansi5: "Magenta", ansi6: "Cyan" };
const SECRET_HINT = "the variable that holds it, e.g. JIRA_TOKEN";

const python = () => (window()?.platform === "windows" ? ["py", "-3"] : ["python3"]);

async function profilesPy(args) {
  const [command, ...pythonArgs] = python();
  return exec(command, [...pythonArgs, PROFILES_PY, ...args]);
}

const escapeHtml = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export default class ProfileEdit extends View {
  init(_props, cx) {
    this.profiles = null;
    this.providers = {};
    this.fileErrors = [];
    this.draft = null;
    this.inputs = new Map();
    this.errors = [];
    this.saved = null;
    this.isBusy = false;
    this.isAskingDelete = false;
    this.machines = [];
    this.templates = [];
    this.programs = [];
    this.installed = new Set();
    this.handle = cx.focus_handle();
    if (!checking()) cx.spawn(async (cx) => {
      await Promise.all([this.reload(), this.loadChoices()]);
      const wanted = props()?.profile;
      this.open(this.profiles?.[wanted] ? wanted : Object.keys(this.profiles ?? {})[0] ?? null);
      cx.notify();
    });
  }

  async reload() {
    const r = await profilesPy(["list"]);
    let listed = {};
    try { listed = JSON.parse(r.stdout || "{}"); } catch {  }
    this.fileErrors = r.code === 0 ? [] : listed.errors ?? [r.stderr.trim() || `profiles.py exit ${r.code}`];
    this.profiles = listed.profiles ?? {};
    this.providers = listed.providers ?? {};
  }

  async loadChoices() {
    const [machines, templates, agents] = await Promise.all([
      hc(["machine", "ls", "--json"]).catch(() => null),
      hc(["templates", "--json"]).catch(() => null),
      knownAgents().catch(() => []),
    ]);
    try { this.machines = JSON.parse(machines.stdout).machines.filter((m) => !m.temporary && !(m.via === true && String(m.target).includes("sandbox-via.sh"))).map((m) => m.name); } catch { this.machines = []; }
    try { this.templates = JSON.parse(templates.stdout).templates.map((t) => ({ name: t.name, program: t.command.split(/\s+/)[0].split("/").pop() })); } catch { this.templates = []; }
    this.programs = [...new Set([...agents.map((agent) => agent.run?.[0]).filter(Boolean), ...this.templates.map((t) => t.program)])];
    this.installed = new Set(agents.filter((agent) => agent.installed).map((agent) => agent.run?.[0]));
  }

  open(name, draft = null) {
    this.draft = draft ?? (name ? toDraft(name, this.profiles[name], this.providers, { appHome: appHome(), home: home() }) : newDraft());
    this.errors = [];
    this.saved = null;
    this.isAskingDelete = false;
    for (const state of this.inputs.values()) state.release();
    this.inputs.clear();
    const text = (key, placeholder, get, set) => this.makeInput(key, placeholder, get(), set);
    const d = this.draft;
    text("name", "lowercase, e.g. client-a", () => d.name, (v) => { d.name = v.trim(); });
    text("label", "shown in the switch, e.g. Work", () => d.label, (v) => { d.label = v; });
    text("badge", "e.g. the company's name", () => d.badge, (v) => { d.badge = v; });
    this.makeFolderInputs();
    for (const provider of Object.keys(d.accounts)) this.makeAccountInputs(provider);
  }

  makeInput(key, placeholder, value, set) {
    const state = InputState.new({ placeholder, value });
    state.on("change", (_e, cx) => { set(state.value()); this.saved = null; cx.notify(); });
    state.on("submit", (_e, cx) => this.save(cx));
    this.inputs.set(key, state);
  }

  makeFolderInputs() {
    for (const [key, state] of [...this.inputs]) {
      if (!key.startsWith("folder.")) continue;
      state.release();
      this.inputs.delete(key);
    }
    this.draft.folders.forEach((folder, index) => this.makeInput(`folder.${index}`, "~/work", folder, (v) => { this.draft.folders[index] = v; }));
  }

  changeFolders(cx, change) {
    change(this.draft.folders);
    this.makeFolderInputs();
    this.saved = null;
    cx.notify();
  }

  makeAccountInputs(provider) {
    const account = this.draft.accounts[provider];
    for (const [field, isSecret] of Object.entries(this.providers[provider]?.fields ?? {})) {
      this.makeInput(`${provider}.${field}`, isSecret ? SECRET_HINT : field === "configDir" ? "empty: the default" : "", account[field] ?? "", (v) => { account[field] = v; });
    }
  }

  addAccount(provider, cx) {
    this.draft.accounts[provider] = Object.fromEntries(Object.keys(this.providers[provider].fields).map((field) => [field, ""]));
    this.makeAccountInputs(provider);
    this.saved = null;
    cx.notify();
  }

  removeAccount(provider, cx) {
    for (const field of Object.keys(this.draft.accounts[provider])) {
      this.inputs.get(`${provider}.${field}`)?.release();
      this.inputs.delete(`${provider}.${field}`);
    }
    delete this.draft.accounts[provider];
    this.saved = null;
    cx.notify();
  }

  toggle(list, value, cx) {
    const at = list.indexOf(value);
    if (at === -1) list.push(value); else list.splice(at, 1);
    this.saved = null;
    cx.notify();
  }

  async change(args) {
    const r = await profilesPy(args);
    this.errors = r.code === 0 ? [] : errorLines(r.stderr || r.stdout || `profiles.py exit ${r.code}`, this.draft?.name ?? "");
    await this.reload();
    return r.code === 0;
  }

  act(cx, work) {
    if (this.isBusy) return;
    this.isBusy = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await work();
      } catch (error) {
        this.errors = [String(error.message ?? error)];
      }
      this.isBusy = false;
      cx.notify();
    });
  }

  save(cx) {
    this.act(cx, async () => {
      const name = this.draft.name;
      if (!name) throw new Error("name: needed (lowercase letters, digits and dashes)");
      if (this.draft.isNew && this.profiles[name]) throw new Error(`name: there is a profile ${name} already`);
      if (!(await this.change(["put", name, JSON.stringify(toProfile(this.draft, this.providers))]))) return;
      this.open(name);
      this.saved = await this.leftToDo(name);
    });
  }

  async leftToDo(name) {
    const [envrc, check] = await Promise.all([profilesPy(["envrc", name]), profilesPy(["check"])]);
    const warnings = check.stdout.split("\n").filter((line) => line.startsWith(`warning: profiles.${name}.`)).map((line) => line.slice("warning: ".length));
    return { envrc: this.profiles[name].folders.length && envrc.code === 0 ? envrc.stdout.trim() : "", warnings };
  }

  remove(cx) {
    this.act(cx, async () => {
      if (await this.change(["remove", this.draft.name])) this.open(Object.keys(this.profiles)[0] ?? null);
    });
  }

  move(by, cx) {
    this.act(cx, async () => {
      const name = this.draft.name;
      await this.change(["order", ...moved(Object.keys(this.profiles), name, by)]);
    });
  }

  close() {
    closeOverlay(props().overlay);
  }

  key(e, cx) {
    if (e.key === "escape") { this.close(); cx.stop_propagation(); }
  }

  chip(t, id, label, isOn, onClick, { color = null, tip = null, isOff = false } = {}) {
    const tint = color ?? t.accent;
    return h_flex().id(id).flex_none().h(26).px(10).gap(6).items_center().rounded(7).border_1()
      .border_color(isOn ? tint : t.input).bg(isOn ? `${tint}26` : t.raised)
      .text_size(12).text_color(isOff ? t.dim : isOn ? t.foreground : t.muted)
      .when(!isOff, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => onClick(cx)))
      .when(Boolean(tip), (el) => el.tooltip(tip))
      .when(Boolean(color), (el) => el.child(div().size(8).rounded_full().bg(color)))
      .child(label);
  }

  button(t, id, label, onClick, { isMain = false, isDanger = false, isOff = false, tip = null } = {}) {
    return div().id(id).flex_none().h(30).px(12).flex().items_center().rounded(8).border_1()
      .border_color(isMain ? t.solid : isDanger ? t.blocked : t.input).bg(isMain ? t.solid : t.raised)
      .text_color(isMain ? t.solid_foreground : isDanger ? t.blocked : t.foreground).text_size(12.5).font_medium()
      .when(isOff || this.isBusy, (el) => el.opacity(0.4))
      .when(!isOff && !this.isBusy, (el) => el.cursor_pointer().hover((s) => s.opacity(0.85)).on_click((_e, cx) => onClick(cx)))
      .when(Boolean(tip), (el) => el.tooltip(tip).accessibility_label(tip))
      .child(label);
  }

  field(t, key, width = null) {
    const state = this.inputs.get(key);
    if (!state) return div();
    const box = Input.new(state).h(30).px(8).items_center().rounded(7).border_1().border_color(t.input).bg(t.background).text_size(12.5).text_color(t.foreground);
    return width ? box.w(width).flex_none() : box.flex_1().min_w(0);
  }

  row(t, label, content, hint = null) {
    return h_flex().gap(12).items_start()
      .child(div().w(96).flex_none().pt(6).text_size(12).text_color(t.muted).child(label))
      .child(v_flex().flex_1().min_w(0).gap(4).child(content)
        .when(Boolean(hint), (el) => el.child(div().text_size(11).text_color(t.dim).child(hint))));
  }

  tabs(t) {
    const names = Object.keys(this.profiles);
    return h_flex().flex_wrap().gap(6)
      .children(names.map((name) => this.chip(t, `pe-tab-${name}`, this.profiles[name].label, !this.draft?.isNew && this.draft?.name === name,
        (cx) => { this.open(name); cx.notify(); }, { color: t[this.profiles[name].color] ?? null })))
      .child(this.chip(t, "pe-tab-new", "+ New profile", Boolean(this.draft?.isNew), (cx) => { this.open(null); cx.notify(); }));
  }

  machineChips(t) {
    const d = this.draft, taken = takenMachines(this.profiles, d.isNew ? null : d.name);
    const names = [...new Set([...this.machines, ...d.machines])];
    if (!names.length) return div().pt(6).text_size(12).text_color(t.dim).child("No machines added yet (hc machine ls).");
    return h_flex().flex_wrap().gap(6).children(names.map((machine) => (taken[machine]
      ? this.chip(t, `pe-machine-${machine}`, `${machine} · ${taken[machine]}`, false, () => {}, { isOff: true, tip: `${machine} is ${taken[machine]}'s: take it out there first` })
      : this.chip(t, `pe-machine-${machine}`, machine, d.machines.includes(machine), (cx) => this.toggle(d.machines, machine, cx)))));
  }

  agentRows(t) {
    const d = this.draft;
    const programs = [...new Set([...this.programs, ...Object.values(d.agentMachines).flat()])];

    const hasTemplate = (program) => this.templates.some((template) => template.program === program);
    const candidates = programs.filter((program) => hasTemplate(program) || this.installed.has(program) || program === d.reviewer);
    const pick = (program) => (cx) => { d.reviewer = program; this.saved = null; cx.notify(); };
    const reviewerChip = (program) => {
      const isOn = d.reviewer === program;
      if (!hasTemplate(program)) return this.chip(t, `pe-reviewer-${program}`, program, isOn, () => {}, { isOff: true, tip: `No hc template runs ${program}: add one in ~/.config/herdr-core/templates to review with it` });
      return this.chip(t, `pe-reviewer-${program}`, program, isOn, pick(program), { tip: `Started through the hc template that runs ${program}` });
    };
    return [
      this.row(t, "Reviewer", h_flex().gap(6).items_center().flex_wrap()
        .child(this.chip(t, "pe-reviewer-off", "Off", !d.reviewer, pick("")))
        .children(candidates.map(reviewerChip)),
      "The agent that reviews this profile's work, or none. An agent is started through the hc template whose command runs it."),
      this.agentMachineRow(t, programs),
    ];
  }

  agentMachineRow(t, programs) {
    const d = this.draft, rules = d.agentMachines;
    const setHeld = (machine, isHeld) => (cx) => {
      if (isHeld) rules[machine] = []; else delete rules[machine];
      this.saved = null;
      cx.notify();
    };
    const line = (machine) => {
      const isHeld = machine in rules;
      return h_flex().gap(8).items_center().flex_wrap()
        .child(div().w(120).flex_none().text_size(12).text_color(t.foreground).child(machine === LOCAL_MACHINE ? "This computer" : machine))
        .child(this.chip(t, `pe-at-${machine}-any`, "Any agent", !isHeld, setHeld(machine, !isHeld),
          { tip: isHeld ? "Let every agent start here again" : "Keep this machine to the agents ticked next" }))
        .when(isHeld, (el) => el.children(programs.map((program) =>
          this.chip(t, `pe-at-${machine}-${program}`, program, rules[machine].includes(program), (cx) => this.toggle(rules[machine], program, cx)))));
    };
    return this.row(t, "Agents", v_flex().gap(6).children([LOCAL_MACHINE, ...d.machines].map(line)),
      "Per machine, the only agents that may start there: the agent guard refuses the others. Claude Code's own subagents run on "
      + "this computer and count as claude. A machine on Any, a sandbox too, starts any agent; a machine taken out of the profile above takes its rule with it.");
  }

  accountRows(t) {
    const d = this.draft;
    const missing = Object.keys(this.providers).filter((provider) => !d.accounts[provider]);
    const rows = Object.keys(d.accounts).map((provider) => this.row(t, provider, v_flex().gap(6)
      .children(Object.entries(this.providers[provider]?.fields ?? {}).map(([name, isSecret]) => h_flex().gap(8).items_center()
        .child(div().w(84).flex_none().text_size(12).text_color(t.dim).child(isSecret ? `${name} (secret)` : name))
        .child(this.field(t, `${provider}.${name}`))))
      .child(h_flex().child(div().id(`pe-account-remove-${provider}`).text_size(11.5).text_color(t.dim).cursor_pointer()
        .hover((s) => s.text_color(t.blocked)).on_click((_e, cx) => this.removeAccount(provider, cx)).child(`Remove the ${provider} account`)))));
    return [
      ...rows,
      this.row(t, rows.length ? "" : "Accounts", missing.length
        ? h_flex().flex_wrap().gap(6).children(missing.map((provider) => this.chip(t, `pe-account-add-${provider}`, `+ ${provider}`, false, (cx) => this.addAccount(provider, cx))))
        : div(),
      "A secret is never typed here: give the variable that holds it, or a command as a JSON list. More providers: \"providers\" in profiles.json."),
    ];
  }

  form(t) {
    const d = this.draft;
    return v_flex().gap(12)
      .child(this.row(t, "Name", d.isNew ? this.field(t, "name", 220) : div().pt(6).text_size(12.5).child(d.name),
        d.isNew ? "Fixed once made: agents and folders are started as it." : null))
      .child(this.row(t, "Label", this.field(t, "label")))
      .child(this.row(t, "Chip", this.field(t, "badge"), "On its agents' and panes' account chips. Empty: the label."))
      .child(this.row(t, "Colour", h_flex().flex_wrap().gap(6)
        .children(Object.entries(COLORS).map(([color, colorName]) => this.chip(t, `pe-color-${color}`, colorName, d.color === color, (cx) => { d.color = color; this.saved = null; cx.notify(); }, { color: t[color] })))
        .child(this.chip(t, "pe-color-none", "None", !d.color, (cx) => { d.color = ""; this.saved = null; cx.notify(); }))))
      .child(this.row(t, "Machines", this.machineChips(t), "Machines that are this profile's alone. A machine in no profile is shared: its spaces go by folder."))
      .child(this.row(t, "Folders", v_flex().gap(6)
        .children(d.folders.map((_folder, index) => h_flex().gap(8).items_center()
          .child(this.field(t, `folder.${index}`))
          .child(div().id(`pe-folder-remove-${index}`).flex_none().text_size(11.5).text_color(t.dim).cursor_pointer()
            .hover((s) => s.text_color(t.blocked)).on_click((_e, cx) => this.changeFolders(cx, (folders) => folders.splice(index, 1))).child("Remove"))))
        .child(h_flex().child(this.chip(t, "pe-folder-add", "+ Add folder", false, (cx) => this.changeFolders(cx, (folders) => folders.push(""))))),
      "On a shared machine: folders whose spaces are this profile's."))
      .child(this.row(t, "Projects", v_flex().gap(4).pt(6).text_size(12.5)
        .children(projectLines(d.projects).map((line, index) => div().id(`pe-project-${index}`).min_w(0).truncate().tooltip(line).child(line)))
        .when(!Object.keys(d.projects).length, (el) => el.child(div().text_color(t.dim).child("None"))),
      "What this profile works on. Each project has its own coordinator, an agent that starts and tracks its tasks, and its spaces on every machine show under it in the sidebar. Add or change one under \"projects\" in profiles.json (profiles.example.json shows how)."))
      .children(this.agentRows(t))
      .children(this.accountRows(t));
  }

  savedCard(t) {
    const { envrc, warnings } = this.saved;
    return v_flex().gap(8).p(12).rounded(10).bg(`${t.ansi2}14`).border_1().border_color(`${t.ansi2}40`)
      .child(div().text_size(12.5).font_semibold().child(envrc || warnings.length ? "Saved. Left for you:" : "Saved."))
      .when(Boolean(envrc), (el) => el
        .child(div().text_size(12).text_color(t.muted).child("Each of its folders needs these lines in its .envrc (then `direnv allow`), so terminals and agents there get this profile's accounts:"))
        .child(v_flex().p(8).gap(2).rounded(6).bg(t.background).border_1().border_color(t.border).text_size(11.5)
          .children(envrc.split("\n").map((line) => div().min_w(0).truncate().child(line))))
        .child(h_flex().child(this.button(t, "pe-copy-envrc", "Copy the lines", (cx) => cx.write_to_clipboard(`${envrc}\n`)))))
      .children(warnings.map((warning, index) => div().text_size(12).text_color(t.muted)
        .child(TextView.html(`pe-warning-${index}`, `<span>${escapeHtml(warning)}</span>`).selectable(true))));
  }

  footer(t) {
    const d = this.draft, names = Object.keys(this.profiles), at = names.indexOf(d.name);
    const isKept = !d.isNew;
    if (this.isAskingDelete) {
      return h_flex().gap(8).items_center()
        .child(div().flex_1().min_w(0).text_size(12.5).text_color(t.muted)
          .child(`Delete ${d.label}? Its spaces and agents show in every profile; its projects' coordinator folders and its accounts' sign-ins stay.`))
        .child(this.button(t, "pe-delete-no", "Keep", (cx) => { this.isAskingDelete = false; cx.notify(); }))
        .child(this.button(t, "pe-delete-yes", "Delete", (cx) => this.remove(cx), { isDanger: true }));
    }
    return h_flex().gap(8).items_center()
      .when(isKept, (el) => el
        .child(this.button(t, "pe-delete", "Delete", (cx) => { this.isAskingDelete = true; cx.notify(); }, { isDanger: true }))
        .child(this.button(t, "pe-duplicate", "Duplicate", (cx) => { this.open(null, duplicateOf(d)); cx.notify(); }))
        .child(this.button(t, "pe-earlier", "←", (cx) => this.move(-1, cx), { isOff: at <= 0, tip: "Move earlier in the switch" }))
        .child(this.button(t, "pe-later", "→", (cx) => this.move(1, cx), { isOff: at === names.length - 1, tip: "Move later in the switch" })))
      .child(div().flex_1())
      .child(this.button(t, "pe-save", d.isNew ? "Create" : "Save", (cx) => this.save(cx), { isMain: true }));
  }

  render() {
    const t = theme();
    const frame = v_flex().id("profile-edit").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .w_full().min_h(0).p(18).gap(14).bg(t.popover).text_color(t.foreground)
      .child(h_flex().items_center().child(div().flex_1().text_size(15).font_semibold().child("Profiles")).child(div().text_size(11).text_color(t.dim).child("Esc")));
    if (!this.profiles || !this.draft) return frame.child(div().text_size(12.5).text_color(t.dim).child("Reading profiles.json…"));
    if (this.fileErrors.length) {
      return frame
        .child(div().text_size(12.5).text_color(t.muted).child("profiles.json can't be read. Fix it by hand (python3 mods/t3-context/profiles.py check), then open this again:"))
        .children(this.fileErrors.map((error, index) => div().text_size(12).text_color(t.blocked).child(TextView.html(`pe-file-error-${index}`, `<span>${escapeHtml(error)}</span>`).selectable(true))));
    }
    return frame
      .child(this.tabs(t))
      .child(v_flex().id("pe-form").max_h(520).min_h(0).flex_shrink(1).overflow_y_scroll().pr(6).child(this.form(t)))
      .when(this.errors.length > 0, (el) => el.child(v_flex().gap(3).children(this.errors.map((error, index) =>
        div().text_size(12).text_color(t.blocked).child(TextView.html(`pe-error-${index}`, `<span>${escapeHtml(error)}</span>`).selectable(true))))))
      .when(Boolean(this.saved), (el) => el.child(this.savedCard(t)))
      .child(this.footer(t));
  }
}
