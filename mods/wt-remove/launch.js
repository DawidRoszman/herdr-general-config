import { View, div } from "gpui-kit";
import { props, openOverlay, closeOverlay, focused, spaces, agents, shared, exec, hc, notify } from "herdr";

const DIALOG_SIZE = {
  new: { width: 460, height: 280 },
  open: { width: 560, height: 480 },
  remove: { width: 440, height: 260 },
};

const FIND_TASK = `d=$(pwd -P)
while :; do
  if [ -f "$d/.mr-task.json" ]; then printf '%s\\n' "$d"; cat "$d/.mr-task.json"; exit 0; fi
  [ "$d" = / ] && exit 0
  d=$(dirname "$d")
done`;

async function focusedTask(where) {
  const space = spaces().find((s) => s.id === where?.space);
  const cwd = where?.cwd || space?.folder;
  if (!cwd) return null;
  const machine = space?.machine ?? null;
  const r = await exec("sh", ["-c", FIND_TASK], { cwd, on: machine ?? undefined });
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `sh exit ${r.code}`);
  const [root, ...file] = r.stdout.split("\n");
  if (!root) return null;
  const task = JSON.parse(file.join("\n"));
  return { root, machine, project: task.project, branch: task.branch, host: task.host ?? null };
}

function coordinatorOf(host) {
  const context = shared("context") ?? {};
  for (const [profile, { projects = {} }] of Object.entries(context.profiles ?? {})) {
    for (const [name, project] of Object.entries(projects)) {
      if (!(project.places ?? []).some((p) => p.machine === host.machine && p.root === host.project)) continue;
      const space = context.coordinators?.[`${profile}/${name}`];
      return agents().find((a) => a.space === space) ?? null;
    }
  }
  return null;
}

async function closeSandbox(task) {
  const coordinator = coordinatorOf(task.host);
  if (!coordinator) return notify({ title: "Close task", body: `${task.machine} is a sandbox: start its project's coordinator, then press this again.`, level: "warning" });
  const r = await hc(["send", coordinator.address, `Close the task in sandbox ${task.machine} (branch ${task.branch}): the person pressed Cmd-Shift-X in its space. Grade it, check nothing is unpushed, then ask the person before you destroy the sandbox.`]);
  if (r.code !== 0) return notify({ title: "Close task", body: `Could not reach the coordinator: ${(r.stderr || r.stdout).trim()}`, level: "error" });
  notify({ title: "Close task", body: `Asked the coordinator to close ${task.branch}. It grades it, then asks you before destroying the sandbox.`, level: "info" });
}

async function openRemove(task, where) {
  if (task?.host) return closeSandbox(task);
  if (task) return openOverlay({ mod: "multirepo", kind: "dialog", width: 760, height: 480, props: { machine: task.machine, project: task.project, removeTask: task.root } });
  openOverlay({ mod: "worktree", kind: "dialog", ...DIALOG_SIZE.remove, props: { space: where?.space, folder: where?.cwd, action: "remove" } });
}

export function worktreeLauncher(action) {
  return class extends View {
    init(_props, cx) {
      if (action === "remove") {
        cx.spawn(async () => {
          const where = focused();

          try {
            await openRemove(await focusedTask(where), where);
          } catch (error) {
            notify({ title: "Remove", body: `Could not tell if this space is a multirepo task: ${error?.message ?? error}`, level: "warning" });
          } finally {
            closeOverlay(props().overlay);
          }
        });
        return;
      }
      cx.timer.after(0, () => {
        const where = focused();
        closeOverlay(props().overlay);
        openOverlay({ mod: "wt-dialog", kind: "dialog", ...DIALOG_SIZE[action], props: { space: where?.space, folder: where?.cwd, action } });
      });
    }
    render() {
      return div();
    }
  };
}
