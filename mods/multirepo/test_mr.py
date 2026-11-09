"""Self-check for mr.py: python3 -I test_mr.py (no GitHub; local bare repos stand in for origin)."""

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import mr  # noqa: E402

# Pure helpers.
assert mr.branch_slug("feat/SHOP-130-x") == "feat-SHOP-130-x"
assert mr.title_from_branch("feat/SHOP-130-checkout-flow") == "feat(SHOP-130): checkout flow"
assert mr.title_from_branch("fix/typo-in-readme") == "fix: typo in readme"
assert mr.match_repos(["backend", "acme-shop-portal"], ["acme-shop-backend", "acme-shop-portal"]) == [
    "acme-shop-backend", "acme-shop-portal"]
for bad in (["shop"], ["nope"]):
    try:
        mr.match_repos(bad, ["acme-shop-backend", "acme-shop-portal"])
        raise AssertionError(f"{bad} should not resolve")
    except mr.MrError:
        pass
body = mr.with_related_section("Fixes the thing.", ["portal: https://x/2"])
assert body.startswith("Fixes the thing.\n\n" + mr.RELATED_START) and "- portal: https://x/2" in body
again = mr.with_related_section(body, ["portal: https://x/2", "app: https://x/3"])
assert again.count(mr.RELATED_START) == 1 and "- app: https://x/3" in again and again.startswith("Fixes the thing.")
assert mr.is_unsafe_to_remove({"dirty": 0, "unpushed": 2}) == "2 commit(s) not pushed"

# gh runs in the project's direnv environment: --in wins, then --repo; a slug-only command has none.
assert mr.gh_folder(mr.parser().parse_args(["--in", "/x/Proj", "pr-diff", "acme/api", "3"])) == Path("/x/Proj")
assert mr.gh_folder(mr.parser().parse_args(["prs", "--repo", "/x/repo"])) == Path("/x/repo")
assert mr.gh_folder(mr.parser().parse_args(["pr-diff", "acme/api", "3"])) is None
os.environ["MR_TEST_GONE"] = "1"
mr.apply_env({"MR_TEST_SET": "a", "MR_TEST_GONE": None})
assert os.environ["MR_TEST_SET"] == "a" and "MR_TEST_GONE" not in os.environ

# Branches for one ticket: test/X-1 beside feat/X-1, never X-10 or another ticket.
assert mr.ticket_key("feat/SHOP-110-cart-page") == "SHOP-110" and mr.ticket_key("main") is None
assert mr.ticket_key("feat/T-1b") is None, "a letter after the number makes it another name"
refs = ["refs/heads/main", "refs/remotes/origin/HEAD", "refs/remotes/origin/test/SHOP-110-e2e", "refs/heads/test/SHOP-110-e2e",
        "refs/remotes/origin/feat/SHOP-1100-x", "refs/heads/feat/SHOP-110-cart-page"]
assert mr.same_ticket_branches("feat/SHOP-110-cart-page", refs) == ["test/SHOP-110-e2e"]
assert mr.same_ticket_branches("main", refs) == []

# A repo GitHub refuses comes back with gh's reason, even when gh printed no JSON.
real_run = subprocess.run
subprocess.run = lambda *a, **k: subprocess.CompletedProcess(a, 1, "<html>502</html>", "HTTP 502: Bad Gateway\nmore")
try:
    assert mr.repo_prs("api", "acme/api", None) == ("", None, "HTTP 502: Bad Gateway")
finally:
    subprocess.run = real_run
assert mr.is_unsafe_to_remove({"dirty": 0, "unpushed": 0}) == ""
assert mr.short_names(["acme-shop-backend", "acme-shop-portal", "helper-scripts-shop"])["helper-scripts-shop"] == "helper-scripts-shop"
assert mr.short_names(["acme-shop-backend", "acme-shop-mobile-app"]) == {
    "acme-shop-backend": "backend", "acme-shop-mobile-app": "mobile-app"}
