// `mr pull` for the task workspace the focused terminal is in (palette: "Pull task repos"), or for
// props { machine, folder } (the Projects tab; machine null is this Mac): every repo of the task
// fast-forwards from its upstream, one line per repo here. The multirepo mod's
// mr.py runs on the space's machine over ssh (mods can't import across folders, so the call is
// repeated here as in the prs mod).

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, closeOverlay, exec, hc, appHome, focused, spaces, theme, window } from "herdr";

const MR = `${appHome()}/mods/multirepo/mr.py`;

function remoteCommand(args) {
  return ["python3", "-", ...args.map((a) => `'${String(a).replaceAll("'", "'\\''")}'`)].join(" ");
}

async function sshTarget(machineName) {
  if (machineName === null) return null;
  const r = await hc(["machine", "ls", "--json"]);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || "hc machine ls failed");
  const machine = JSON.parse(r.stdout).machines.find((m) => m.name === machineName && m.state === "connected");
  if (!machine) throw new Error(`${machineName} is not connected.`);
  return machine.target;
}

// Python 3 here: Windows has the py launcher (its python3 can be the Store's stub), elsewhere python3.
function python() {
  return window()?.platform === "windows" ? ["py", "-3"] : ["python3"];
}

// mr's output even when it fails: the lines say which repo did not pull.
async function mrPull(target, folder) {
  const args = ["pull", "--task", folder];
  const [command, ...pythonArgs] = python();
  const r = target === null
    ? await exec(command, [...pythonArgs, MR, ...args])
    : await exec("sh", ["-c", 'ssh -o BatchMode=yes "$1" "$2" < "$3"', "sh", target, remoteCommand(args), MR]);
  const lines = `${r.stdout}\n${r.stderr}`.split("\n").map((l) => l.replace(/^mr: /, "").trim()).filter(Boolean);
  return { lines, isOk: r.code === 0 };
}

export default class MrPull extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.lines = ["Pulling…"];
    this.isOk = null;
    const given = props() ?? {};
    const space = spaces().find((s) => s.id === focused()?.space);
    const machine = "machine" in given ? given.machine : space?.machine ?? null;
    this.folder = given.folder ?? focused()?.cwd ?? space?.folder ?? "";
    this.where = machine ?? "This Mac";
    cx.spawn(async (cx) => {
      try {
        if (!this.folder) throw new Error("No focused terminal to take the task folder from.");
        ({ lines: this.lines, isOk: this.isOk } = await mrPull(await sshTarget(machine), this.folder));
      } catch (error) {
        this.lines = [String(error.message ?? error)];
        this.isOk = false;
      }
      cx.notify();
    });
  }

  render() {
    const t = theme();
    const color = this.isOk === null ? t.muted : this.isOk ? t.done : t.blocked;
    return v_flex().id("mr-pull").track_focus(this.handle).w(460).h(240).bg(t.popover).text_color(t.foreground)
      .on_key_down((e, cx) => {
        if (e.key === "escape" || e.key === "enter") { closeOverlay(props()?.overlay); cx.stop_propagation(); }
      })
      .child(h_flex().flex_none().h(40).px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().flex_1().text_size(13).font_semibold().child("Pull task repos"))
        .child(div().text_size(11).text_color(t.dim).child(this.where)))
      .child(div().flex_none().px(14).pt(8).text_size(11).text_color(t.dim).truncate().child(this.folder))
      .child(v_flex().flex_1().min_h(0).px(14).py(8).gap(4).overflow_y_scrollbar()
        .children(this.lines.map((line, i) => div().id(`line-${i}`).text_size(12).text_color(color).child(line))))
      .child(div().flex_none().px(14).pb(8).text_size(11).text_color(t.dim).child("esc closes"));
  }
}
