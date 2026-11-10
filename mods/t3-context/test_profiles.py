"""Self-check for profiles.py: python3 test_profiles.py"""

import json
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import profiles  # noqa: E402

HOME_DIR = str(Path.home())
BASE = {
    "// a comment": "ignored",
    "providers": {"linear": {"fields": ["team", {"name": "key", "secret": True}], "env": {"LINEAR_API_KEY": "{key}", "LINEAR_TEAM": "{team}"}}},
    "profiles": {
        "work": {
            "label": "Work", "badge": "Acme", "color": "ansi3",
            "machines": ["work-box"], "folders": ["~/work"],
            "coordinator": {"folder": "coordinators/work"},
            "agents": {"reviewer": "codex", "forbidden": ["opencode"]},
            "accounts": {
                "claude": {"configDir": "~/.claude-acme"},
                "github": {"user": "jane-acme"},
                "linear": {"team": "ENG", "key": {"command": ["printf", "lin-secret"]}},
            },
        },
        "personal": {
            "label": "Personal", "machines": ["home-box", "laptop"], "folders": ["~/personal", "~/work/side"],
            "agents": {"forbidden": ["codex"]},
            "accounts": {"claude": {"configDir": None}},
        },
        "client": {"label": "Client", "accounts": {"claude": {"configDir": "~/.claude-client"}}},
    },
}


def home_with(raw) -> Path:
    home = Path(tempfile.mkdtemp())
    (home / "coordinators/work").mkdir(parents=True)
    (home / "templates").mkdir()
    (home / "templates/reviewer.md").write_text("---\nname: reviewer\ncommand: codex --no-daemon\n---\nReview.\n")
    (home / "templates/helper.md").write_text("---\ncommand: opencode\n---\n")
    (home / "templates/a-codex.md").write_text("---\ncommand: /usr/local/bin/codex\n---\n")
    (home / "templates/fixer.md").write_text("---\ncommand: claude --model x\n---\n")
    (home / "profiles.json").write_text(raw if isinstance(raw, str) else json.dumps(raw))
    return home


def load(raw=BASE) -> profiles.Config:
    home = home_with(raw)
    return profiles.load(home, home / "templates")


def errors_of(change) -> str:
    raw = json.loads(json.dumps(BASE))
    change(raw)
    try:
        load(raw)
    except profiles.InvalidProfiles as error:
        return "\n".join(error.errors)
    return ""


def which(config, machine=None, folder=None, env=None):
    found = profiles.match(config, {"machine": machine, "folder": folder, "env": env})
    return found["profile"], found["by"]


config = load()
assert list(config.profiles) == ["work", "personal", "client"], "the file's order is the switch's"
assert config.profiles["personal"]["badge"] == "Personal", "badge defaults to the label"
assert config.profiles["work"]["coordinator"]["folder"].endswith("/coordinators/work")
assert config.profiles["client"] == {"label": "Client", "badge": "Client", "color": None, "machines": [], "folders": [],
                                     "coordinator": None, "agents": {"reviewer": None, "reviewerTemplate": None, "forbidden": []},
                                     "accounts": {"claude": {"configDir": "~/.claude-client"}}}
# The reviewer is an agent; hc starts it through the template that runs it (one named reviewer... first).
assert config.profiles["work"]["agents"] == {"reviewer": "codex", "reviewerTemplate": "reviewer", "forbidden": ["opencode"]}
assert profiles.template_running(home_with(BASE) / "templates", "claude") == "fixer", "no reviewer... template: the one that runs it"
assert profiles.template_running(home_with(BASE) / "templates", "aider") is None
assert config.providers["linear"]["fields"] == {"team": False, "key": True}
assert config.providers["github"]["fields"] == {"user": False}

# No file: no profiles, and nothing matches.
empty = profiles.load(Path(tempfile.mkdtemp()))
assert empty.profiles == {} and which(empty, "work-box", "~/work") == (None, None)

