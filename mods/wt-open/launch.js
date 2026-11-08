// Opens the shipped worktree dialog for the focused space, so a key can reach it:
// keys.json's mod.open passes no props, and the dialog needs the space to find the repo.
import { View, div } from "gpui-kit";
import { props, openOverlay, closeOverlay, focused } from "herdr";

const DIALOG_SIZE = {
  new: { width: 460, height: 280 },
  open: { width: 560, height: 480 },
  remove: { width: 440, height: 260 },
};

export function worktreeLauncher(action) {
  return class extends View {
    init(_props, cx) {
      cx.timer.after(0, () => {
        const where = focused();
        closeOverlay(props().overlay);
        openOverlay({ mod: action === "remove" ? "worktree" : "wt-dialog", kind: "dialog", ...DIALOG_SIZE[action], props: { space: where?.space, folder: where?.cwd, action } });
      });
    }
    render() {
      return div();
    }
  };
}