assert mr.short_names(["solo-repo"]) == {"solo-repo": "solo-repo"}
porcelain = "worktree /p/backend\nHEAD a\nbranch refs/heads/develop\n\nworktree /t3/wt\nHEAD b\nbranch refs/heads/feat/x\n\nworktree /d\nHEAD c\ndetached\n"
assert mr.worktree_on_branch(porcelain, "feat/x") == "/t3/wt"
assert mr.worktree_on_branch(porcelain, "feat/y") is None
gone = "worktree /t3/old\nHEAD abc\nbranch refs/heads/feat/z\nprunable gitdir file points to non-existent location\n"
assert mr.worktree_on_branch(gone, "feat/z") is None, "a worktree whose folder is gone holds nothing to link"
assert mr.github_slug("git@github.com:acme-inc/acme-shop-backend.git") == "acme-inc/acme-shop-backend"
assert mr.github_slug("https://github.com/o/r") == "o/r"
assert mr.github_slug("git@gitlab.com:o/r.git") is None
assert mr.github_slug("ssh://git@github.com:22/o/r.git") == "o/r"
real_hostname = mr.ssh_hostname
mr.ssh_hostname = lambda host: {"github": "github.com", "github-work": "github.com"}.get(host, host)
assert mr.github_slug("git@github:o/r.git") == "o/r", "an ssh alias for github.com is GitHub"
assert mr.github_slug("github-work:o/r") == "o/r"
assert mr.github_slug("git@gitlab:o/r.git") is None
mr.ssh_hostname = real_hostname
assert mr.check_counts([{"state": "SUCCESS", "count": 3}, {"state": "FAILURE", "count": 1}, {"state": "IN_PROGRESS", "count": 2},
                        {"state": "SKIPPED", "count": 1}]) == {"passed": 4, "failed": 1, "pending": 2}