# Which profile: the process's own word, then its machine, then its folder, then its Claude account.
work_env = {"CLAUDE_CONFIG_DIR": f"{HOME_DIR}/.claude-acme"}
assert which(config, "work-box", "~/personal", {"HERDR_PROFILE": "client", **work_env}) == ("client", "env")
assert which(config, "work-box", "~/personal", {"HERDR_PROFILE": "gone", "CLAUDE_CONFIG_DIR": None}) == ("work", "machine")
assert which(config, "laptop", None, work_env) == ("personal", "machine")
assert which(config, None, f"{HOME_DIR}/work/api", {"CLAUDE_CONFIG_DIR": None}) == ("work", "folder")
assert which(config, None, "~/work") == ("work", "folder")
assert which(config, None, "~/work/side/x") == ("personal", "folder"), "the longest declared folder wins"
assert which(config, None, "~/workshop", work_env) == ("work", "account"), "a folder is matched whole, not by its letters"
assert which(config, None, "/tmp/x", {"CLAUDE_CONFIG_DIR": "~/.claude-client/"}) == ("client", "account")
assert which(config, None, "/tmp/x", {"CLAUDE_CONFIG_DIR": None}) == ("personal", "account"), "unset is the default account"
assert which(config, None, "/tmp/x", {"CLAUDE_CONFIG_DIR": "~/.claude"}) == ("personal", "account")
assert which(config, None, "/tmp/x", {"CLAUDE_CONFIG_DIR": "~/.claude-other"}) == (None, None)
assert which(config, None, "/tmp/x", None) == (None, None), "an unknown environment says nothing"
assert which(config, "shared-box", "~/work", work_env) == ("work", "account"), "declared folders are this machine's"
assert profiles.current(config, {"CLAUDE_CONFIG_DIR": f"{HOME_DIR}/.claude-acme"}, "/tmp") == {"profile": "work", "by": "account"}
assert profiles.current(config, {"HERDR_PROFILE": "client"}, "/tmp")["profile"] == "client"

# Two profiles on one Claude account: the account can't tell them apart, a folder can.
shared = json.loads(json.dumps(BASE))
shared["profiles"]["client"]["accounts"]["claude"]["configDir"] = None
assert which(load(shared), None, "/tmp/x", {"CLAUDE_CONFIG_DIR": None}) == (None, None)
assert which(load(shared), None, "~/personal", {"CLAUDE_CONFIG_DIR": None}) == ("personal", "folder")
del shared["profiles"]["personal"]["folders"]
assert any("share the Claude account ~/.claude" in warning for warning in load(shared).warnings)

# The environment: {field} filled in, a null field unsets, secrets resolved by their reference.
asked = []
def resolve(reference, where):
    asked.append((reference, where))
    return "secret"
GIT_UNSET = dict.fromkeys(["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"])
assert profiles.profile_env(config, "work", resolve) == {
    "HERDR_PROFILE": "work", "CLAUDE_CONFIG_DIR": f"{HOME_DIR}/.claude-acme", "GH_TOKEN": "secret",
    "LINEAR_API_KEY": "secret", "LINEAR_TEAM": "ENG", **GIT_UNSET}
assert asked[0][0] == {"command": ["gh", "auth", "token", "--user", "jane-acme"]} and "accounts.github (GH_TOKEN)" in asked[0][1]
assert asked[1][0] == {"command": ["printf", "lin-secret"]}
# A provider the profile has no account of: its variables are unset, so a process started as this
# profile keeps no token or identity of the profile it was started from.
assert profiles.profile_env(config, "personal", resolve) == {
    "HERDR_PROFILE": "personal", "CLAUDE_CONFIG_DIR": None, "GH_TOKEN": None, "LINEAR_API_KEY": None, "LINEAR_TEAM": None, **GIT_UNSET}
assert profiles.profile_env(load({"profiles": {"bare": {"label": "Bare"}}}), "bare", resolve)["CLAUDE_CONFIG_DIR"] is None
assert profiles.account(config, "work", "linear") == {"team": "ENG", "key": "lin-secret"}, "a command reference runs"
assert profiles.account(config, "personal", "linear") is None

# The same environment as .envrc lines: secrets stay references, a null field unsets, ~ is $HOME.
assert profiles.envrc(config, "work")[1:] == [
    "export HERDR_PROFILE=work",
    'export CLAUDE_CONFIG_DIR="$HOME/.claude-acme"',
    'export GH_TOKEN="$(gh auth token --user jane-acme)"',
    *(f"unset {variable}" for variable in GIT_UNSET),
    'export LINEAR_API_KEY="$(printf lin-secret)"',
    "export LINEAR_TEAM=ENG",
]
assert profiles.envrc(config, "personal")[1:] == ["export HERDR_PROFILE=personal", "unset CLAUDE_CONFIG_DIR", "unset GH_TOKEN",
                                                  *(f"unset {variable}" for variable in GIT_UNSET), "unset LINEAR_API_KEY", "unset LINEAR_TEAM"]
