// A folder (or a file, selected in its folder) in this computer's file manager, or a file in its default
// app. Copied verbatim into t3-files (its header button, its files) and t3-panels (the layout's key):
// mods can't import across folders.

import { exec, notify, window } from "herdr";

export function fileManagerName() {
  const platform = window()?.platform;
  return platform === "macos" ? "Finder" : platform === "windows" ? "Explorer" : "the file manager";
}

// machine: the Herdr machine the path is on, null for this computer.
export function revealInFileManager(path, machine, isFile = false) {
  const native = path?.replace(/\//g, "\\");
  return launch(`Open in ${fileManagerName()}`, path, machine, {
    macos: ["open", ...(isFile ? ["-R"] : []), path],
    windows: ["explorer", isFile ? `/select,${native}` : native],
    other: ["xdg-open", isFile ? path?.replace(/\/[^/]*$/, "") : path],
  });
}

export function openWithDefaultApp(path, machine) {
  return launch("Open in the default app", path, machine, {
    macos: ["open", path],
    windows: ["cmd", "/c", "start", "", path?.replace(/\//g, "\\")],
    other: ["xdg-open", path],
  });
}

async function launch(title, path, machine, commands) {
  const fail = (body) => notify({ title, body, level: "error" });
  if (!path) return fail("Nothing to open.");
  if (machine) return fail(`${path} is on ${machine}; only this computer's files open here.`);
  const platform = window()?.platform;
  const [command, ...args] = commands[platform] ?? commands.other;
  const r = await exec(command, args);
  // Explorer exits 1 even when it opened the window.
  if (r.code !== 0 && platform !== "windows") fail((r.stderr || r.stdout).trim() || `${command} failed`);
}