node = {
    "number": 107, "title": "T", "url": "u", "headRefName": "feat/x", "baseRefName": "develop", "isDraft": False, "state": "OPEN",
    "updatedAt": "2026-11-01T00:00:00Z", "additions": 5, "deletions": 1, "reviewDecision": "REVIEW_REQUIRED", "author": None,
    "comments": {"totalCount": 2}, "reviewThreads": {"nodes": [{"comments": {"totalCount": 2}}, {"comments": {"totalCount": 1}}]},
    "reviewRequests": {"nodes": [{"requestedReviewer": {"name": "team"}}, {"requestedReviewer": {"login": "me"}}]},
    "latestReviews": {"nodes": [{"author": {"login": "bob"}, "state": "APPROVED"}]},
    "commits": {"nodes": [{"commit": {"statusCheckRollup": {"state": "PENDING", "contexts": {
        "checkRunCountsByState": [{"state": "SUCCESS", "count": 1}], "statusContextCountsByState": [{"state": "PENDING", "count": 1}]}}}}]},
}
pr = mr.summarize_pr(node, "backend", "o/backend", "me")
assert pr["author"] == "ghost" and pr["isReviewRequestedFromMe"] and pr["inlineComments"] == 3 and pr["comments"] == 2
assert pr["checks"] == "PENDING" and pr["checkCounts"] == {"passed": 1, "failed": 0, "pending": 1}
assert mr.summarize_pr({**node, "commits": {"nodes": []}}, "b", "o/b", "x")["checks"] is None
assert pr["stack"] is None
stacked = mr.summarize_pr({**node, "stack": {"number": 9, "size": 3}, "stackEntry": {"position": 2}}, "b", "o/b", "x")
assert stacked["stack"] == {"number": 9, "size": 3, "position": 2}
now = mr.datetime(2026, 11, 7, tzinfo=mr.timezone.utc)
assert mr.is_worth_watching(pr, now)
assert mr.is_worth_watching({**pr, "state": "MERGED", "updatedAt": "2026-11-05T00:00:00Z"}, now)
assert not mr.is_worth_watching({**pr, "state": "CLOSED", "updatedAt": "2026-11-01T00:00:00Z"}, now)
assert 'repository(owner: "o", name: "b")' in mr.prs_query("o/b")
assert "open: pullRequests(first: 50, states: [OPEN]" in mr.prs_query("o/b") and "closed: pullRequests(first: 10, states: [MERGED, CLOSED]" in mr.prs_query("o/b")
detail_node = {key: None for key in mr.PR_SCALARS} | {
    "number": 7, "author": None,
    "reviewRequests": {"nodes": [{"requestedReviewer": {"__typename": "User", "login": "bob"}}, {"requestedReviewer": None}]},
    "latestReviews": {"nodes": []},
    "reviews": {"nodes": [{"id": "r1", "author": {"login": "a"}, "state": "APPROVED", "body": "", "submittedAt": "t"}]},
    "comments": {"nodes": [{"author": {"login": "a"}, "body": "hi", "createdAt": "t", "url": "u"}]},
    "reviewThreads": {"nodes": [{"comments": {"nodes": [
        {"author": {"login": "a"}, "body": "b", "createdAt": "t", "url": "u", "path": "p", "line": None, "originalLine": 4},
        {"author": None, "body": "c", "createdAt": "t2", "url": "u2", "path": "p", "line": 5, "originalLine": 5}]}}]},
    "commits": {"nodes": [{"commit": {"oid": "abc", "messageHeadline": "h", "messageBody": "", "committedDate": "t", "authoredDate": "t",
                                      "authors": {"nodes": [{"name": "A", "email": "e", "user": None}]}}}]},
    "lastCommit": {"nodes": [{"commit": {"statusCheckRollup": {"contexts": {"nodes": [
        {"__typename": "CheckRun", "name": "test", "status": "COMPLETED", "conclusion": "SUCCESS", "startedAt": "s", "completedAt": "c",
         "detailsUrl": "d", "checkSuite": {"workflowRun": {"workflow": {"name": "CI"}}}},
        {"__typename": "StatusContext", "context": "deploy", "state": "PENDING", "targetUrl": "t", "createdAt": "s"}]}}}}]},
    "files": {"nodes": [{"path": "a.py", "additions": 1, "deletions": 0, "changeType": "MODIFIED"}]},
}
detail_node["stackEntry"] = {"position": 2}
detail_node["stack"] = {"number": 4, "size": 2, "baseRefName": "develop", "entries": {"nodes": [
    {"position": 1, "pullRequest": {"number": 6, "title": "A", "state": "MERGED", "isDraft": False, "headRefName": "feat/a", "url": "u6", "viewerCanUpdateBranch": False}},
    {"position": 2, "pullRequest": {"number": 7, "title": "B", "state": "OPEN", "isDraft": False, "headRefName": "feat/b", "url": "u7", "viewerCanUpdateBranch": True}}]}}
detail = mr.detail_pr(detail_node, "api", "o/api")
assert detail["stack"]["base"] == "develop" and detail["stack"]["position"] == 2 and detail["stack"]["entries"][1]["isBehind"]
assert detail["stack"]["entries"][0] == {"position": 1, "number": 6, "title": "A", "state": "MERGED", "isDraft": False, "headRefName": "feat/a", "url": "u6", "isBehind": False}
assert detail["author"] == {"login": "ghost"} and detail["repo"] == "api" and detail["slug"] == "o/api"
assert detail["reviewRequests"] == [{"__typename": "User", "login": "bob"}]
assert detail["inlineComments"] == [
    {"author": "a", "body": "b", "createdAt": "t", "url": "u", "path": "p", "line": 4, "isReply": False},
    {"author": "ghost", "body": "c", "createdAt": "t2", "url": "u2", "path": "p", "line": 5, "isReply": True}]
