import { appHome, exec, hc, home, notify, window } from "herdr";

export function fileManagerName() {
  const platform = window()?.platform;
  return platform === "macos" ? "Finder" : platform === "windows" ? "Explorer" : "the file manager";
}

export function revealInFileManager(path, machine, isFile = false) {
  return launch(`Open in ${fileManagerName()}`, path, machine, (path) => {
    const native = path.replace(/\//g, "\\");
    return {
      macos: ["open", ...(isFile ? ["-R"] : []), path],
      windows: ["explorer", isFile ? `/select,${native}` : native],
      other: ["xdg-open", isFile ? path.replace(/\/[^/]*$/, "") : path],
    };
  });
}

export function openWithDefaultApp(path, machine) {
  return launch("Open in the default app", path, machine, (path) => ({
    macos: ["open", path],
    windows: ["cmd", "/c", "start", "", path.replace(/\//g, "\\")],
    other: ["xdg-open", path],
  }));
}

async function launch(title, path, machine, commandsFor) {
  const fail = (body) => notify({ title, body, level: "error" });
  if (!path) return fail("Nothing to open.");
  const platform = window()?.platform;
  let localPath = path;
  if (machine) {
    if (platform !== "macos" && platform !== "linux") return fail(`${path} is on ${machine}; only this computer's files open here.`);
    try {
      localPath = (await mountMachine(machine)) + path;
    } catch (error) {
      return fail(error.message);
    }
  }
  const commands = commandsFor(localPath);
  const [command, ...args] = commands[platform] ?? commands.other;
  const r = await exec(command, args);

  if (r.code !== 0 && platform !== "windows") fail((r.stderr || r.stdout).trim() || `${command} failed`);
}

const mounting = new Map();

function mountMachine(machine) {
  if (!mounting.has(machine)) mounting.set(machine, mount(machine).finally(() => mounting.delete(machine)));
  return mounting.get(machine);
}

const MOUNT_SCRIPT = `
if ! command -v sshfs >/dev/null; then
  if [ "$(uname -s)" = "Darwin" ]; then echo "sshfs is not installed: brew install --cask sshfs-mac"; else echo "sshfs is not installed: install sshfs with your package manager"; fi
  exit 1
fi
log=$(mktemp)
sshfs -f "$1" "$2" -o "$3" >/dev/null 2>"$log" &
pid=$!
for _ in $(seq 1 30); do
  mount | grep -qE " on $2 (\\(|type )" && exit 0
  kill -0 "$pid" 2>/dev/null || { cat "$log"; exit 1; }
  sleep 1
done
kill "$pid"; cat "$log"; echo "sshfs did not mount within 30 seconds"; exit 1
`;

const PROBE_SCRIPT = `
ls "$1" >/dev/null 2>&1 &
p=$!
( sleep 3; kill -9 "$p" 2>/dev/null ) &
w=$!
wait "$p" 2>/dev/null; rc=$?
kill "$w" 2>/dev/null
exit "$rc"
`;

async function mountedAt(mountPoint) {
  const out = (await exec("mount", [])).stdout;
  return out.includes(` on ${mountPoint} (`) || out.includes(` on ${mountPoint} type `);
}

async function mountAlive(mountPoint) {
  return (await exec("sh", ["-c", PROBE_SCRIPT, "sh", mountPoint])).code === 0;
}

async function mount(machine) {
  const isMac = window()?.platform === "macos";
  const mountPoint = `${home()}/Remote/${machine}`;
  if (await mountedAt(mountPoint)) {
    if (await mountAlive(mountPoint)) return mountPoint;

    await exec("sh", ["-c", 'diskutil unmount force "$1" >/dev/null 2>&1 || fusermount3 -uz "$1" >/dev/null 2>&1 || fusermount -uz "$1" >/dev/null 2>&1 || umount -f "$1" >/dev/null 2>&1 || true', "sh", mountPoint]);
  }
  const { target, via } = await machineOf(machine);

  const sandbox = via === true ? /sandbox-via\.sh' '([^']+)' '([^']+)'$/.exec(target) : null;
  await exec("mkdir", ["-p", mountPoint]);
  const options = [

    ...(isMac ? ["backend=fskit", `volname=${machine}`, "noappledouble", "noapplexattr"] : []),
    "reconnect", "ServerAliveInterval=15", "ServerAliveCountMax=3",

    "BatchMode=yes",

    "idmap=user",
    ...(sandbox ? [`ssh_command=${appHome()}/scripts/sandbox-sftp.sh ${sandbox[1]} ${sandbox[2]}`] : []),
  ];
  const r = await exec("sh", ["-c", MOUNT_SCRIPT, "sh", `${sandbox ? sandbox[2] : target}:/`, mountPoint, options.join(",")]);
  if (r.code !== 0) throw new Error(`Could not mount ${machine}: ${(r.stdout || r.stderr).trim() || "sshfs failed"}`);
  return mountPoint;
}

async function machineOf(machine) {
  const r = await hc(["machine", "ls", "--json"]);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || "hc machine ls failed");
  const found = JSON.parse(r.stdout).machines.find((m) => m.name === machine);
  if (!found) throw new Error(`${machine} is not a known machine.`);
  return found;
}
