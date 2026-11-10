#!/usr/bin/env python3
"""mr: work on a multirepo project as if it were a monorepo.

A project is a folder whose children are git repos (e.g. Shop/). A task is
one branch across some of those repos, checked out together in one folder:

    ~/.herdr/projects/<project>/<branch-slug>/
        <repo>/        git worktree on the task branch (repos picked for the task)
        <repo> -> ...  symlink to the project's checkout (every other repo)
        .mr-task.json  which project, branch and repos this is

So tools that expect sibling repos (helper scripts, relative paths) work from
the task root, and `mr pr` opens one cross-linked PR per changed repo.

Commands (run `mr <command> -h` for options):
    init [root]                 record the repos under root in root/.mr.json
    clone <manifest> <root>     clone a project from a manifest (- for stdin)
    projects                    list known projects
    new <branch> <repo>... [--on PARENT]
                                create a task workspace; --on stacks it on another
                                task's branch (its PRs target PARENT, in a GitHub stack)
    add <repo>... [--branch B]  turn linked repos of this task into worktrees; a repo without the
                                task's branch takes its one branch for the same ticket (test/X-1
                                for feat/X-1), or B
    ls                          list a project's tasks
    status                      per-repo state of this task, with PRs
    push                        push repos that have commits
    pull                        fast-forward every repo of this task from its upstream
    pr [--draft] [--title T]    push, open missing PRs, cross-link them all, and
                                stack them on the parent branch's PRs (new --on)
    rm [--force]                remove this task (refuses to lose work)
    manifest                    print this project's manifest
    prs [--repo PATH]           open and recently closed PRs of every repo (JSON);
                                --repo: of one plain repo instead of a project
    pr-view <branch>... [--repo P] those branches' PRs in every repo, in full (JSON)
    pr-diff <slug> <number>     one PR's diff
    commit-diff <slug> <oid>    one commit's diff
    restack [branch] [--repo P] rebase every open PR of the branch's GitHub stacks onto
                                the one below (the bottom onto the stack's base) and
                                force-push what moved; no branch: this task's
    pr-act <slug> <number> <action> [--body B]
                                approve, request-changes, comment, merge, ready, draft,
                                merge-stack (a stacked PR and every open PR below it)
    pr-candidates <slug>        who can be asked to review in a repo (JSON)
    pr-reviewers <slug> <number> [--add a,b] [--remove c]
                                request or withdraw review requests on one PR
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from pathlib import Path

VERSION = "1"
PROJECT_FILE = ".mr.json"
TASK_FILE = ".mr-task.json"
REGISTRY = Path.home() / ".config" / "mr" / "projects.json"
WORKSPACES = Path.home() / ".herdr" / "projects"
RELATED_START = "<!-- mr:related -->"
RELATED_END = "<!-- /mr:related -->"
# Closed and merged PRs stay in `mr prs` this long, so a watcher sees them change state.
RECENTLY_CLOSED = timedelta(days=3)
CHECK_OUTCOMES = {
    "passed": {"SUCCESS", "NEUTRAL", "SKIPPED", "COMPLETED"},
    "failed": {"FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"},
}
# A branch's latest PR with everything the review tab shows, inline comments included, in one round
# trip. ponytail: lists stop at their first page (100 comments, reviews, threads, commits, checks);
# only files are paged, since the Files tab must list every one. Page the others if PRs outgrow them.
PR_SCALARS = ("number title body state isDraft url headRefName headRefOid baseRefName additions deletions changedFiles "
              "mergeable mergeStateStatus reviewDecision createdAt updatedAt").split()
PR_DETAIL_QUERY = """query($owner: String!, $name: String!, $branch: String!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    pullRequests(headRefName: $branch, first: 1, orderBy: {field: CREATED_AT, direction: DESC}) { nodes {
      %s
      author { login }
      reviewRequests(first: 50) { nodes { requestedReviewer { __typename ... on User { login } ... on Team { name } } } }
      latestReviews(first: 50) { nodes { id author { login } state body submittedAt } }
      reviews(first: 100) { nodes { id author { login } state body submittedAt } }
      comments(first: 100) { nodes { author { login } body createdAt url } }
      reviewThreads(first: 100) { nodes { diffSide startDiffSide isOutdated comments(first: 100) { nodes { author { login } body createdAt url path line originalLine startLine originalStartLine } } } }
      commits(first: 100) { nodes { commit { oid messageHeadline messageBody committedDate authoredDate
        authors(first: 5) { nodes { name email user { login } } } } } }
      lastCommit: commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
        __typename
        ... on CheckRun { name status conclusion startedAt completedAt detailsUrl checkSuite { workflowRun { event workflow { name } } } }
        ... on StatusContext { context state targetUrl createdAt } } } } } } }
      files(first: 100) { pageInfo { hasNextPage endCursor } nodes { path additions deletions changeType } }
      stackEntry { position }
      stack { number size baseRefName entries(first: 100) { nodes { position pullRequest {
        number title state isDraft headRefName url viewerCanUpdateBranch } } } }
    } }
  }
}""" % " ".join(PR_SCALARS)
PR_FILES_QUERY = """query($owner: String!, $name: String!, $number: Int!, $after: String!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    files(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { path additions deletions changeType } } } }
}"""
PR_ACTIONS = {
    "approve": ["review", "--approve"],
    "request-changes": ["review", "--request-changes"],
    "comment": ["comment"],
    "merge": ["merge", "--merge"],
    "ready": ["ready"],
    "draft": ["ready", "--undo"],
}


class MrError(Exception):
    """A failure the user can act on; printed without a traceback."""


# ---------------------------------------------------------------- pure helpers


def branch_slug(branch: str) -> str:
    """feat/SHOP-130-x -> feat-SHOP-130-x, safe as a folder name."""
    slug = re.sub(r"[^A-Za-z0-9._-]+", "-", branch).strip("-.")
    if not slug:
        raise MrError(f"Branch name {branch!r} has no usable characters.")
    return slug


def ticket_key(branch: str) -> str | None:
    """feat/SHOP-130-x -> SHOP-130: the ticket a branch is for, or None."""
    match = re.search(r"(?<![A-Za-z0-9])[A-Z][A-Z0-9]*-\d+(?![A-Za-z0-9])", branch)
    return match[0] if match else None


def same_ticket_branches(branch: str, refs: list[str]) -> list[str]:
    """Other branches for branch's ticket among refs (`refs/heads/...` and `refs/remotes/origin/...`),
    as branch names: test/SHOP-130-x beside feat/SHOP-130-x. None without a ticket key."""
    key = ticket_key(branch)
    names = {re.sub(r"^refs/(heads|remotes/origin)/", "", ref) for ref in refs if ref != "refs/remotes/origin/HEAD"}
    return sorted(name for name in names if key and name != branch and ticket_key(name) == key)


def title_from_branch(branch: str) -> str:
    """feat/SHOP-130-checkout-flow -> feat(SHOP-130): checkout flow (conventional commit style)."""
    match = re.match(r"^(?P<type>[a-z]+)/(?P<ticket>[A-Z][A-Z0-9]*-\d+)-?(?P<rest>.*)$", branch)
    if match:
        rest = match["rest"].replace("-", " ").strip() or match["ticket"]
        return f"{match['type']}({match['ticket']}): {rest}"
    kind, _, rest = branch.partition("/")
    return f"{kind}: {rest.replace('-', ' ')}" if rest else branch.replace("-", " ")


def match_repos(wanted: list[str], available: list[str]) -> list[str]:
    """Resolve names like 'backend' to 'acme-shop-backend': exact, else a unique suffix or substring."""
    resolved = []
    for name in wanted:
        if name in available:
            resolved.append(name)
            continue
        candidates = [r for r in available if r.endswith(name)] or [r for r in available if name in r]
        if len(candidates) != 1:
            hint = ", ".join(candidates) if candidates else ", ".join(available)
            raise MrError(f"{name!r} matches {'several' if candidates else 'no'} repos: {hint}")
        resolved.append(candidates[0])
    return list(dict.fromkeys(resolved))


def split_repo_branches(words: list[str]) -> tuple[list[str], dict[str, str]]:
    """'backend portal=fix/other-name' -> (['backend', 'portal'], {'portal': 'fix/other-name'}): a repo whose
    branch for the task is named differently (someone else's naming) is given with its branch."""
    names, branches = [], {}
    for word in words:
        name, _, branch = word.partition("=")
        names.append(name)
        if branch:
            branches[name] = branch
    return names, branches


def resolve_repos(words: list[str], available: list[str]) -> tuple[list[str], dict[str, str]]:
    """split_repo_branches with the repo names resolved (match_repos), the branches keyed by full name."""
    names, branches = split_repo_branches(words)
    full_names = [match_repos([name], available)[0] for name in names]
    return list(dict.fromkeys(full_names)), {full: branches[name] for full, name in zip(full_names, names) if name in branches}


def with_related_section(body: str, links: list[str]) -> str:
    """Replace (or append) the block listing the task's other PRs, leaving the rest of the body alone."""
    block = RELATED_START + "\n**Related PRs**\n" + "\n".join(f"- {link}" for link in links) + "\n" + RELATED_END
    if RELATED_START in body and RELATED_END in body:
        before, rest = body.split(RELATED_START, 1)
        after = rest.split(RELATED_END, 1)[1]
        return before + block + after
    return (body.rstrip() + "\n\n" if body.strip() else "") + block


def short_names(names: list[str]) -> dict[str, str]:
    """Drops the longest dash-ended prefix a name shares with another repo: acme-shop-backend -> backend."""
    shorts = {}
    for name in names:
        cuts = [i + 1 for i, char in enumerate(name[:-1]) if char == "-"]
        shared = [cut for cut in cuts if any(other != name and other.startswith(name[:cut]) for other in names)]
        shorts[name] = name[max(shared):] if shared else name
    return shorts


GIT_URL = re.compile(r"^(?:https://(?P<web>[^/]+)/|ssh://(?:[^@/]+@)?(?P<ssh>[^/:]+)(?::\d+)?/|(?:[^@/]+@)?(?P<scp>[^/:]+):)"
                     r"(?P<slug>[^/]+/[^/]+?)(?:\.git)?/?$")


@lru_cache(maxsize=None)
def ssh_hostname(host: str) -> str:
    """The host an ssh alias stands for (Host github / HostName github.com in ~/.ssh/config), read
    with `ssh -G`, which connects nowhere; the name itself when ssh can't say."""
    try:
        r = subprocess.run(["ssh", "-G", host], capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.TimeoutExpired):
        return host
    return next((line.split(None, 1)[1] for line in r.stdout.splitlines() if line.startswith("hostname ")), host)


def github_slug(url: str) -> str | None:
    """git@github.com:Owner/repo.git, an ssh alias for github.com (git@github:Owner/repo) or
    https://github.com/Owner/repo -> Owner/repo; None off GitHub."""
    match = GIT_URL.match(url)
    if not match:
        return None
    host = match["web"] or ssh_hostname(match["ssh"] or match["scp"])
    return match["slug"] if host == "github.com" else None


def check_counts(states: list[dict]) -> dict:
    """GitHub's per-state check counts folded into passed / failed / pending."""
    counts = {"passed": 0, "failed": 0, "pending": 0}
    for entry in states:
        outcome = next((name for name, members in CHECK_OUTCOMES.items() if entry["state"] in members), "pending")
        counts[outcome] += entry["count"]
    return counts


def summarize_pr(node: dict, repo: str, slug: str, viewer: str) -> dict:
    """One PR from the `mr prs` GraphQL query, flattened for the monitor."""
    rollup = (node["commits"]["nodes"] or [{}])[0].get("commit", {}).get("statusCheckRollup")
    contexts = (rollup or {}).get("contexts") or {}
    requested = [r["requestedReviewer"] for r in node["reviewRequests"]["nodes"] if r["requestedReviewer"]]
    return {
        "repo": repo,
        "slug": slug,
        "number": node["number"],
        "title": node["title"],
        "url": node["url"],
        "branch": node["headRefName"],
        "base": node["baseRefName"],
        "state": node["state"],
        "isDraft": node["isDraft"],
        "author": (node["author"] or {}).get("login", "ghost"),
        "updatedAt": node["updatedAt"],
        "additions": node["additions"],
        "deletions": node["deletions"],
        "reviewDecision": node["reviewDecision"],
        "isReviewRequestedFromMe": any(r.get("login") == viewer for r in requested),
        "reviews": [{"author": (r["author"] or {}).get("login", "ghost"), "state": r["state"]} for r in node["latestReviews"]["nodes"]],
        "checks": rollup["state"] if rollup else None,
        "checkCounts": check_counts(contexts.get("checkRunCountsByState", []) + contexts.get("statusContextCountsByState", [])),
        "comments": node["comments"]["totalCount"],
        "inlineComments": sum(t["comments"]["totalCount"] for t in node["reviewThreads"]["nodes"]),
        "stack": _stack(node),
    }


def is_worth_watching(pr: dict, now: datetime) -> bool:
    if pr["state"] == "OPEN":
        return True
    updated = datetime.fromisoformat(pr["updatedAt"].replace("Z", "+00:00"))
    return now - updated <= RECENTLY_CLOSED


# Open PRs are asked for on their own: mixed with closed ones by update time, a busy repo's
# recently merged PRs pushed its older open ones out of the page.
OPEN_PR_LIMIT = 50  # ponytail: one page; paginate if a repo ever has more open PRs
CLOSED_PR_LIMIT = 10


def prs_query(slug: str) -> str:
    owner, name = slug.split("/", 1)
    fields = """number title url headRefName baseRefName isDraft state updatedAt additions deletions reviewDecision
      author { login }
      comments { totalCount }
      reviewThreads(first: 50) { nodes { comments { totalCount } } }
      reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login } ... on Team { name } } } }
      latestReviews(first: 20) { nodes { author { login } state } }
      stackEntry { position }
      stack { number size }
      commits(last: 1) { nodes { commit { statusCheckRollup { state contexts {
        checkRunCountsByState { state count } statusContextCountsByState { state count } } } } } }"""
    order = "orderBy: {field: UPDATED_AT, direction: DESC}"
    return (f"query {{ viewer {{ login }}\n  repository(owner: {json.dumps(owner)}, name: {json.dumps(name)}) {{\n"
            f"    open: pullRequests(first: {OPEN_PR_LIMIT}, states: [OPEN], {order}) {{ nodes {{ {fields} }} }}\n"
            f"    closed: pullRequests(first: {CLOSED_PR_LIMIT}, states: [MERGED, CLOSED], {order}) {{ nodes {{ {fields} }} }}\n"
            "  }\n}")


def _stack(node: dict) -> dict | None:
    """Where a PR sits in its GitHub stack (position 1 is next to the base), with the stack's PRs when
    the query asked for them; None when it is in no stack."""
    stack = node.get("stack")
    if not stack:
        return None
    found = {"number": stack["number"], "size": stack["size"], "position": node["stackEntry"]["position"]}
    if "entries" in stack:
        found["base"] = stack["baseRefName"]
        found["entries"] = [_stack_entry(e) for e in stack["entries"]["nodes"]]
    return found


def _stack_entry(entry: dict) -> dict:
    pr = dict(entry["pullRequest"])
    # GitHub offers to update a branch only when its base has moved past it: the layer needs a restack.
    pr["isBehind"] = pr.pop("viewerCanUpdateBranch")
    return {"position": entry["position"], **pr}


def _login(actor: dict | None) -> str:
    return (actor or {}).get("login", "ghost")


def _review(raw: dict) -> dict:
    return {"id": raw["id"], "author": {"login": _login(raw["author"])}, "state": raw["state"], "body": raw["body"],
            "submittedAt": raw["submittedAt"]}


def _commit(raw: dict) -> dict:
    authors = [{"name": a["name"], "email": a["email"], "login": (a["user"] or {}).get("login", "")} for a in raw["authors"]["nodes"]]
    return {key: raw[key] for key in ("oid", "messageHeadline", "messageBody", "committedDate", "authoredDate")} | {"authors": authors}


def _check(raw: dict) -> dict:
    if raw["__typename"] == "CheckRun":
        run = (raw.get("checkSuite") or {}).get("workflowRun") or {}
        workflow = run.get("workflow") or {}
        # workflowEvent tells apart one check run twice, e.g. for "push" and for "pull_request".
        return {key: raw[key] for key in ("__typename", "name", "status", "conclusion", "startedAt", "completedAt", "detailsUrl")} | {
            "workflowName": workflow.get("name", ""), "workflowEvent": run.get("event") or ""}
    return {"__typename": raw["__typename"], "context": raw.get("context"), "state": raw.get("state"),
            "targetUrl": raw.get("targetUrl"), "startedAt": raw.get("createdAt")}


def detail_pr(node: dict, name: str, slug: str) -> dict:
    """A PR_DETAIL_QUERY node in the shape `gh pr view --json` gives (the parts the prs mod reads)."""
    last = node["lastCommit"]["nodes"]
    rollup = last[0]["commit"]["statusCheckRollup"] if last else None
    return {key: node[key] for key in PR_SCALARS} | {
        "author": {"login": _login(node["author"])},
        "reviewRequests": [r["requestedReviewer"] for r in node["reviewRequests"]["nodes"] if r["requestedReviewer"]],
        "latestReviews": [_review(r) for r in node["latestReviews"]["nodes"]],
        "reviews": [_review(r) for r in node["reviews"]["nodes"]],
        "comments": [{"author": {"login": _login(c["author"])}, "body": c["body"], "createdAt": c["createdAt"], "url": c["url"]}
                     for c in node["comments"]["nodes"]],
        "commits": [_commit(n["commit"]) for n in node["commits"]["nodes"]],
        "statusCheckRollup": [_check(c) for c in (rollup["contexts"]["nodes"] if rollup else [])],
        "files": node["files"]["nodes"],
        # A thread's first comment starts it; the rest answer it.
        # side and isOutdated place a thread on the Files tab's diff: an outdated one has no line there now.
        "inlineComments": [{"author": _login(c["author"]), "body": c["body"], "createdAt": c["createdAt"], "url": c["url"],
                            "path": c["path"], "line": c["line"] or c["originalLine"], "side": thread.get("diffSide") or "RIGHT",
                            "startLine": c.get("startLine") or c.get("originalStartLine"), "startSide": thread.get("startDiffSide"),
                            "isOutdated": bool(thread.get("isOutdated")), "isReply": i > 0}
                           for thread in node["reviewThreads"]["nodes"] for i, c in enumerate(thread["comments"]["nodes"])],
        "stack": _stack(node),
        "repo": name,
        "slug": slug,
    }


def worktree_on_branch(porcelain: str, branch: str) -> str | None:
    """Where `git worktree list --porcelain` says branch is checked out, if anywhere. Not a worktree
    whose folder is gone (prunable): T3 Code's, say, deleted without git being told."""
    for block in porcelain.strip().split("\n\n"):
        lines = block.splitlines()
        if f"branch refs/heads/{branch}" in lines and not any(line.startswith("prunable") for line in lines):
            return next(line.removeprefix("worktree ") for line in lines if line.startswith("worktree "))
    return None


def is_unsafe_to_remove(repo: dict) -> str:
    """Why removing this worktree would lose work, or '' when it would not."""
    if repo["dirty"]:
        return f"{repo['dirty']} uncommitted change(s)"
    if repo["unpushed"]:
        return f"{repo['unpushed']} commit(s) not pushed"
    return ""


# ---------------------------------------------------------------------- io


def run(args: list[str], cwd: Path | None = None, check: bool = True, stdin: str | None = None) -> str:
    result = subprocess.run(args, cwd=cwd, input=stdin, capture_output=True, text=True)
    if check and result.returncode != 0:
        detail = (result.stderr or result.stdout).strip()
        raise MrError(f"{' '.join(args[:3])} failed in {cwd or os.getcwd()}: {detail}")
    return result.stdout.strip()


def git(repo: Path, *args: str, check: bool = True) -> str:
    return run(["git", "-C", str(repo), *args], check=check)


def read_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        raise MrError(f"{path} does not exist.") from None
    except json.JSONDecodeError as error:
        raise MrError(f"{path} is not valid JSON: {error}") from None


def write_json(path: Path, data: dict) -> None:
    path.write_text(json.dumps(data, indent=2) + "\n")


def registered_projects() -> list[str]:
    return read_json(REGISTRY)["projects"] if REGISTRY.exists() else []


def register(root: Path) -> None:
    projects = [p for p in registered_projects() if Path(p).exists() and Path(p) != root]
    REGISTRY.parent.mkdir(parents=True, exist_ok=True)
    write_json(REGISTRY, {"projects": sorted([*projects, str(root)])})


def has_ref(repo: Path, ref: str) -> bool:
    return subprocess.run(["git", "-C", str(repo), "show-ref", "--verify", "--quiet", ref]).returncode == 0


def tip_of(repo: Path, branch: str) -> str:
    """origin's copy of a branch, or the local one while it is not pushed yet (a parent task's new branch)."""
    return f"origin/{branch}" if has_ref(repo, f"refs/remotes/origin/{branch}") else branch


def default_branch(repo: Path) -> str:
    # Ask the remote: a clone's origin/HEAD is set once and goes stale when the default changes.
    symref = git(repo, "ls-remote", "--symref", "origin", "HEAD", check=False)
    match = re.search(r"^ref: refs/heads/(\S+)\s+HEAD", symref, re.M)
    if match:
        return match[1]
    ref = git(repo, "symbolic-ref", "--short", "refs/remotes/origin/HEAD", check=False)
    return ref.removeprefix("origin/") if ref else git(repo, "branch", "--show-current")


@dataclass
class Project:
    root: Path
    name: str
    repos: list[dict]

    @classmethod
    def load(cls, root: Path) -> "Project":
        data = read_json(root / PROJECT_FILE)
        return cls(root=root, name=data["name"], repos=data["repos"])

    def repo(self, name: str) -> dict:
        return next(r for r in self.repos if r["name"] == name)

    @property
    def workspaces(self) -> Path:
        return WORKSPACES / self.name


@dataclass
class Task:
    root: Path
    project: Project
    branch: str
    repos: list[str]  # the ones on the task branch
    # Of those, the ones whose branch was already checked out elsewhere (another tool's worktree):
    # linked to that checkout, never removed by mr rm.
    borrowed: list[str] = field(default_factory=list)
    on: str | None = None  # the parent task's branch this one is stacked on (mr new --on)
    # Repos on a branch of their own for the same ticket (an e2e repo's test/X-1 beside feat/X-1).
    branches: dict[str, str] = field(default_factory=dict)

    @classmethod
    def load(cls, root: Path) -> "Task":
        data = read_json(root / TASK_FILE)
        return cls(root=root, project=Project.load(Path(data["project"])), branch=data["branch"], repos=data["repos"],
                   borrowed=data.get("borrowed", []), on=data.get("on"), branches=data.get("branches", {}))

    def save(self) -> None:
        write_json(self.root / TASK_FILE, {"project": str(self.project.root), "branch": self.branch, "repos": self.repos,
                                           "borrowed": self.borrowed, **({"on": self.on} if self.on else {}),
                                           **({"branches": self.branches} if self.branches else {})})

    def branch_of(self, name: str) -> str:
        """The branch a repo of this task is on: its own, else the task's."""
        return self.branches.get(name, self.branch)

    def base(self, name: str) -> str:
        """The branch a repo of this task builds on: the parent's branch when stacked and the repo has
        it (repos the parent never touched build on their default), else the repo's default."""
        repo = self.project.root / name
        if self.on and (has_ref(repo, f"refs/remotes/origin/{self.on}") or has_ref(repo, f"refs/heads/{self.on}")):
            return self.on
        return self.project.repo(name)["base"]


def find_upwards(start: Path, marker: str) -> Path | None:
    for folder in [start, *start.parents]:
        if (folder / marker).exists():
            return folder
    return None


def current_task(path: str | None) -> Task:
    root = find_upwards(Path(path or os.getcwd()).resolve(), TASK_FILE)
    if not root:
        raise MrError("Not inside a task workspace. Run this from one, or pass --task <path>.")
    return Task.load(root)


def current_project(path: str | None) -> Project:
    start = Path(path or os.getcwd()).resolve()
    task_root = find_upwards(start, TASK_FILE)
    if task_root:
        return Task.load(task_root).project
    root = find_upwards(start, PROJECT_FILE)
    if root:
        return Project.load(root)
    projects = registered_projects()
    if len(projects) == 1:
        return Project.load(Path(projects[0]))
    raise MrError("Which project? Run from inside one or pass --project <root>. Known: " + (", ".join(projects) or "none, run mr init"))


def repo_branch(repo: Path, task_branch: str, chosen: str | None) -> str:
    """The branch a repo takes in a task: the chosen one, else the task's when the repo has it, else the
    repo's one branch for the same ticket (test/X-1 for feat/X-1), else the task's, made new."""
    if chosen:
        return chosen
    if has_ref(repo, f"refs/heads/{task_branch}") or has_ref(repo, f"refs/remotes/origin/{task_branch}"):
        return task_branch
    refs = git(repo, "for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes/origin").splitlines()
    found = same_ticket_branches(task_branch, refs)
    if len(found) > 1:
        raise MrError(f"{repo.name} has several branches for {ticket_key(task_branch)}: {', '.join(found)}. "
                      f"Pick one with mr add {repo.name} --branch <branch> (leave it out of mr new).")
    return found[0] if found else task_branch


def checkout_task_repo(task: Task, name: str, chosen: str | None = None) -> None:
    """Make <task>/<name> a worktree on its branch (repo_branch), from origin's base when the branch is new.

    Git keeps a branch in one worktree only: when another one (the project checkout, T3 Code's)
    already has it, <task>/<name> links to that checkout instead and the repo is marked borrowed."""
    repo = task.project.root / name
    target = task.root / name
    if target.is_symlink():
        target.unlink()
    git(repo, "fetch", "--quiet", "origin")
    # A worktree whose folder is gone still holds its branch: git won't check it out again until told.
    git(repo, "worktree", "prune")
    branch = repo_branch(repo, task.branch, chosen)
    if branch != task.branch:
        task.branches[name] = branch
        print(f"{name}: on {branch}, {'as given' if chosen else 'its branch for this ticket'}", flush=True)
    existing = worktree_on_branch(git(repo, "worktree", "list", "--porcelain"), branch)
    if existing:
        target.symlink_to(existing)
        task.borrowed.append(name)
        print(f"{name}: {branch} is already checked out at {existing}; linked to it", flush=True)
    elif has_ref(repo, f"refs/heads/{branch}"):
        git(repo, "worktree", "add", str(target), branch)
        # A local branch left from an earlier checkout can be behind origin's: caught up when it has
        # nothing of its own (a branch that went its own way stays as it is).
        if has_ref(repo, f"refs/remotes/origin/{branch}"):
            git(target, "merge", "--ff-only", "--quiet", f"origin/{branch}", check=False)
    elif has_ref(repo, f"refs/remotes/origin/{branch}"):
        git(repo, "worktree", "add", "--track", "-b", branch, str(target), f"origin/{branch}")
    else:
        git(repo, "worktree", "add", "--no-track", "-b", branch, str(target), tip_of(repo, task.base(name)))


def repo_state(task: Task, name: str, with_pr: bool) -> dict:
    path = task.root / name
    base = task.base(name)
    counts = git(path, "rev-list", "--left-right", "--count", f"{tip_of(path, base)}...HEAD", check=False).split()
    behind, ahead = (int(counts[0]), int(counts[1])) if len(counts) == 2 else (0, 0)
    has_upstream = git(path, "rev-parse", "--abbrev-ref", "@{u}", check=False) != ""
    unpushed = int(git(path, "rev-list", "--count", "@{u}..HEAD")) if has_upstream else ahead
    dirty = len([line for line in git(path, "status", "--porcelain").splitlines() if line.strip()])
    state = {"name": name, "branch": task.branch_of(name), "base": base, "ahead": ahead, "behind": behind, "dirty": dirty,
             "unpushed": unpushed, "pr": None}
    if with_pr:
        raw = run(["gh", "pr", "view", task.branch_of(name), "--json", "number,state,url,isDraft,title"], cwd=path, check=False)
        state["pr"] = json.loads(raw) if raw.startswith("{") else None
    return state


def push(task: Task, name: str) -> None:
    git(task.root / name, "push", "--quiet", "-u", "origin", task.branch_of(name))


# ------------------------------------------------------------------ commands


def cmd_init(args) -> None:
    root = Path(args.root or os.getcwd()).resolve()
    repos = []
    for child in sorted(root.iterdir()):
        if child.is_dir() and not child.is_symlink() and (child / ".git").exists():
            url = git(child, "remote", "get-url", "origin", check=False)
            if not url:
                print(f"skipping {child.name}: no origin remote", file=sys.stderr)
                continue
            repos.append({"name": child.name, "url": url, "base": default_branch(child)})
    if not repos:
        raise MrError(f"No git repos with an origin remote directly under {root}.")
    write_json(root / PROJECT_FILE, {"name": args.name or root.name, "repos": repos})
    register(root)
    print(f"{root}: {len(repos)} repos ({', '.join(r['name'] for r in repos)})")


def cmd_clone(args) -> None:
    if args.manifest == "-":
        manifest = json.loads(sys.stdin.read())
    elif args.manifest.lstrip().startswith("{"):
        manifest = json.loads(args.manifest)  # passed inline, e.g. by the Herdr dialog
    else:
        manifest = read_json(Path(args.manifest))
    root = Path(args.root).expanduser().resolve()
    root.mkdir(parents=True, exist_ok=True)
    for repo in manifest["repos"]:
        target = root / repo["name"]
        if target.exists():
            print(f"{repo['name']}: already there")
            continue
        print(f"{repo['name']}: cloning {repo['url']}", flush=True)
        run(["git", "clone", "--quiet", repo["url"], str(target)])
    write_json(root / PROJECT_FILE, manifest)
    register(root)
    print(f"{root}: ready")


def cmd_projects(args) -> None:
    projects = []
    for root in registered_projects():
        if (Path(root) / PROJECT_FILE).exists():
            project = Project.load(Path(root))
            projects.append({"name": project.name, "root": root, "repos": [r["name"] for r in project.repos]})
    if args.json:
        print(json.dumps({"version": VERSION, "projects": projects}))
    else:
        for p in projects:
            print(f"{p['name']}\t{p['root']}\t{len(p['repos'])} repos")


def cmd_manifest(args) -> None:
    print((current_project(args.project).root / PROJECT_FILE).read_text(), end="")


def link_project_env(task_root: Path, project_root: Path) -> None:
    """A task folder sits under ~/.herdr, outside its project's, so the direnv .envrc that applies to the
    project (a GH_TOKEN, a CLAUDE_CONFIG_DIR for a work account) doesn't reach the task's shells and agents.
    An .envrc of its own loads that one. Nothing without direnv or a project .envrc, or when it has one."""
    envrc = next((folder / ".envrc" for folder in [project_root, *project_root.parents] if (folder / ".envrc").is_file()), None)
    target = task_root / ".envrc"
    if envrc is None or target.exists() or not shutil.which("direnv"):
        return
    target.write_text(f"# Written by mr: this task is outside {project_root}, so it loads the environment there.\n"
                      f"source_env {shlex.quote(str(envrc))}\n")
    allowed = subprocess.run(["direnv", "allow", str(target)], capture_output=True, text=True)
    if allowed.returncode != 0:
        print(f"mr: direnv allow {target}: {allowed.stderr.strip()}", file=sys.stderr)


def cmd_new(args) -> None:
    project = current_project(args.project)
    names, chosen = resolve_repos(args.repos, [r["name"] for r in project.repos])
    root = project.workspaces / branch_slug(args.branch)
    if root.exists():
        raise MrError(f"{root} already exists. Open it, or remove it with mr rm.")
    root.mkdir(parents=True)
    task = Task(root=root, project=project, branch=args.branch, repos=names, on=args.on)
    try:
        for repo in project.repos:
            if repo["name"] not in names:
                (root / repo["name"]).symlink_to(project.root / repo["name"])
        for name in names:
            print(f"{name}: {chosen.get(name, args.branch)}", flush=True)
            checkout_task_repo(task, name, chosen.get(name))
        if task.on and all(task.base(name) != task.on for name in names):
            raise MrError(f"None of {', '.join(names)} has a branch {task.on} to stack on.")
        task.save()
        link_project_env(root, project.root)
    except MrError:
        # Leave nothing half made: worktrees already added stay registered in their repos.
        for name in names:
            if (root / name).is_dir() and not (root / name).is_symlink():
                git(project.root / name, "worktree", "remove", "--force", str(root / name), check=False)
        shutil.rmtree(root, ignore_errors=True)
        raise
    print(root)


def cmd_add(args) -> None:
    task = current_task(args.task)
    resolved, chosen = resolve_repos(args.repos, [r["name"] for r in task.project.repos])
    names = [n for n in resolved if n not in task.repos]
    if args.branch and len(names) != 1:
        raise MrError("--branch is for one repo at a time; give several as repo=branch.")
    link_project_env(task.root, task.project.root)  # tasks made before mr wrote one get it here
    for name in names:
        checkout_task_repo(task, name, chosen.get(name, args.branch))
        task.repos.append(name)
        task.save()
        print(f"{name}: {task.branch_of(name)}")


def task_summaries(project: Project, with_status: bool) -> list[dict]:
    if not project.workspaces.exists():
        return []
    loaded = [Task.load(folder) for folder in sorted(project.workspaces.iterdir()) if (folder / TASK_FILE).exists()]
    found = found_parents(project, loaded) if with_status else {}
    tasks = []
    for task in loaded:
        summary = {"branch": task.branch, "root": str(task.root), "repos": task.repos, "branches": task.branches, "on": task.on}
        if with_status:
            summary["status"] = [repo_state(task, name, with_pr=False) for name in task.repos]
            summary["stackedOn"] = task.on or found.get(task.branch)
        tasks.append(summary)
    return tasks


def found_parents(project: Project, tasks: list[Task]) -> dict[str, str]:
    """Task branch -> the task branch it builds on, for tasks that don't record one (made without --on, their
    PRs retargeted later): in a repo both have, the other task's branch is in this one's history and not in the
    base's. With several, the nearest (the one the others are below). Local git only, so a layer below with
    commits this one lacks (not restacked yet) isn't found."""
    merged: dict[tuple[str, str], set[str]] = {}

    def heads_in(name: str, rev: str) -> set[str]:
        if (name, rev) not in merged:
            out = run(["git", "for-each-ref", "--merged", rev, "--format=%(refname:short)", "refs/heads"],
                      cwd=project.root / name, check=False)
            merged[(name, rev)] = set(out.split())
        return merged[(name, rev)]

    def is_below(other: Task, task: Task, name: str) -> bool:
        mine, theirs = task.branch_of(name), other.branch_of(name)
        return (theirs in heads_in(name, mine) and mine not in heads_in(name, theirs)
                and theirs not in heads_in(name, tip_of(project.root / name, project.repo(name)["base"])))

    parents = {}
    for task in tasks:
        if task.on:
            continue
        below = [(other, shared[0]) for other in tasks if other is not task
                 for shared in [[n for n in task.repos if n in other.repos]] if shared and is_below(other, task, shared[0])]
        if below:
            nearest, _ = max(below, key=lambda b: sum(is_below(o, b[0], b[1]) for o, _ in below if o is not b[0] and b[1] in o.repos))
            parents[task.branch] = nearest.branch
    return parents


def cmd_ls(args) -> None:
    project = current_project(args.project)
    tasks = task_summaries(project, with_status=args.json)
    if args.json:
        names = [r["name"] for r in project.repos]
        print(json.dumps({"project": project.name, "root": str(project.root), "repos": names, "shorts": short_names(names), "tasks": tasks}))
        return
    for t in tasks:
        print(f"{t['branch']}\t{', '.join(t['repos'])}\t{t['root']}")


def cmd_status(args) -> None:
    task = current_task(args.task)
    repos = [repo_state(task, name, with_pr=not args.no_pr) for name in task.repos]
    if args.json:
        print(json.dumps({"branch": task.branch, "root": str(task.root), "repos": repos}))
        return
    print(f"{task.branch}  ({task.root})")
    for r in repos:
        pr = r["pr"]
        pr_text = f"PR #{pr['number']} {pr['state'].lower()}{' draft' if pr['isDraft'] else ''}" if pr else "no PR"
        own = f" on {r['branch']}" if r["branch"] != task.branch else ""
        print(f"  {r['name']}{own}: +{r['ahead']} -{r['behind']} vs {r['base']}, {r['dirty']} dirty, {r['unpushed']} unpushed, {pr_text}")


def cmd_push(args) -> None:
    task = current_task(args.task)
    for name in task.repos:
        state = repo_state(task, name, with_pr=False)
        if state["unpushed"]:
            print(f"{name}: pushing {state['unpushed']} commit(s)", flush=True)
            push(task, name)


# Fast-forward only: a diverged repo is reported, not merged, and the other repos still pull.
def cmd_pull(args) -> None:
    task = current_task(args.task)
    failures = []
    for name in task.repos:
        try:
            result = git(task.root / name, "pull", "--ff-only")
            print(f"{name}: {result.splitlines()[-1] if result else 'up to date'}", flush=True)
        except MrError as error:
            failures.append(f"{name}: {error}")
            print(failures[-1], flush=True)
    if failures:
        raise MrError(f"{len(failures)} repo(s) did not pull.")


def cmd_pr(args) -> None:
    task = current_task(args.task)
    title = args.title or title_from_branch(task.branch)
    changed = [repo_state(task, name, with_pr=True) for name in task.repos]
    changed = [r for r in changed if r["ahead"] > 0 or r["pr"]]
    if not changed:
        raise MrError("No repo in this task has commits on top of its base yet.")
    off_github = [r["name"] for r in changed if not github_slug(task.project.repo(r["name"])["url"])]
    if off_github:
        raise MrError(f"{', '.join(off_github)}: origin is not on GitHub, where mr pr opens PRs.")
    for r in changed:
        if args.dry_run:
            print(f"{r['name']}: would push and {'keep PR #' + str(r['pr']['number']) if r['pr'] else 'open a PR into ' + r['base']}")
            continue
        if r["base"] == task.on and not has_ref(task.root / r["name"], f"refs/remotes/origin/{task.on}"):
            raise MrError(f"{r['name']}: push {task.on} first (mr push in its task); this PR targets it.")
        if r["unpushed"]:
            push(task, r["name"])
        if not r["pr"]:
            cwd = task.root / r["name"]
            run(["gh", "pr", "create", "--base", r["base"], "--head", r["branch"], "--title", title,
                 "--body", args.body or "", *(["--draft"] if args.draft else [])], cwd=cwd)
            r["pr"] = repo_state(task, r["name"], with_pr=True)["pr"]
        print(f"{r['name']}: {r['pr']['url'] if r['pr'] else '(no PR)'}", flush=True)
        if r["pr"] and r["base"] == task.on:
            try:
                print(f"{r['name']}: {link_stack(task.root / r['name'], task.on, r['pr']['number'])}", flush=True)
            except MrError as error:
                print(f"{r['name']}: PR targets {task.on} but is not in a GitHub stack: {error}", flush=True)
    if args.dry_run:
        return
    prs = [r for r in changed if r["pr"]]
    if len(prs) > 1:
        for r in prs:
            others = [f"{o['name']}: {o['pr']['url']}" for o in prs if o is not r]
            cwd = task.root / r["name"]
            body = json.loads(run(["gh", "pr", "view", r["branch"], "--json", "body"], cwd=cwd))["body"]
            run(["gh", "pr", "edit", str(r["pr"]["number"]), "--body-file", "-"], cwd=cwd, stdin=with_related_section(body, others))
        print(f"cross-linked {len(prs)} PRs")


def stack_of(slug: str, number: int) -> dict | None:
    """The GitHub stack a PR is in (pull_requests listed bottom to top), or None."""
    stacks = json.loads(run(["gh", "api", f"repos/{slug}/stacks?pull_request={number}"]))
    return stacks[0] if stacks else None


def link_stack(cwd: Path, parent_branch: str, child: int) -> str:
    """Stacks a PR on the parent branch's PR on GitHub: on top of the parent's stack, or in a new stack
    of the two. Says what it did."""
    slug = github_slug(git(cwd, "remote", "get-url", "origin"))
    if not slug:
        raise MrError("not a GitHub repo")
    stack = stack_of(slug, child)
    if stack:
        return f"in stack #{stack['number']}"
    parent = json.loads(run(["gh", "pr", "view", parent_branch, "--json", "number"], cwd=cwd))["number"]
    stack = stack_of(slug, parent)
    if not stack:
        made = json.loads(run(["gh", "api", "-X", "POST", f"repos/{slug}/stacks", "--input", "-"],
                              stdin=json.dumps({"pull_requests": [parent, child]})))
        return f"stacked on #{parent} (new stack #{made['number']})"
    top = stack["pull_requests"][-1]["number"]
    if top != parent:
        raise MrError(f"#{parent} is not the top of stack #{stack['number']} (#{top} is); GitHub stacks are one line")
    run(["gh", "api", "-X", "POST", f"repos/{slug}/stacks/{stack['number']}/add", "--input", "-"],
        stdin=json.dumps({"pull_requests": [child]}))
    return f"stacked on #{parent} (stack #{stack['number']})"


# Files a task folder may hold besides its repos and markers without anyone having put work there.
TASK_JUNK = {".DS_Store", ".direnv", ".envrc"}


def stray_entries(task: Task) -> list[str]:
    """Files in a task folder that are neither its repos, mr's markers nor known junk: something the person
    (or a tool) put there, which rm would lose."""
    known = {TASK_FILE, *TASK_JUNK, *(r["name"] for r in task.project.repos)}
    return sorted(entry.name for entry in task.root.iterdir() if entry.name not in known)


def cmd_rm(args) -> None:
    task = current_task(args.task)
    states = [repo_state(task, name, with_pr=True) for name in task.repos]
    problems = [f"{s['name']}: {why}" for s in states if s["name"] not in task.borrowed and (why := is_unsafe_to_remove(s))]
    problems += [f"{name}: not part of any repo" for name in stray_entries(task)]
    if problems and not args.force:
        raise MrError("Not removing, it would lose work:\n  " + "\n  ".join(problems) + "\nCommit and push (or move stray files), or pass --force.")
    for s in states:
        repo = task.project.root / s["name"]
        if s["name"] in task.borrowed:
            print(f"{s['name']}: unlinked, its checkout stays at {(task.root / s['name']).resolve()}")
            continue
        git(repo, "worktree", "remove", *(["--force"] if args.force else []), str(task.root / s["name"]))
        # Squash merges leave the branch "unmerged" to git, so trust the PR's state instead.
        if s["pr"] and s["pr"]["state"] == "MERGED":
            git(repo, "branch", "-D", s["branch"], check=False)
            print(f"{s['name']}: removed worktree and merged branch")
        else:
            print(f"{s['name']}: removed worktree, kept branch {s['branch']}")
    for entry in task.root.iterdir():
        if entry.is_symlink():
            entry.unlink()
    (task.root / TASK_FILE).unlink()
    if args.force:
        shutil.rmtree(task.root)
    else:
        for name in TASK_JUNK:  # Finder's .DS_Store, direnv's cache and the .envrc link_project_env wrote
            junk = task.root / name
            shutil.rmtree(junk) if junk.is_dir() else junk.unlink(missing_ok=True)
        task.root.rmdir()  # fails loudly if something unexpected is still there
    print(f"removed {task.root}")


def github_repos(project: Project) -> list[tuple[str, str]]:
    """(repo name, owner/name) for the project's repos that live on GitHub."""
    return [(r["name"], slug) for r in project.repos if (slug := github_slug(r["url"]))]


def repo_prs(name: str, slug: str, now: datetime) -> tuple[str, list[dict] | None, str]:
    """(viewer login, watched PRs, why not) of one repo: PRs None and the reason for a repo GitHub refused."""
    result = subprocess.run(["gh", "api", "graphql", "-f", "query=" + prs_query(slug)], capture_output=True, text=True)
    try:
        data = json.loads(result.stdout or "{}").get("data") or {}
    except json.JSONDecodeError:  # an HTML error page from a proxy or GitHub itself
        data = {}
    if result.returncode != 0 or not data.get("repository"):
        lines = (result.stderr or result.stdout).strip().splitlines()
        reason = lines[0][:200] if lines else f"gh exited with {result.returncode}"
        print(f"mr: {slug} skipped: {reason}", file=sys.stderr)
        return (data.get("viewer") or {}).get("login", ""), None, reason
    viewer = data["viewer"]["login"]
    nodes = data["repository"]["open"]["nodes"] + data["repository"]["closed"]["nodes"]
    return viewer, [pr for node in nodes if is_worth_watching(pr := summarize_pr(node, name, slug, viewer), now)], ""


@dataclass
class PrScope:
    """What `mr prs` and `mr pr-view` look at: a project's GitHub repos, or one plain repo (--repo)."""
    name: str
    root: Path
    repos: list[tuple[str, str]]  # (repo name, owner/name)
    shorts: dict[str, str]
    project: Project | None

    def tasks(self) -> list[dict]:
        return task_summaries(self.project, with_status=False) if self.project else []

    def task_for(self, branch: str) -> str | None:
        """Where branch is checked out: the project's task, or for a plain repo any of its worktrees."""
        if self.project:
            return next((t["root"] for t in self.tasks() if branch in (t["branch"], *t["branches"].values())), None)
        return worktree_on_branch(git(self.root, "worktree", "list", "--porcelain"), branch)

    def topics(self) -> dict[tuple[str, str], str]:
        """(repo, branch) -> the task branch it belongs to, for repos on a branch of their own in a task
        (test/X-1 beside feat/X-1, or one named differently): their PRs group with the task's."""
        return {(name, branch): t["branch"] for t in self.tasks() for name, branch in t["branches"].items()}

    def branches_of(self, repo: str, branches: list[str]) -> list[str]:
        """The branches to look for in a repo: the given ones plus the repo's own branch in a task of theirs."""
        own = [branch for (name, branch), topic in self.topics().items() if name == repo and topic in branches]
        return list(dict.fromkeys([*branches, *own]))


def pr_scope(args) -> PrScope:
    if args.repo:
        root = Path(git(Path(args.repo).expanduser(), "rev-parse", "--show-toplevel"))
        slug = github_slug(git(root, "remote", "get-url", "origin", check=False))
        name = slug.split("/", 1)[1] if slug else root.name
        return PrScope(name=name, root=root, repos=[(name, slug)] if slug else [], shorts={name: name}, project=None)
    project = current_project(args.project)
    return PrScope(name=project.name, root=project.root, repos=github_repos(project),
                   shorts=short_names([r["name"] for r in project.repos]), project=project)


def cmd_prs(args) -> None:
    scope = pr_scope(args)
    header = {"project": scope.name, "root": str(scope.root), "isRepo": scope.project is None}
    if not scope.repos:
        if scope.project:
            raise MrError(f"{scope.name} has no GitHub repos.")
        print(json.dumps({**header, "viewer": "", "prs": [], "skipped": "not a GitHub repo"}))  # GitLab etc.: nothing to watch
        return
    now = datetime.now(timezone.utc)
    with ThreadPoolExecutor(max_workers=len(scope.repos)) as pool:
        results = list(pool.map(lambda repo: repo_prs(*repo, now), scope.repos))
    viewers = [viewer for viewer, _, _ in results if viewer]
    # Repos GitHub refused this time, with why: the watcher keeps what it last knew of them instead of
    # seeing their PRs vanish, and says why.
    failed = {slug: reason for (_, slug), (_, repo_list, reason) in zip(scope.repos, results) if repo_list is None}
    if not viewers:
        raise MrError(f"GitHub answered for none of the repos ({next(iter(failed.values()), 'no reason given')}); is gh logged in here?")
    topics = scope.topics()
    # The task folder of each task branch: its folder name can be an older branch's (a renamed task).
    task_roots = {branch: t["root"] for t in scope.tasks() for branch in (t["branch"], *t["branches"].values())}
    prs = [{**pr, "short": scope.shorts[pr["repo"]], "topic": topic, "task": task_roots.get(topic)}
           for _, repo_list, _ in results if repo_list for pr in repo_list
           for topic in [topics.get((pr["repo"], pr["branch"]), pr["branch"])]]
    print(json.dumps({**header, "viewer": viewers[0], "prs": prs, "failed": list(failed), "failedWhy": failed}))


def graphql(query: str, **variables: str | int) -> dict:
    args = ["gh", "api", "graphql", "-f", f"query={query}"]
    for key, value in variables.items():
        args += ["-F" if isinstance(value, int) else "-f", f"{key}={value}"]
    return json.loads(run(args))["data"]


def full_pr(name: str, slug: str, branch: str) -> tuple[str, dict | None]:
    """(viewer login, the branch's latest PR in the repo or None)."""
    owner, repo = slug.split("/", 1)
    data = graphql(PR_DETAIL_QUERY, owner=owner, name=repo, branch=branch)
    nodes = data["repository"]["pullRequests"]["nodes"]
    if not nodes:
        return data["viewer"]["login"], None
    files = nodes[0]["files"]
    while files["pageInfo"]["hasNextPage"]:
        page = graphql(PR_FILES_QUERY, owner=owner, name=repo, number=nodes[0]["number"], after=files["pageInfo"]["endCursor"])
        page = page["repository"]["pullRequest"]["files"]
        files = {"pageInfo": page["pageInfo"], "nodes": files["nodes"] + page["nodes"]}
    return data["viewer"]["login"], detail_pr(nodes[0] | {"files": files}, name, slug)


def cmd_pr_view(args) -> None:
    scope = pr_scope(args)
    with ThreadPoolExecutor(max_workers=len(scope.repos) or 1) as pool:
        found = list(pool.map(lambda job: full_pr(*job[0], job[1]),
                              [(repo, branch) for repo in scope.repos for branch in scope.branches_of(repo[0], args.branch)]))
    viewer = found[0][0] if found else ""  # whose review is requested, for the view
    prs = [pr for _, pr in found if pr]
    for pr in prs:
        pr["short"] = scope.shorts[pr["repo"]]
    print(json.dumps({"project": scope.name, "branch": args.branch[0], "isRepo": scope.project is None,
                      "task": scope.task_for(args.branch[0]), "viewer": viewer, "prs": prs}))


def cmd_pr_diff(args) -> None:
    print(run(["gh", "pr", "diff", str(args.number), "-R", args.slug]))


def cmd_commit_diff(args) -> None:
    print(run(["gh", "api", f"repos/{args.slug}/commits/{args.oid}", "-H", "Accept: application/vnd.github.diff"]))


# GitHub merges a stack in the background; polled for at most about 20 s, inside the prs mod's 30 s
# limit on one mr call. A merge still running then finishes on its own.
STACK_MERGE_POLLS = 10
STACK_MERGE_POLL_SECONDS = 2


def merge_stack(slug: str, number: int) -> str:
    """Merges a stacked PR and every open PR below it, with merge commits, through the async merge
    endpoint GitHub documents for stacks."""
    endpoint = f"repos/{slug}/pulls/{number}/merge-async"
    result = json.loads(run(["gh", "api", "-X", "PUT", endpoint, "-f", "merge_method=merge", "-f", "merge_action=default"]))
    uuid = result["details"].get("uuid")
    for _ in range(STACK_MERGE_POLLS):
        if result["status"] != "pending" or not uuid:
            break
        time.sleep(STACK_MERGE_POLL_SECONDS)
        result = json.loads(run(["gh", "api", f"{endpoint}/{uuid}"]))
    if result["status"] == "failed":
        raise MrError(f"merge failed: {result['details'].get('message') or 'GitHub gave no reason'}")
    return {"merged": "merge-stack: done", "enqueued": "merge-stack: in the merge queue"}.get(
        result["status"], "merge-stack: still merging on GitHub")


RESTACK_QUERY = """query($owner: String!, $name: String!, $branch: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(headRefName: $branch, first: 1, orderBy: {field: CREATED_AT, direction: DESC}) { nodes {
      stack { baseRefName entries(first: 100) { nodes { position pullRequest { state headRefName headRefOid } } } } } }
  }
}"""


def restack_plan(base: str, entries: list[dict]) -> list[dict]:
    """The open layers of a stack, bottom up: [{branch, onto, after}]. A layer's own commits are the ones
    after `after` (the tip of the layer below as GitHub last saw it; None for the bottom one), and go
    onto `onto`: the open layer below, or the stack's base once everything below has merged."""
    layers = []
    below = None
    for entry in sorted(entries, key=lambda e: e["position"]):
        pr = entry["pullRequest"]
        if pr["state"] == "OPEN":
            layers.append({"branch": pr["headRefName"], "onto": layers[-1]["branch"] if layers else base,
                           "after": below["headRefOid"] if below else None})
        below = pr
    return layers


def is_ancestor(repo: Path, older: str, newer: str) -> bool:
    return subprocess.run(["git", "-C", str(repo), "merge-base", "--is-ancestor", older, newer]).returncode == 0


def restack_repo(repo: Path, slug: str, branch: str) -> str:
    """Restacks the branch's GitHub stack in this repo; "no stack" when its PR is in none."""
    owner, name = slug.split("/", 1)
    nodes = graphql(RESTACK_QUERY, owner=owner, name=name, branch=branch)["repository"]["pullRequests"]["nodes"]
    stack = nodes[0]["stack"] if nodes else None
    if not stack:
        return "no stack"
    return restack_layers(repo, restack_plan(stack["baseRefName"], stack["entries"]["nodes"]))


def own_commits_start(repo: Path, layer: dict, onto: str, tip: str) -> str:
    """The commit a layer's own commits come after. GitHub's last tip of the layer below, unless that
    layer was rewritten since this one was made on it; then where git's reflog saw this layer fork
    from it, and failing that the newest commit they share."""
    if layer["after"] and is_ancestor(repo, layer["after"], tip):
        return layer["after"]
    return git(repo, "merge-base", "--fork-point", onto, tip, check=False) or git(repo, "merge-base", onto, tip)


def restack_layers(repo: Path, layers: list[dict]) -> str:
    """Rebases each layer (restack_plan) onto the one below in a scratch worktree, then force-pushes the
    moved branches in one atomic push, with leases so a push someone made meanwhile is never lost, and
    moves local copies that had nothing of their own. Changes nothing when any layer conflicts."""
    git(repo, "fetch", "--quiet", "--prune", "origin")
    worktrees = git(repo, "worktree", "list", "--porcelain")
    old = {}
    for layer in layers:
        b = layer["branch"]
        if not has_ref(repo, f"refs/remotes/origin/{b}"):
            raise MrError(f"{b} is not on origin")
        old[b] = git(repo, "rev-parse", f"origin/{b}")
        if has_ref(repo, f"refs/heads/{b}") and not is_ancestor(repo, f"refs/heads/{b}", old[b]):
            raise MrError(f"local {b} has commits that are not on GitHub; push them first")
        checkout = worktree_on_branch(worktrees, b)
        if checkout and git(Path(checkout), "status", "--porcelain", "--untracked-files=no"):
            raise MrError(f"{b} has uncommitted changes in {checkout}")
    new = {}
    scratch = Path(tempfile.mkdtemp(prefix="mr-restack-"))
    try:
        git(repo, "worktree", "add", "--quiet", "--detach", str(scratch), "HEAD")
        for layer in layers:
            b, onto = layer["branch"], new.get(layer["onto"]) or f"origin/{layer['onto']}"
            after = own_commits_start(repo, layer, onto, old[b])
            git(scratch, "checkout", "--quiet", "--detach", old[b])
            rebase = subprocess.run(["git", "-C", str(scratch), "rebase", "--quiet", "--onto", onto, after], capture_output=True, text=True)
            if rebase.returncode != 0:
                files = git(scratch, "diff", "--name-only", "--diff-filter=U", check=False).split()
                git(scratch, "rebase", "--abort", check=False)
                if not files:
                    raise MrError(f"rebasing {b} failed: {(rebase.stderr or rebase.stdout).strip()}")
                raise MrError(f"{b} conflicts with {layer['onto']} in {', '.join(files)}; rebase it by hand "
                              f"(git rebase --onto origin/{layer['onto']} {after[:10]} {b}), push, then restack again")
            new[b] = git(scratch, "rev-parse", "HEAD")
    finally:
        git(repo, "worktree", "remove", "--force", str(scratch), check=False)
        shutil.rmtree(scratch, ignore_errors=True)
    moved = [layer["branch"] for layer in layers if new[layer["branch"]] != old[layer["branch"]]]
    if not moved:
        return "up to date"
    git(repo, "push", "--quiet", "--atomic", "origin", *[f"--force-with-lease={b}:{old[b]}" for b in moved],
        *[f"{new[b]}:refs/heads/{b}" for b in moved])
    for b in moved:
        checkout = worktree_on_branch(worktrees, b)
        if checkout:
            git(Path(checkout), "reset", "--quiet", "--keep", new[b])
        elif has_ref(repo, f"refs/heads/{b}"):
            git(repo, "branch", "--quiet", "--force", b, new[b])
    return f"restacked {', '.join(moved)}"


def cmd_restack(args) -> None:
    branch = args.branch or current_task(None).branch
    scope = pr_scope(args)
    repo_of = lambda name: scope.root if scope.project is None else scope.root / name  # noqa: E731

    def one(repo: tuple[str, str]) -> tuple[str, str, bool]:
        name, slug = repo
        try:
            return name, restack_repo(repo_of(name), slug, branch), True
        except MrError as error:
            return name, str(error), False

    with ThreadPoolExecutor(max_workers=len(scope.repos) or 1) as pool:
        results = [r for r in pool.map(one, scope.repos) if r[1] != "no stack"]
    if not results:
        raise MrError(f"{branch} has no PR in a GitHub stack.")
    lines = [f"{scope.shorts.get(name, name)}: {text}" for name, text, _ in results]
    if not all(ok for _, _, ok in results):
        raise MrError("\n".join(lines))
    print("\n".join(lines))


def cmd_pr_act(args) -> None:
    if args.action == "merge-stack":
        print(merge_stack(args.slug, args.number))
        return
    if args.action in ("request-changes", "comment") and not (args.body or "").strip():
        raise MrError(f"{args.action} needs a --body.")
    body = ["--body", args.body] if args.body and args.action in ("approve", "request-changes", "comment") else []
    print(run(["gh", "pr", *PR_ACTIONS[args.action], str(args.number), "-R", args.slug, *body]) or f"{args.action}: done")


def posted_comment(response: dict) -> dict:
    """GitHub's answer to a new review comment, as one of detail_pr's inlineComments."""
    return {"author": _login(response.get("user")), "body": response["body"], "createdAt": response["created_at"],
            "url": response["html_url"], "path": response["path"], "line": response["line"] or response.get("original_line"),
            "side": response.get("side") or "RIGHT", "startLine": response.get("start_line"), "startSide": response.get("start_side"),
            "isOutdated": False, "isReply": False}


def cmd_pr_comment(args) -> None:
    """One review comment on a PR's lines, posted at once: --request is the REST body (the prs mod builds it).
    Prints the comment as pr-view lists inline comments."""
    try:
        request = json.loads(args.request)
    except json.JSONDecodeError as error:
        raise MrError(f"--request is not valid JSON: {error}") from None
    if not isinstance(request, dict) or not str(request.get("body", "")).strip():
        raise MrError("--request needs a JSON object with a body.")
    answer = run(["gh", "api", "-X", "POST", f"repos/{args.slug}/pulls/{args.number}/comments", "--input", "-"], stdin=json.dumps(request))
    print(json.dumps(posted_comment(json.loads(answer))))


def cmd_pr_candidates(args) -> None:
    logins = run(["gh", "api", "--paginate", f"repos/{args.slug}/assignees", "--jq", ".[].login"]).split()
    print(json.dumps(sorted(logins, key=str.lower)))


def cmd_pr_reviewers(args) -> None:
    if not (args.add or args.remove):
        raise MrError("pr-reviewers needs --add or --remove.")
    # The REST endpoint rather than `gh pr edit --add-reviewer`, which also reads the PR's projects and
    # fails on repos whose classic projects are gone.
    endpoint = f"repos/{args.slug}/pulls/{args.number}/requested_reviewers"
    for method, logins in (("POST", args.add), ("DELETE", args.remove)):
        if logins:
            run(["gh", "api", "-X", method, endpoint, *[arg for login in logins for arg in ("-f", f"reviewers[]={login}")]])
    print("reviewers: done")


def parser() -> argparse.ArgumentParser:
    top = argparse.ArgumentParser(prog="mr", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    top.add_argument("--version", action="version", version=VERSION)
    top.add_argument("--in", dest="within", metavar="DIR",
                     help="run gh with DIR's direnv environment (for commands that name only a repo slug)")
    sub = top.add_subparsers(dest="command", required=True)

    def command(name, handler, help_text):
        p = sub.add_parser(name, help=help_text)
        p.set_defaults(handler=handler)
        return p

    p = command("init", cmd_init, "record the repos under a folder as a project")
    p.add_argument("root", nargs="?")
    p.add_argument("--name")
    p = command("clone", cmd_clone, "clone a project from a manifest")
    p.add_argument("manifest", help="path to a .mr.json, - for stdin, or the JSON itself")
    p.add_argument("root")
    p = command("projects", cmd_projects, "list known projects")
    p.add_argument("--json", action="store_true")
    p = command("manifest", cmd_manifest, "print this project's manifest")
    p.add_argument("--project")
    p = command("new", cmd_new, "create a task workspace")
    p.add_argument("branch")
    p.add_argument("repos", nargs="+", help="repo names; repo=branch for one whose branch is named differently")
    p.add_argument("--project")
    p.add_argument("--on", metavar="PARENT", help="stack on another task's branch")
    p = command("add", cmd_add, "check out more repos in this task")
    p.add_argument("repos", nargs="+", help="repo names; repo=branch for one whose branch is named differently")
    p.add_argument("--branch", help="the repo's own branch (default: the task's, else its one for the same ticket)")
    p.add_argument("--task")
    p = command("ls", cmd_ls, "list a project's tasks")
    p.add_argument("--project")
    p.add_argument("--json", action="store_true")
    p = command("status", cmd_status, "per-repo state of a task")
    p.add_argument("--task")
    p.add_argument("--json", action="store_true")
    p.add_argument("--no-pr", action="store_true")
    p = command("push", cmd_push, "push repos with unpushed commits")
    p.add_argument("--task")
    p = command("pull", cmd_pull, "fast-forward every repo of this task")
    p.add_argument("--task")
    p = command("pr", cmd_pr, "open missing PRs and cross-link them")
    p.add_argument("--task")
    p.add_argument("--title")
    p.add_argument("--body")
    p.add_argument("--draft", action="store_true")
    p.add_argument("--dry-run", action="store_true")
    p = command("rm", cmd_rm, "remove a task workspace")
    p.add_argument("--task")
    p.add_argument("--force", action="store_true")
    p = command("prs", cmd_prs, "open and recently closed PRs of every repo, as JSON")
    scope = p.add_mutually_exclusive_group()
    scope.add_argument("--project")
    scope.add_argument("--repo", help="one plain git repo (any of its worktrees) instead of a project")
    p = command("pr-view", cmd_pr_view, "a branch's PR in every repo, in full, as JSON")
    p.add_argument("branch", nargs="+", help="one or more branches of one topic (feat/X test/X); the first is the main one")
    scope = p.add_mutually_exclusive_group()
    scope.add_argument("--project")
    scope.add_argument("--repo", help="one plain git repo (any of its worktrees) instead of a project")
    p = command("pr-diff", cmd_pr_diff, "one PR's diff")
    p.add_argument("slug", help="owner/repo")
    p.add_argument("number", type=int)
    p = command("commit-diff", cmd_commit_diff, "one commit's diff")
    p.add_argument("slug", help="owner/repo")
    p.add_argument("oid", help="the commit's sha")
    p = command("restack", cmd_restack, "rebase a branch's GitHub stacks layer by layer and force-push them")
    p.add_argument("branch", nargs="?", help="any branch of the stack (default: this task's)")
    scope = p.add_mutually_exclusive_group()
    scope.add_argument("--project")
    scope.add_argument("--repo", help="one plain git repo instead of a project")
    p = command("pr-act", cmd_pr_act, "review, comment on, merge or (un)draft one PR")
    p.add_argument("slug", help="owner/repo")
    p.add_argument("number", type=int)
    p.add_argument("action", choices=sorted([*PR_ACTIONS, "merge-stack"]))
    p.add_argument("--body")
    p = command("pr-comment", cmd_pr_comment, "post one review comment on a PR's lines")
    p.add_argument("slug", help="owner/repo")
    p.add_argument("number", type=int)
    p.add_argument("--request", required=True, help="the JSON body of POST /repos/{slug}/pulls/{number}/comments")
    p = command("pr-candidates", cmd_pr_candidates, "who can be asked to review in a repo")
    p.add_argument("slug", help="owner/repo")
    p = command("pr-reviewers", cmd_pr_reviewers, "request or withdraw review requests on one PR")
    p.add_argument("slug", help="owner/repo")
    p.add_argument("number", type=int)
    logins = lambda text: [login for login in text.split(",") if login]  # noqa: E731
    p.add_argument("--add", type=logins, default=[], help="logins, comma-separated")
    p.add_argument("--remove", type=logins, default=[], help="logins, comma-separated")
    return top


def gh_folder(args) -> Path | None:
    """The folder whose direnv environment gh runs in: --in, the plain repo, else the project (a task's
    folder sits under ~/.herdr, outside the project's .envrc). None for commands that name none."""
    if args.within:
        return Path(args.within).expanduser()
    if getattr(args, "repo", None):
        return Path(args.repo).expanduser()
    if not (hasattr(args, "project") or hasattr(args, "task")):
        return None
    try:
        return current_project(getattr(args, "task", None) or getattr(args, "project", None)).root
    except MrError:
        return None  # the command itself says what is missing


def direnv_changes(folder: Path) -> dict[str, str | None]:
    """What direnv sets for a shell in folder (a GH_TOKEN for the account its repos belong to, say).

    mr runs from Herdr, not from a shell in the folder, so without this gh acts as the machine's
    active account and can't see another account's private repos. {} without direnv or an .envrc."""
    if not folder.is_dir() or not shutil.which("direnv"):
        return {}
    result = subprocess.run(["direnv", "export", "json"], cwd=folder, capture_output=True, text=True)
    if result.returncode != 0:  # a blocked .envrc: say so, and go on as the active account
        print(f"mr: direnv in {folder}: {result.stderr.strip()}", file=sys.stderr)
        return {}
    return json.loads(result.stdout) if result.stdout.strip() else {}


def apply_env(changes: dict[str, str | None]) -> None:
    for name, value in changes.items():
        if value is None:
            os.environ.pop(name, None)
        else:
            os.environ[name] = value


def main(argv: list[str]) -> int:
    args = parser().parse_args(argv)
    try:
        folder = gh_folder(args)
        if folder:
            apply_env(direnv_changes(folder))
        args.handler(args)
    except MrError as error:
        print(f"mr: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