assert detail["commits"][0]["authors"] == [{"name": "A", "email": "e", "login": ""}]
assert [c.get("workflowName", c.get("context")) for c in detail["statusCheckRollup"]] == ["CI", "deploy"]
assert detail["comments"][0]["author"] == {"login": "a"}

# Restack plan: merged layers drop out; the first open one goes onto the base, after the merged tip.
layer = lambda position, state, head, oid: {"position": position, "pullRequest": {"state": state, "headRefName": head, "headRefOid": oid}}  # noqa: E731
assert mr.restack_plan("develop", [layer(3, "OPEN", "c", "3"), layer(1, "MERGED", "a", "1"), layer(2, "OPEN", "b", "2")]) == [
    {"branch": "b", "onto": "develop", "after": "1"}, {"branch": "c", "onto": "b", "after": "2"}]
assert mr.restack_plan("develop", [layer(1, "OPEN", "a", "1")]) == [{"branch": "a", "onto": "develop", "after": None}]

# A task outside its project's folder loads the project's direnv .envrc (the nearest above it) through its own.
with tempfile.TemporaryDirectory() as tmp:
    tmp = Path(tmp)
    (tmp / "work" / "shop").mkdir(parents=True)
    (tmp / "work" / ".envrc").write_text("export CLAUDE_CONFIG_DIR=x\n")
    (tmp / "task").mkdir()
    real_which, real_run, allowed = mr.shutil.which, subprocess.run, []
    mr.shutil.which = lambda name: "/bin/direnv"
    subprocess.run = lambda args, **k: allowed.append(args) or subprocess.CompletedProcess(args, 0, "", "")
    mr.link_project_env(tmp / "task", tmp / "work" / "shop")
    assert f"source_env {tmp / 'work' / '.envrc'}" in (tmp / "task" / ".envrc").read_text()
    assert allowed == [["direnv", "allow", str(tmp / "task" / ".envrc")]]
    mr.link_project_env(tmp / "task", tmp / "work" / "shop")
    assert len(allowed) == 1, "a task's own .envrc is left alone"
    (tmp / "plain").mkdir()
    mr.link_project_env(tmp / "plain", Path("/"))
    assert not (tmp / "plain" / ".envrc").exists(), "no project .envrc, none written"
    mr.shutil.which, subprocess.run = real_which, real_run