assert profiles.envrc_line("TOKEN", {"env": "MY_TOKEN"}) == 'export TOKEN="${MY_TOKEN}"'
assert profiles.envrc_line("NAME", "Jane O'Doe") == """export NAME='Jane O'"'"'Doe'"""
assert profiles.envrc_line("DIR", '~/a "b"$c') == 'export DIR="$HOME/a \\"b\\"\\$c"'

failing = json.loads(json.dumps(BASE))
failing["profiles"]["work"]["accounts"]["linear"]["key"] = {"command": ["sh", "-c", "echo token=hunter2 in https://u:hunter2@host >&2; exit 4", "hunter2-arg"]}
try:
    profiles.account(load(failing), "work", "linear")
    raise AssertionError("a failing secret command must raise")
except profiles.ProfileError as error:
    assert "accounts.linear.key" in str(error) and "(sh) failed with exit 4" in str(error)
    assert "hunter2" not in str(error), "nothing the command printed or was given is in the error"
for command, why in ((["/no/such/helper", "hunter2"], "didn't start"), (["true"], "printed nothing")):
    try:
        profiles.resolve_secret({"command": command}, "here")
        raise AssertionError("a secret command that gives nothing must raise")
    except profiles.ProfileError as error:
        assert why in str(error) and "hunter2" not in str(error), str(error)
profiles.SECRET_TIMEOUT = 0.2
try:
    profiles.resolve_secret({"command": [sys.executable, "-c", "import time; time.sleep(5)", "hunter2"]}, "here")
    raise AssertionError("a secret command that hangs must raise")
except profiles.ProfileError as error:
    assert "gave no answer" in str(error) and "hunter2" not in str(error), str(error)
profiles.SECRET_TIMEOUT = 30
try:
    profiles.profile_env(config, "nobody")
    raise AssertionError("an unknown profile must raise")
except profiles.ProfileError as error:
    assert "No profile nobody" in str(error) and "work, personal, client" in str(error)

# An {"env"} reference: the variable of this environment or of ~/.profile, exported there or not.
import os  # noqa: E402
real_home, os.environ["HOME"] = os.environ["HOME"], tempfile.mkdtemp()
try:
    Path(os.environ["HOME"], ".profile").write_text("BARE_TOKEN=bare-secret\nexport EXPORTED_TOKEN='exported secret'\n")
    assert profiles.resolve_secret({"env": "BARE_TOKEN"}, "here") == "bare-secret"
    assert profiles.resolve_secret({"env": "EXPORTED_TOKEN"}, "here") == "exported secret"
    os.environ["PROFILES_TEST_TOKEN"] = "from-environment"
    assert profiles.resolve_secret({"env": "PROFILES_TEST_TOKEN"}, "here") == "from-environment"
    try:
        profiles.resolve_secret({"env": "NOT_SET_ANYWHERE"}, "profiles.work.accounts.jira.token")
        raise AssertionError("an unset variable must raise")
    except profiles.ProfileError as error:
        assert str(error) == "profiles.work.accounts.jira.token: NOT_SET_ANYWHERE is not set (in the environment or ~/.profile)"
finally:
    os.environ["HOME"] = real_home
assert not profiles.is_secret_reference({"env": "X; rm -rf ~"}), "a variable's name, nothing else"
assert not profiles.is_secret_reference({"env": "A", "command": ["b"]}) and not profiles.is_secret_reference("plain")

# Every mistake is named with where it is.
def set_in(*path_and_value):
    *path, value = path_and_value
    def change(raw):
        node = raw
        for key in path[:-1]:
            node = node[key]
        node[path[-1]] = value
    return change

