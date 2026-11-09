// What the Changes panel can show of a repo: a view picks the files and the diff they're read from.
//   all       the working tree against HEAD: staged and unstaged together, new files too
//   unstaged  the working tree against the index, new files too
//   staged    the index against HEAD (what a commit takes)
//   branch    the working tree against where the branch left its base: all the branch's work, committed or not

export const VIEWS = [
  { id: "all", label: "All", empty: "No uncommitted changes" },
  { id: "unstaged", label: "Unstaged", empty: "No unstaged changes" },
  { id: "staged", label: "Staged", empty: "No staged changes" },
  { id: "branch", label: "Branch", empty: "No changes against the base" },
];

const CONFLICTS = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

// `git status --porcelain=v1 -z` entries as a view lists them: [{ path, status, fresh }]. fresh: untracked.
// Branch lists only the untracked ones from here; its tracked files come from its diff (nameStatusFiles).
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

// `git diff --name-status -z --no-renames` as [{ path, status, fresh: false }].
export function nameStatusFiles(output) {
  const fields = output.split("\0"), files = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const code = fields[i];
    if (!code) continue;
    files.push({ path: fields[i + 1], status: code === "A" ? "A" : code === "D" ? "D" : code === "U" ? "U" : "M", fresh: false });
  }
  return files;
}

// What `git diff` compares for a view: its file list's numstats and each file's diff. A repo with no
// commit yet has no HEAD: All reads the index and the working tree; mergeBase is Branch's base commit.
export function diffSides(view, hasHead, mergeBase = null) {
  if (view === "unstaged") return { numstats: [[]], against: [] };
  if (view === "staged") return { numstats: [["--cached"]], against: ["--cached"] };
  if (view === "branch") return { numstats: [[mergeBase]], against: [mergeBase] };
  return hasHead ? { numstats: [["HEAD"]], against: ["HEAD"] } : { numstats: [["--cached"], []], against: [] };
}
