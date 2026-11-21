export const VIEWS = [
  { id: "all", label: "All", empty: "No uncommitted changes" },
  { id: "unstaged", label: "Unstaged", empty: "No unstaged changes" },
  { id: "staged", label: "Staged", empty: "No staged changes" },
  { id: "branch", label: "Branch", empty: "No changes against the base" },
];

const CONFLICTS = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

export function statusFiles(view, statusOutput) {
  return statusOutput.split("\0").filter(Boolean).flatMap((entry) => {
    const xy = entry.slice(0, 2), path = entry.slice(3), fresh = xy === "??";
    if (view === "branch" && !fresh) return [];
    if (view === "staged" && (fresh || xy[0] === " ")) return [];
    if (view === "unstaged" && !fresh && xy[1] === " ") return [];
    const side = view === "staged" ? xy[0] : view === "unstaged" ? xy[1] : xy;
    const status = CONFLICTS.has(xy) ? "U" : side.includes("D") ? "D" : fresh || side.includes("A") ? "A" : "M";
    return [{ path, status, fresh }];
  });
}

export function nameStatusFiles(output) {
  const fields = output.split("\0"), files = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const code = fields[i];
    if (!code) continue;
    files.push({ path: fields[i + 1], status: code === "A" ? "A" : code === "D" ? "D" : code === "U" ? "U" : "M", fresh: false });
  }
  return files;
}

export function diffSides(view, hasHead, mergeBase = null) {
  if (view === "unstaged") return { numstats: [[]], against: [] };
  if (view === "staged") return { numstats: [["--cached"]], against: ["--cached"] };
  if (view === "branch") return { numstats: [[mergeBase]], against: [mergeBase] };
  return hasHead ? { numstats: [["HEAD"]], against: ["HEAD"] } : { numstats: [["--cached"], []], against: [] };
}
