// "The PR of this space" (cmd-shift-g: mod.open:prs, the overlay its mod.json describes). Reads where
// the focused pane is, on its machine: a multirepo task (its .mr-task.json names the project and
// branch) or a plain repo (its main checkout and current branch). Then it opens that branch's
// review as the PR list does (openReview: an open review tab is gone to), and closes itself.

import { div } from "gpui-kit";
import { v_flex } from "gpui-base";
import { closeOverlay, exec, focused, notify, panes, props, spaces, theme } from "herdr";
import { openReview } from "./host.js";
import { parsePlace } from "./model.js";

// The nearest .mr-task.json above the folder, else the git repo's main checkout and branch.
const FIND_PLACE = `d=$(pwd -P)
while :; do
  if [ -f "$d/.mr-task.json" ]; then printf 'task\\n'; cat "$d/.mr-task.json"; exit 0; fi
  [ "$d" = / ] && break
  d=$(dirname "$d")
done
common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || exit 0
printf 'repo\\n%s\\n%s\\n' "\${common%/.git}" "$(git branch --show-current)"`;

export class OpenHere {
  constructor(_props, cx) {
    this.message = "Finding this space's PR…";
    cx.spawn(async (cx) => {
      try {
        // Awaited: closing the overlay ends this copy, and anything it still had running.
        await this.open(await this.place());
        closeOverlay(props().overlay);
      } catch (error) {
        notify({ title: "Pull request", body: String(error?.message ?? error), level: "warning" });
        closeOverlay(props().overlay);
      }
      cx.notify();
    });
  }

  async place() {
    const f = focused(), space = spaces().find((s) => s.id === f?.space);
    if (!space) throw new Error("No space is focused.");
    const cwd = panes().find((p) => p.pane === f.pane)?.cwd || f.cwd || space.folder;
    if (!cwd) throw new Error(`${space.name} has no folder to read its branch from.`);
    const r = await exec("sh", ["-c", FIND_PLACE], { cwd, on: space.machine ?? undefined });
    const place = parsePlace(r.code === 0 ? r.stdout : "");
    if (!place) throw new Error(`${cwd} is in no git repo or multirepo task.`);
    if (!place.branch) throw new Error(`${place.name} is on no branch (detached HEAD).`);
    return { ...place, machine: space.machine ?? null };
  }

  open({ machine, root, branch, isRepo, name }) {
    return openReview(machine, root, branch, isRepo, name);
  }

  command() {}

  render() {
    const t = theme();
    return v_flex().size_full().items_center().justify_center().bg(t.popover).text_size(13).text_color(t.muted)
      .child(div().child(this.message));
  }
}