# End to end with a fake HOME so the registry and workspaces stay in the temp folder.
with tempfile.TemporaryDirectory() as tmp:
    tmp = Path(tmp).resolve()
    env = {**os.environ, "HOME": str(tmp), "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t"}

    def sh(*args, cwd=None, check=True):
        result = subprocess.run(args, cwd=cwd, env=env, capture_output=True, text=True)
        assert not check or result.returncode == 0, f"{args}: {result.stderr}"
        return result

    def mrcmd(*args, cwd=None, check=True):
        return sh(sys.executable, "-I", str(HERE / "mr.py"), *args, cwd=cwd, check=check)

    project = tmp / "Proj"
    for name, base in (("proj-backend", "develop"), ("proj-portal", "develop"), ("helper", "main")):
        seed = tmp / "seed" / name
        sh("git", "init", "-q", "-b", base, str(seed))
        (seed / "README").write_text(name)
        sh("git", "-C", str(seed), "add", ".")
        sh("git", "-C", str(seed), "commit", "-qm", "init")
        sh("git", "clone", "-q", "--bare", str(seed), str(tmp / "origin" / f"{name}.git"))
        sh("git", "clone", "-q", str(tmp / "origin" / f"{name}.git"), str(project / name))

    mrcmd("init", str(project))
    manifest = json.loads((project / ".mr.json").read_text())
    assert {r["name"]: r["base"] for r in manifest["repos"]} == {"proj-backend": "develop", "proj-portal": "develop", "helper": "main"}

    out = mrcmd("new", "feat/T-1-thing", "backend", cwd=project).stdout
    task = tmp / ".herdr" / "projects" / "Proj" / "feat-T-1-thing"
    assert str(task) in out
    assert (task / "proj-portal").is_symlink() and (task / "helper").is_symlink()
    assert sh("git", "-C", str(task / "proj-backend"), "branch", "--show-current").stdout.strip() == "feat/T-1-thing"

    (task / "proj-backend" / "new.txt").write_text("x")
    status = json.loads(mrcmd("status", "--json", "--no-pr", cwd=task / "proj-backend").stdout)
    assert status["repos"][0]["dirty"] == 1
    refused = mrcmd("rm", cwd=task, check=False)
    assert refused.returncode == 1 and "uncommitted" in refused.stderr

    sh("git", "-C", str(task / "proj-backend"), "add", ".")
    sh("git", "-C", str(task / "proj-backend"), "commit", "-qm", "feat: thing")
    status = json.loads(mrcmd("status", "--json", "--no-pr", cwd=task).stdout)["repos"][0]
    assert (status["ahead"], status["unpushed"]) == (1, 1)
    mrcmd("push", cwd=task)
    assert json.loads(mrcmd("status", "--json", "--no-pr", cwd=task).stdout)["repos"][0]["unpushed"] == 0

    # A task stacked on that one: backend builds on its branch, portal (never on it) on develop.
    child = tmp / ".herdr" / "projects" / "Proj" / "feat-T-1b"
    mrcmd("new", "feat/T-1b", "backend", "portal", "--on", "feat/T-1-thing", cwd=project)
    assert json.loads((child / ".mr-task.json").read_text())["on"] == "feat/T-1-thing"
    bases = {r["name"]: (r["base"], r["ahead"]) for r in json.loads(mrcmd("status", "--json", "--no-pr", cwd=child).stdout)["repos"]}
    assert bases == {"proj-backend": ("feat/T-1-thing", 0), "proj-portal": ("develop", 0)}, bases
    assert (child / "proj-backend" / "new.txt").exists()
    mrcmd("rm", cwd=child)
    nowhere = mrcmd("new", "feat/T-1c", "portal", "--on", "feat/T-1-thing", cwd=project, check=False)
    assert nowhere.returncode == 1 and "to stack on" in nowhere.stderr and not (child.parent / "feat-T-1c").exists()

    mrcmd("add", "portal", cwd=task)
    assert not (task / "proj-portal").is_symlink()
    listed = json.loads(mrcmd("ls", "--json", "--project", str(project)).stdout)
    assert listed["tasks"][0]["repos"] == ["proj-backend", "proj-portal"]
    assert listed["shorts"] == {"helper": "helper", "proj-backend": "backend", "proj-portal": "portal"}

    # A repo without the task's branch takes its one branch for the same ticket (test/ beside feat/).
    sh("git", "-C", str(project / "helper"), "push", "-q", "origin", "main:test/T-1-e2e")
    mrcmd("add", "helper", cwd=task)
    assert sh("git", "-C", str(task / "helper"), "branch", "--show-current").stdout.strip() == "test/T-1-e2e"
    saved = json.loads((task / ".mr-task.json").read_text())
    assert saved.get("branches") == {"helper": "test/T-1-e2e"}, saved
    own = {r["name"]: r["branch"] for r in json.loads(mrcmd("status", "--json", "--no-pr", cwd=task).stdout)["repos"]}
    assert own == {"proj-backend": "feat/T-1-thing", "proj-portal": "feat/T-1-thing", "helper": "test/T-1-e2e"}, own

    # Cloning the project elsewhere from its manifest (the "new remote" path).
    clone_root = tmp / "elsewhere" / "Proj"
    mrcmd("clone", str(project / ".mr.json"), str(clone_root))
    assert sorted(p.name for p in clone_root.iterdir()) == [".mr.json", "helper", "proj-backend", "proj-portal"]

    # gh is not reachable here, so rm sees no PR and keeps the branches.
    removed = mrcmd("rm", cwd=task)
    assert not task.exists(), removed.stdout
    assert "kept branch feat/T-1-thing" in removed.stdout

    # A plain repo (--repo): not on GitHub here, so prs has nothing to watch and says why.
    plain = json.loads(mrcmd("prs", "--repo", str(project / "helper")).stdout)
    assert plain["isRepo"] and plain["prs"] == [] and plain["skipped"] == "not a GitHub repo" and plain["project"] == "helper"

    # Restack: develop <- feat/A <- feat/B; A gets a review fix pushed, B is rebased onto it.
    for key in ("GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"):
        os.environ[key] = env[key]
    backend = project / "proj-backend"
    g = lambda repo, *args: sh("git", "-C", str(repo), *args).stdout.strip()  # noqa: E731

    def commit(repo, name, text):
        (repo / name).write_text(text)
        g(repo, "add", name)
        g(repo, "commit", "-qm", name)

    g(backend, "checkout", "-q", "-b", "feat/A", "origin/develop")
    commit(backend, "a.txt", "a")
    g(backend, "checkout", "-q", "-b", "feat/B")
    commit(backend, "b.txt", "b")
    g(backend, "push", "-q", "origin", "feat/A", "feat/B")
    g(backend, "checkout", "-q", "develop")
    wt_b = tmp / "wt-b"
    g(backend, "worktree", "add", "-q", str(wt_b), "feat/B")
    reviewer = tmp / "reviewer"
    sh("git", "clone", "-q", "-b", "feat/A", str(tmp / "origin" / "proj-backend.git"), str(reviewer))
    commit(reviewer, "fix.txt", "fix")
    g(reviewer, "push", "-q", "origin", "feat/A")
    stack = lambda: mr.restack_plan("develop", [layer(1, "OPEN", "feat/A", g(reviewer, "rev-parse", "feat/A")),  # noqa: E731
                                                layer(2, "OPEN", "feat/B", g(backend, "rev-parse", "origin/feat/B"))])
    assert mr.restack_layers(backend, stack()) == "restacked feat/B"
    assert g(backend, "rev-parse", "origin/feat/B") == g(wt_b, "rev-parse", "HEAD"), "the checkout follows"
    assert mr.is_ancestor(backend, g(reviewer, "rev-parse", "feat/A"), "origin/feat/B")
    assert g(backend, "rev-list", "--count", "origin/feat/A..origin/feat/B") == "1"
    assert mr.restack_layers(backend, stack()) == "up to date"
    # A change to A that clashes with B's file: nothing is pushed and no scratch worktree is left.
    commit(reviewer, "b.txt", "clash")
    g(reviewer, "push", "-q", "origin", "feat/A")
    before = g(backend, "rev-parse", "origin/feat/B")
    try:
        mr.restack_layers(backend, stack())
        raise AssertionError("a conflict should stop the restack")
    except mr.MrError as error:
        assert "feat/B conflicts with feat/A in b.txt" in str(error), error
    assert g(backend, "ls-remote", "origin", "refs/heads/feat/B").split()[0] == before
    assert "mr-restack-" not in g(backend, "worktree", "list")
    g(backend, "worktree", "remove", str(wt_b))

    other = tmp / "other-wt"
    sh("git", "-C", str(project / "proj-portal"), "worktree", "add", "-q", "-b", "feat/T-2", str(other))
    mrcmd("new", "feat/T-2", "portal", cwd=project)
    task2 = tmp / ".herdr" / "projects" / "Proj" / "feat-T-2"
    assert (task2 / "proj-portal").is_symlink() and (task2 / "proj-portal").resolve() == other.resolve()
    assert json.loads((task2 / ".mr-task.json").read_text())["borrowed"] == ["proj-portal"]
    mrcmd("rm", cwd=task2)
    assert not task2.exists() and other.exists()

print("mr.py ok")