assert errors_of(lambda raw: None) == ""
assert "profiles.personal.machines: work-box is also in profile work" in errors_of(set_in("profiles", "personal", "machines", ["work-box"]))
assert "profiles.personal.folders: ~/work/ is also in profile work" in errors_of(set_in("profiles", "personal", "folders", ["~/work/"]))
assert "profiles.work.coordinator.folder" in errors_of(set_in("profiles", "work", "coordinator", {"folder": "coordinators/none"}))
assert "profiles.work.label: needed" in errors_of(set_in("profiles", "work", "label", ""))
assert "profiles.work.colour: unknown key" in errors_of(set_in("profiles", "work", "colour", "red"))
assert "profiles.Work Stuff: a name is" in errors_of(set_in("profiles", "Work Stuff", {"label": "x"}))
assert "profiles.work.accounts.gitlab: no such provider" in errors_of(set_in("profiles", "work", "accounts", "gitlab", {}))
assert "profiles.work.accounts.github.login: github has no such field" in errors_of(set_in("profiles", "work", "accounts", "github", {"login": "x"}))
assert "never as its value" in errors_of(set_in("profiles", "work", "accounts", "linear", "key", "lin-secret"))
assert "must be a text or null" in errors_of(set_in("profiles", "work", "accounts", "linear", "team", {"env": "TEAM"}))
assert "profiles.work.agents.reviewer: codex is a program this profile forbids" in errors_of(set_in("profiles", "work", "agents", "forbidden", ["codex"]))
assert "reviewer is an hc template's name; give the agent it runs: codex" in errors_of(set_in("profiles", "work", "agents", "reviewer", "reviewer"))
assert "must be an agent's program" in errors_of(set_in("profiles", "work", "agents", "reviewer", ["codex"]))
assert "must be an agent's program" in errors_of(set_in("profiles", "work", "agents", "reviewer", ""))
assert "providers.linear.env: {org} is not one of its fields" in errors_of(set_in("providers", "linear", "env", "LINEAR_ORG", "{org}"))
assert "the secret field key can only be used alone" in errors_of(set_in("providers", "linear", "env", "LINEAR_API_KEY", "Bearer {key}"))
assert "settings: unknown key" in errors_of(set_in("settings", {}))
both = errors_of(lambda raw: (set_in("profiles", "work", "label", "")(raw), set_in("profiles", "personal", "machines", "x")(raw)))
assert "label" in both and "machines: must be a list" in both, "every error at once"
unstartable = load({"profiles": {"a": {"label": "A", "agents": {"reviewer": "aider"}}}})
assert any("runs aider, so hc can't start it as a reviewer" in warning for warning in unstartable.warnings)
assert unstartable.profiles["a"]["agents"]["reviewerTemplate"] is None
try:
    load("{ not json")
    raise AssertionError("invalid JSON must raise")
except profiles.InvalidProfiles as error:
    assert "not JSON" in error.errors[0]

# Writes: one change to a freshly read file, validated whole, and nothing written when it is invalid.
home = home_with(BASE)
tpl = home / "templates"
before = (home / "profiles.json").read_text()
profiles.put(home, "client", {"label": "Client Co", "color": "ansi5", "machines": ["client-box"]}, tpl)
after = json.loads((home / "profiles.json").read_text())
assert list(after["profiles"]) == ["work", "personal", "client"], "a replaced profile keeps its place"
assert after["profiles"]["client"] == {"label": "Client Co", "color": "ansi5", "machines": ["client-box"]}
assert after["// a comment"] == "ignored" and "linear" in after["providers"], "the rest of the file is kept"
assert (home / "profiles.json.bak").read_text() == before
profiles.put(home, "side", {"label": "Side", "coordinator": {"folder": "coordinators/side"}}, tpl)
assert list(profiles.load(home, tpl).profiles) == ["work", "personal", "client", "side"], "a new profile goes last"
assert "coordinator" in (home / "coordinators/side/CLAUDE.md").read_text().lower(), "a new coordinator gets its folder"
(home / "coordinators/side/CLAUDE.md").write_text("mine")
profiles.put(home, "side", {"// note": "kept", "label": "Side"}, tpl)
profiles.put(home, "side", {"label": "Side 2", "coordinator": {"folder": "coordinators/side"}}, tpl)
assert (home / "coordinators/side/CLAUDE.md").read_text() == "mine", "a folder that exists is left as it is"
assert json.loads((home / "profiles.json").read_text())["profiles"]["side"]["// note"] == "kept", "a profile's own comments stay"

