import { div } from "gpui-kit";
import { v_flex } from "gpui-base";
import { closeOverlay, exec, focused, notify, panes, props, spaces, theme } from "herdr";
import { openReview } from "./host.js";
import { parsePlace } from "./model.js";

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
    return { machine: space.machine ?? null, ...place, spaceId: space.id };
  }

  open({ machine, root, branch, isRepo, name, spaceId }) {
    return openReview(machine, root, branch, isRepo, name, [branch], spaceId);
  }

  command() {}

  render() {
    const t = theme();
    return v_flex().size_full().items_center().justify_center().bg(t.popover).text_size(13).text_color(t.muted)
      .child(div().child(this.message));
  }
}
