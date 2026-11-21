import { View, div } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list, VirtualListScrollHandle, InputState, Input } from "gpui-base";
import { props, closeOverlay, theme, spaces, focused, exec, hc, appHome, shared, checking } from "herdr";
import { parseListening, parseMasterPid, parseListeningLocalPorts, parseListeningLocalPortsFromSs, forwardSpec, loopbackPort, sandboxOf, sandboxHostPorts } from "./ports.js";

const SANDBOX = `${appHome()}/scripts/sandbox.mjs`;

async function run(command, args, options) {
  const r = await exec(command, args, options);
  return { isOk: r.code === 0, out: r.stdout, err: (r.stderr || r.stdout).trim() };
}

const START_MASTER = `log=$(mktemp)
ssh -E "$log" -o BatchMode=yes -o ControlMaster=yes -o ControlPersist=yes -fN "$1" </dev/null >/dev/null 2>&1
code=$?
[ "$code" -ne 0 ] && cat "$log" >&2
rm -f "$log"
exit "$code"`;

export default class PortForward extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.listScroll = VirtualListScrollHandle.new();
    this.machines = undefined;
    this.target = undefined;
    this.rows = undefined;
    this.forwarded = new Set();
    this.at = 0;
    this.isBusy = false;
    this.error = "";
    this.query = "";
    this.isSearching = false;
    this.search = InputState.new({ value: "", placeholder: "port, process or address" });
    this.search.on("change", (_e, cx) => { this.query = this.search.value().trim().toLowerCase(); this.moveTo(0); cx.notify(); });

    this.search.on("submit", (_e, cx) => this.pick(cx, this.at));
    this.search.on("focus", (_e, cx) => { this.isSearching = true; cx.notify(); });
    this.search.on("blur", (_e, cx) => { this.isSearching = false; cx.notify(); });
    if (checking()) return;
    cx.spawn(async (cx) => {
      try {
        const listed = await hc(["machine", "ls", "--json"]);
        if (listed.code !== 0) throw new Error(listed.stderr.trim() || "hc machine ls failed");
        const all = JSON.parse(listed.stdout).machines;
        const { machine: asked, open } = props() ?? {};
        const offMachines = new Set(shared("context")?.offMachines ?? []);
        this.machines = all.filter((m) =>
          !m.temporary
          && !(m.via === true && String(m.target).includes("sandbox-via.sh"))
          && (m.name === asked || !offMachines.has(m.name)));
        const space = spaces().find((s) => s.id === focused()?.space);
        const sandbox = open ? sandboxOf(all.find((m) => m.name === asked && m.via === true)?.target) : null;
        const host = sandbox && this.machines.find((m) => m.target === sandbox.host || m.name === sandbox.host);
        const current = host ?? this.machines.find((m) => m.name === (asked ?? space?.machine));
        if (current) await this.choose(current);
        if (open && !current) this.error = `Can't forward from ${asked}: neither an ssh machine in Herdr nor a sandbox on one.`;
        else if (open) await this.forwardAndOpen(open, cx, sandbox?.name ?? null);
      } catch (error) {
        this.error = String(error);
        this.machines ??= [];
      }
      cx.notify();
    });
  }

  async choose(machine, shouldReload = true) {
    this.machine = machine;
    this.target = machine.target;
    this.rows = undefined;
    this.clearSearch();
    this.moveTo(0);
    if (shouldReload) await this.reload();
  }

  backToMachines() {
    this.target = undefined;
    this.error = "";
    this.clearSearch();
    this.moveTo(Math.max(0, this.machines.indexOf(this.machine)));
  }

  clearSearch() {
    this.search.set_value("");
    this.query = "";
  }

  moveTo(index) {
    this.at = index;
    this.listScroll.scroll_to_item(index);
  }

  async reload() {
    this.error = "";
    const listening = await run("sh", ["-c", "ss -ltnpH 2>/dev/null || ss -ltnH"], { on: this.machine.name });
    if (!listening.isOk) {
      this.rows = [];
      this.error = `Could not list ports on ${this.machine.name}: ${listening.err}`;
      return;
    }
    this.forwarded = await this.forwardedPorts();
    const remote = parseListening(listening.out);
    const remotePorts = new Set(remote.map((r) => r.port));

    const orphans = [...this.forwarded].filter((p) => !remotePorts.has(p)).map((port) => ({ port, address: "127.0.0.1", process: "not listening" }));
    this.rows = [...remote, ...orphans].sort((a, b) => a.port - b.port);
  }

  async forwardAndOpen(url, cx, sandbox) {
    const port = loopbackPort(url);
    if (port === null) { this.error = `Not a localhost link: ${url}`; return; }
    if (sandbox || !this.forwarded.has(port)) {
      this.isBusy = true;
      cx.notify();

      const error = sandbox
        ? await this.forwardSandboxPort(port, sandbox)
        : await this.toggle(this.rows?.find((r) => r.port === port) ?? { port, address: "127.0.0.1" });
      this.isBusy = false;
      if (error) { this.error = error; return; }
    }
    cx.open_url(url);
    this.close();
  }

  async forwardSandboxPort(port, sandbox) {
    const opened = await run(SANDBOX, ["port", "--machine", this.machine.name, "--name", sandbox, "--port", String(port)]);
    const hostPort = Number(opened.out.trim());
    if (!opened.isOk || !Number.isInteger(hostPort)) return `Could not open :${port} of ${sandbox} on ${this.machine.name}: ${opened.err}`;
    const error = await this.ensureMaster();
    if (error) return error;
    const r = await run("ssh", ["-O", "forward", "-L", forwardSpec({ port, address: "127.0.0.1", remotePort: hostPort }), this.target]);
    return r.isOk ? "" : `Could not forward :${port} from ${sandbox}: ${r.err}. If this Mac's :${port} already forwards elsewhere, stop it below.`;
  }

  async ensureMaster() {
    if (await this.masterPid()) return "";
    const started = await run("sh", ["-c", START_MASTER, "sh", this.target]);
    return started.isOk ? "" : `Could not connect to ${this.target}: ${started.err}`;
  }

  async masterPid() {
    const check = await run("ssh", ["-O", "check", this.target]);
    return check.isOk ? parseMasterPid(check.err) : null;
  }

  async forwardedPorts() {
    const pid = await this.masterPid();
    if (!pid) return new Set();
    const lsof = await run("lsof", ["-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-Fn"]).catch(() => ({ isOk: false, out: "" }));
    if (lsof.isOk || lsof.out) return parseListeningLocalPorts(lsof.out);

    const ss = await run("ss", ["-ltnpH"]).catch(() => ({ isOk: false, out: "" }));
    return ss.isOk ? parseListeningLocalPortsFromSs(ss.out, pid) : new Set();
  }

  async toggle(row) {
    const isForwarded = this.forwarded.has(row.port);
    if (isForwarded) return this.cancel(row);
    const error = await this.ensureMaster();
    if (error) return error;
    const r = await run("ssh", ["-O", "forward", "-L", forwardSpec(row), this.target]);
    return r.isOk ? "" : `Could not forward :${row.port}: ${r.err}`;
  }

  async cancel(row) {
    let lastError = "";
    for (const address of new Set([row.address, "localhost", "127.0.0.1", "[::1]"])) {
      const r = await run("ssh", ["-O", "cancel", "-L", forwardSpec({ port: row.port, address }), this.target]);
      if (!(await this.forwardedPorts()).has(row.port)) return "";
      lastError = r.err;
    }

    const tables = await run("sh", ["-c", 'cat "$HOME"/.herdr/sandbox-ports/* 2>/dev/null; true'], { on: this.machine.name });
    for (const remotePort of sandboxHostPorts(tables.out, row.port)) {
      const r = await run("ssh", ["-O", "cancel", "-L", forwardSpec({ port: row.port, address: "127.0.0.1", remotePort }), this.target]);
      if (!(await this.forwardedPorts()).has(row.port)) return "";
      lastError = r.err;
    }
    return `Could not stop :${row.port} (${lastError}). A forward from ~/.ssh/config only stops with ssh -O exit ${this.target}.`;
  }

  act(cx, work) {
    if (this.isBusy) return;
    this.isBusy = true;
    this.error = "";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const error = await work();
        await this.reload();
        this.error = error || this.error;
      } catch (error) {
        this.error = String(error);
      }
      this.isBusy = false;
      cx.notify();
    });
  }

  close() {
    closeOverlay(props().overlay);
  }

  items() {
    const all = this.target ? this.rows ?? [] : this.machines ?? [];
    if (!this.query) return all;
    const text = (item) => (this.target ? `${item.port} ${item.process} ${item.address}` : `${item.name} ${item.target}`).toLowerCase();
    return all.filter((item) => text(item).includes(this.query));
  }

  pick(cx, index) {
    const item = this.items()[index];
    if (!item) return;
    this.at = index;
    if (this.target) this.act(cx, () => this.toggle(item));
    else this.act(cx, async () => { await this.choose(item, false); return ""; });
  }

  key(e, cx) {
    const count = this.items().length;
    const stroke = e.keystroke;
    if (this.isSearching) {
      if (stroke === "escape") this.handle.focus();
      else if (stroke === "down" && count) this.moveTo((this.at + 1) % count);
      else if (stroke === "up" && count) this.moveTo((this.at + count - 1) % count);
      else return;
    }
    else if (stroke === "/") {

      this.isSearching = true;
      cx.timer.after(0, () => this.search.focus());
    }
    else if (stroke === "escape" && this.query) { this.clearSearch(); this.moveTo(0); }
    else if (stroke === "escape") this.close();
    else if ((stroke === "down" || stroke === "j") && count) this.moveTo((this.at + 1) % count);
    else if ((stroke === "up" || stroke === "k") && count) this.moveTo((this.at + count - 1) % count);
    else if (stroke === "enter" || stroke === "space" || stroke === "l") this.pick(cx, this.at);
    else if (stroke === "h" && this.target && !this.isBusy) this.backToMachines();
    else if (stroke === "r" && this.target) this.act(cx, async () => "");
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  render(cx) {
    const t = theme();
    const choosingMachine = !this.target;
    const rowView = (label, detail, mark, markColor, index) =>
      h_flex()
        .flex_none()
        .h(34)
        .px(10)
        .gap(10)
        .items_center()
        .rounded(7)
        .cursor_pointer()
        .when(index === this.at, (el) => el.bg(t.selected))
        .when(index !== this.at, (el) => el.hover((s) => s.bg(t.hover)))
        .child(div().flex_none().w(16).text_color(markColor).child(mark))
        .child(div().flex_none().w(choosingMachine ? 140 : 64).truncate().font_semibold().text_color(t.foreground).child(label))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(detail));

    const items = this.items();
    const rows = choosingMachine
      ? items.map((m, i) => () => rowView(m.name, `${m.target} · ${m.state}`, "›", t.dim, i))
      : items.map((r, i) => () => {
          const isOn = this.forwarded.has(r.port);
          return rowView(`:${r.port}`, [r.process, r.address].filter(Boolean).join(" · "), isOn ? "●" : "○", isOn ? t.accent : t.dim, i);
        });
    const isLoading = choosingMachine ? this.machines === undefined : this.rows === undefined;
    const empty = this.query ? `Nothing matches "${this.query}".` : choosingMachine ? "No ssh machines in Herdr. Add one with hc machine add <host>." : "Nothing is listening there.";
    const title = choosingMachine ? "Forward ports from…" : `Forward ports from ${this.machine.name}`;
    const hint = this.isBusy
      ? "working…"
      : this.isSearching
        ? "type to filter · ↑↓ choose · ↵ " + (choosingMachine ? "pick" : "toggle") + " · esc list"
        : choosingMachine
          ? "j/k choose · l/↵ pick · / search · esc close"
          : "j/k choose · l/↵ toggle · / search · h machines · r refresh · esc " + (this.query ? "clear" : "close");
    return v_flex()
      .id("port-forward")
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .size_full()
      .p(16)
      .gap(10)
      .bg(t.popover)
      .text_size(13)
      .child(div().font_semibold().text_color(t.foreground).child(title))
      .when(!choosingMachine, (el) => el.child(div().text_size(12).text_color(t.muted).child(`localhost:<port> here reaches the same port on ${this.target}.`)))
      .when(this.isSearching || Boolean(this.query), (el) =>
        el.child(Input.new(this.search).h(32).px(10).items_center().rounded(6).border(1).border_color(this.isSearching ? t.accent : t.input).bg(t.background).text_color(t.foreground)),
      )
      .child(
        v_flex()
          .relative()
          .flex_1()
          .min_h(0)
          .child(
            isLoading || rows.length === 0
              ? div().p(10).text_color(isLoading ? t.muted : t.dim).child(isLoading ? "…" : empty)
              : v_virtual_list("pf-list", rows.length, 34, (i) => String(i), (range) => rows.slice(range.start, range.end).map((build) => build()))

                  .on_item_click((key, cx) => this.pick(cx, Number(key)))
                  .track_scroll(this.listScroll)
                  .size_full(),
          )
          .child(Scrollbar.vertical("pf-list").absolute().inset_0()),
      )
      .when(Boolean(this.error), (el) => el.child(div().text_color(t.blocked).child(this.error)))
      .child(h_flex().justify_end().text_size(11).text_color(t.dim).child(hint));
  }
}