unchanged = (home / "profiles.json").read_text()
for bad in (lambda: profiles.put(home, "side", {"label": "Side", "machines": ["work-box"]}, tpl),
            lambda: profiles.put(home, "Bad Name", {"label": "x"}, tpl),
            lambda: profiles.put(home, "side", "not an object", tpl),
            lambda: profiles.remove(home, "nobody", tpl),
            lambda: profiles.order(home, ["work", "personal"], tpl),
            lambda: profiles.order(home, ["work", "work", "personal", "client", "side"], tpl)):
    try:
        bad()
        raise AssertionError("an invalid change must raise")
    except profiles.ProfileError:
        assert (home / "profiles.json").read_text() == unchanged, "a rejected change leaves the file byte-identical"
assert not list(home.glob("*.tmp")), "no pending file is left behind"

profiles.order(home, ["side", "client", "personal", "work"], tpl)
assert list(profiles.load(home, tpl).profiles) == ["side", "client", "personal", "work"]
profiles.remove(home, "client", tpl)
assert list(profiles.load(home, tpl).profiles) == ["side", "personal", "work"]
assert (home / "coordinators/side").is_dir()
profiles.remove(home, "side", tpl)
assert (home / "coordinators/side/CLAUDE.md").read_text() == "mine", "removing a profile leaves its coordinator's folder"

# assign: a machine or a folder moves in one write, and is never in two profiles.
home = home_with(BASE)
profiles.assign(home, "machine", "work-box", "personal", tpl)
moved_to = profiles.load(home, tpl).profiles
assert moved_to["personal"]["machines"] == ["home-box", "laptop", "work-box"] and moved_to["work"]["machines"] == []
assert "machines" not in json.loads((home / "profiles.json").read_text())["profiles"]["work"], "an emptied list is not written"
profiles.assign(home, "machine", "work-box", "-", tpl)
assert all("work-box" not in profile["machines"] for profile in profiles.load(home, tpl).profiles.values()), "-: a shared machine"
profiles.assign(home, "machine", "new-box", "client", tpl)
assert profiles.load(home, tpl).profiles["client"]["machines"] == ["new-box"]
profiles.assign(home, "folder", f"{HOME_DIR}/work/", "client", tpl)
after = profiles.load(home, tpl).profiles
assert after["client"]["folders"] == ["~/work"] and after["work"]["folders"] == [], "the same folder, however it is written"
assert after["personal"]["folders"] == ["~/personal", "~/work/side"], "a folder inside it is another folder"
profiles.assign(home, "folder", "/srv/shared", "work", tpl)
assert profiles.load(home, tpl).profiles["work"]["folders"] == ["/srv/shared"]
profiles.assign(home, "folder", "~/work", "-", tpl)
assert profiles.load(home, tpl).profiles["client"]["folders"] == []
unchanged = (home / "profiles.json").read_text()
for bad in (lambda: profiles.assign(home, "machine", "x", "nobody", tpl), lambda: profiles.assign(home, "repo", "x", "work", tpl)):
    try:
        bad()
        raise AssertionError("an invalid assignment must raise")
    except profiles.ProfileError:
        assert (home / "profiles.json").read_text() == unchanged

# Writers at the same time: each change is made to the file as the last one left it, so all are kept.
import subprocess  # noqa: E402
crowded = home_with({"profiles": {"first": {"label": "First"}}})
writers = [subprocess.Popen([sys.executable, str(HERE / "profiles.py"), "put", f"p{n}", json.dumps({"label": f"P{n}"})],
                            env={**os.environ, "HERDR_APP_HOME": str(crowded)}, stderr=subprocess.PIPE) for n in range(12)]
assert [writer.wait() for writer in writers] == [0] * 12, [writer.stderr.read() for writer in writers]
assert sorted(profiles.load(crowded, tpl).profiles) == sorted(["first", *(f"p{n}" for n in range(12))])
assert not list(crowded.glob("*.tmp"))
assert (crowded / "profiles.json").stat().st_mode & 0o777 == 0o644, "the file keeps its mode"

fresh = Path(tempfile.mkdtemp())
profiles.put(fresh, "only", {"label": "Only"}, tpl)
assert list(profiles.load(fresh, tpl).profiles) == ["only"] and not (fresh / "profiles.json.bak").exists(), "the first profile makes the file"

# The shipped example is valid as it is (its coordinator folder aside, checked in its own home).
example = json.loads((HERE.parent.parent / "profiles.example.json").read_text())
example_home = home_with(example)
(example_home / "coordinators/example").mkdir()
assert list(profiles.load(example_home, example_home / "templates").profiles) == ["work", "personal"]

print("profiles: ok")
