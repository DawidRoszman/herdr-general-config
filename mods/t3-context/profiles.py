#!/usr/bin/env python3

from __future__ import annotations

import contextlib
import functools
import json
import os
import re
import shlex
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

HERE = Path(__file__).resolve().parent
TEMPLATES = Path.home() / ".config/herdr-core/templates"
PROFILES_FILE = "profiles.json"
NAME = re.compile(r"^[a-z0-9][a-z0-9-]*$")
PLACEHOLDER = re.compile(r"\{(\w+)\}")
VARIABLE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
PROFILE_KEYS = {"label", "badge", "color", "machines", "folders", "projects", "agents", "accounts"}
PROJECT_KEYS = {"label", "jira", "places", "coordinator"}
DEFAULT_CLAUDE_DIR = "~/.claude"
SECRET_TIMEOUT = 30
NONE_EXIT = 3

class ProfileError(Exception):
    pass

class InvalidProfiles(ProfileError):
    def __init__(self, errors: list):
        super().__init__("\n".join(errors))
        self.errors = errors

@dataclass
class Config:
    profiles: dict
    providers: dict
    warnings: list = field(default_factory=list)

def app_home() -> Path:
    return Path(os.environ.get("HERDR_APP_HOME") or HERE.parent.parent)

def without_comments(mapping: dict) -> dict:
    return {key: value for key, value in mapping.items() if not key.startswith("//")}

def read_raw(home: Path) -> dict:
    path = home / PROFILES_FILE
    try:
        raw = json.loads(path.read_text())
    except FileNotFoundError:
        return {}
    except json.JSONDecodeError as error:
        raise InvalidProfiles([f"{path}: not JSON ({error})"])
    if not isinstance(raw, dict):
        raise InvalidProfiles([f"{path}: must be an object with \"profiles\""])
    return raw

def is_secret_reference(value) -> bool:
    if not isinstance(value, dict) or len(value) != 1:
        return False
    if "env" in value:
        return isinstance(value["env"], str) and bool(VARIABLE.match(value["env"]))
    command = value.get("command")
    return isinstance(command, list) and bool(command) and all(isinstance(part, str) for part in command)

def placeholders(template) -> set:
    parts = [template] if isinstance(template, str) else template.get("command", []) if isinstance(template, dict) else []
    return {name for part in parts for name in PLACEHOLDER.findall(part)}

def read_providers(raw: dict, errors: list) -> dict:
    shipped = json.loads((HERE / "providers.json").read_text())
    own = raw.get("providers", {})
    if not isinstance(own, dict):
        errors.append("providers: must be an object")
        own = {}
    providers = {}
    for name, declared in {**without_comments(shipped), **without_comments(own)}.items():
        where = f"providers.{name}"
        if not isinstance(declared, dict):
            errors.append(f"{where}: must be an object")
            continue
        env = declared.get("env", {})
        is_env_valid = isinstance(env, dict) and all(isinstance(value, str) or is_secret_reference(value) for value in env.values())
        if not is_env_valid:
            errors.append(f"{where}.env: each variable needs a text or a secret reference ({{\"env\"}} or {{\"command\"}})")
            env = {}
        used = {placeholder for template in env.values() for placeholder in placeholders(template)}
        listed = declared.get("fields")
        if listed is None:
            fields = dict.fromkeys(sorted(used), False)
        else:
            fields = {}
            for item in listed if isinstance(listed, list) else []:
                if isinstance(item, str):
                    fields[item] = False
                elif isinstance(item, dict) and isinstance(item.get("name"), str):
                    fields[item["name"]] = bool(item.get("secret"))
                else:
                    errors.append(f"{where}.fields: each field is a name or {{\"name\", \"secret\"}}")
            if not isinstance(listed, list):
                errors.append(f"{where}.fields: must be a list")
            for placeholder in sorted(used - set(fields)):
                errors.append(f"{where}.env: {{{placeholder}}} is not one of its fields")
        for variable, template in env.items():
            secret_used = [placeholder for placeholder in placeholders(template) if fields.get(placeholder)]
            if secret_used and template != f"{{{secret_used[0]}}}":
                errors.append(f"{where}.env.{variable}: the secret field {secret_used[0]} can only be used alone, as \"{{{secret_used[0]}}}\"")
        providers[name] = {"fields": fields, "env": env}
    return providers

def text_list(value, where: str, errors: list) -> list:
    if value is None:
        return []
    if isinstance(value, list) and all(isinstance(item, str) and item for item in value):
        return value
    errors.append(f"{where}: must be a list of texts")
    return []

def template_program(templates: Path, name: str):
    try:
        found = re.search(r"^command:\s*(\S+)", (templates / f"{name}.md").read_text(), re.MULTILINE)
    except FileNotFoundError:
        return None
    return os.path.basename(found.group(1)) if found else None

def template_running(templates: Path, agent: str):
    if not templates.is_dir():
        return None
    names = sorted(path.stem for path in templates.glob("*.md") if template_program(templates, path.stem) == agent)
    return next((name for name in names if name.startswith("reviewer")), names[0] if names else None)

def read_accounts(raw_accounts, providers: dict, where: str, errors: list) -> dict:
    if raw_accounts is None:
        return {}
    if not isinstance(raw_accounts, dict):
        errors.append(f"{where}: must be an object of provider -> settings")
        return {}
    accounts = {}
    for provider, settings in without_comments(raw_accounts).items():
        at = f"{where}.{provider}"
        if provider not in providers:
            errors.append(f"{at}: no such provider; declare it under \"providers\" (known: {', '.join(sorted(providers))})")
            continue
        if not isinstance(settings, dict):
            errors.append(f"{at}: must be an object")
            continue
        fields = providers[provider]["fields"]
        settings = without_comments(settings)
        for name, value in settings.items():
            if name not in fields:
                errors.append(f"{at}.{name}: {provider} has no such field (it has: {', '.join(fields) or 'none'})")
            elif value is None:
                continue
            elif fields[name] and not is_secret_reference(value):
                errors.append(f"{at}.{name}: a secret is given as {{\"env\": \"NAME\"}} or {{\"command\": [...]}}, never as its value")
            elif not fields[name] and not isinstance(value, str):
                errors.append(f"{at}.{name}: must be a text or null")
        accounts[provider] = settings
    return accounts

def read_place(raw, where: str, errors: list):
    raw = without_comments(raw) if isinstance(raw, dict) else {}
    machine, root = raw.get("machine"), raw.get("root")
    if set(raw) - {"machine", "root"} or not isinstance(root, str) or not root or not (machine is None or isinstance(machine, str)):
        errors.append(f"{where}: a place is {{\"root\": a folder}} with \"machine\" for one on another machine")
        return None
    return {"machine": machine or None, "root": root.rstrip("/") or "/" if machine else absolute_folder(root)}

def read_project(raw, where: str, home: Path, errors: list, is_folder_made_later: bool) -> dict:
    if not isinstance(raw, dict):
        errors.append(f"{where}: must be an object")
        raw = {}
    raw = without_comments(raw)
    for key in sorted(set(raw) - PROJECT_KEYS):
        errors.append(f"{where}.{key}: unknown key (known: {', '.join(sorted(PROJECT_KEYS))})")
    label = raw.get("label")
    if not isinstance(label, str) or not label:
        errors.append(f"{where}.label: needed, a text")
        label = where.rsplit(".", 1)[-1]
    raw_places = raw.get("places") or []
    if not isinstance(raw_places, list):
        errors.append(f"{where}.places: must be a list of places")
        raw_places = []
    places = [read_place(place, f"{where}.places[{index}]", errors) for index, place in enumerate(raw_places)]

    coordinator = raw.get("coordinator")
    if coordinator is not None:
        folder = coordinator.get("folder") if isinstance(coordinator, dict) else None
        if not isinstance(folder, str) or not folder:
            errors.append(f"{where}.coordinator: needs \"folder\"")
            coordinator = None
        else:
            path = Path(os.path.expanduser(folder))
            path = path if path.is_absolute() else home / path
            if not path.is_dir() and not is_folder_made_later:
                errors.append(f"{where}.coordinator.folder: {path} is not a folder")
            coordinator = {"folder": str(path)}
    return {
        "label": label,
        "jira": text_list(raw.get("jira"), f"{where}.jira", errors),
        "places": [place for place in places if place],
        "coordinator": coordinator,
    }

LOCAL_MACHINE = "local"

def read_agent_machines(raw, profile_machines: list, where: str, errors: list) -> dict:
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        errors.append(f"{where}: must be an object of machine (or \"local\") -> agent programs allowed there")
        return {}
    machines = {}
    for machine, programs in without_comments(raw).items():
        if machine != LOCAL_MACHINE and machine not in profile_machines:
            errors.append(f"{where}.{machine}: not this profile's machine (its machines: {', '.join([LOCAL_MACHINE, *profile_machines])})")
            continue
        machines[machine] = text_list(programs, f"{where}.{machine}", errors)
    return machines

def known_agents(config: Config) -> set:
    return {program for profile in config.profiles.values()
            for program in [profile["agents"]["reviewer"], *(p for allowed in profile["agents"]["machines"].values() for p in allowed)]
            if program}

def read_profile(name: str, raw, providers: dict, home: Path, templates: Path, errors: list, warnings: list, is_folder_made_later=False) -> dict:
    where = f"profiles.{name}"
    if not NAME.match(name):
        errors.append(f"{where}: a name is lowercase letters, digits and dashes")
    if not isinstance(raw, dict):
        errors.append(f"{where}: must be an object")
        raw = {}
    raw = without_comments(raw)
    if "coordinator" in raw:
        errors.append(f"{where}.coordinator: a coordinator is a project's now; move it to {where}.projects.<name>.coordinator")
    for key in sorted(set(raw) - PROFILE_KEYS - {"coordinator"}):
        errors.append(f"{where}.{key}: unknown key (known: {', '.join(sorted(PROFILE_KEYS))})")
    label = raw.get("label")
    if not isinstance(label, str) or not label:
        errors.append(f"{where}.label: needed, a text")
        label = name
    for key in ("badge", "color"):
        if raw.get(key) is not None and not isinstance(raw[key], str):
            errors.append(f"{where}.{key}: must be a text")

    raw_projects = raw.get("projects") or {}
    if not isinstance(raw_projects, dict):
        errors.append(f"{where}.projects: must be an object of name -> project")
        raw_projects = {}
    projects = {}
    for project, value in without_comments(raw_projects).items():
        if not NAME.match(project):
            errors.append(f"{where}.projects.{project}: a name is lowercase letters, digits and dashes")
        projects[project] = read_project(value, f"{where}.projects.{project}", home, errors, is_folder_made_later)

    machines = text_list(raw.get("machines"), f"{where}.machines", errors)
    raw_agents = raw.get("agents") or {}
    if not isinstance(raw_agents, dict):
        errors.append(f"{where}.agents: must be an object")
        raw_agents = {}
    raw_agents = without_comments(raw_agents)
    for key in sorted(set(raw_agents) - {"reviewer", "machines"}):
        errors.append(f"{where}.agents.{key}: unknown key (known: machines, reviewer)")
    reviewer = raw_agents.get("reviewer")
    if reviewer is not None and (not isinstance(reviewer, str) or not reviewer):
        errors.append(f"{where}.agents.reviewer: must be an agent's program (e.g. codex), or left out for no reviewer")
        reviewer = None
    agent_machines = read_agent_machines(raw_agents.get("machines"), machines, f"{where}.agents.machines", errors)
    reviewer_template = template_running(templates, reviewer) if reviewer else None
    if reviewer and agent_machines and not any(reviewer in allowed for allowed in agent_machines.values()):
        warnings.append(f"{where}.agents.reviewer: no machine of this profile allows {reviewer} (agents.machines), "
                        "so it can only review on a machine left out there")
    if reviewer and reviewer_template is None:
        named = template_program(templates, reviewer)
        if named and named != reviewer:
            errors.append(f"{where}.agents.reviewer: {reviewer} is an hc template's name; give the agent it runs: {named}")
        else:
            warnings.append(f"{where}.agents.reviewer: no hc template in {templates} runs {reviewer}, so hc can't start it as a reviewer")

    return {
        "label": label,
        "badge": raw.get("badge") if isinstance(raw.get("badge"), str) else label,
        "color": raw.get("color") if isinstance(raw.get("color"), str) else None,
        "machines": machines,
        "folders": text_list(raw.get("folders"), f"{where}.folders", errors),
        "projects": projects,
        "agents": {"reviewer": reviewer, "reviewerTemplate": reviewer_template, "machines": agent_machines},
        "accounts": read_accounts(raw.get("accounts"), providers, f"{where}.accounts", errors),
    }

def absolute_folder(folder: str) -> str:
    return os.path.normpath(os.path.expanduser(folder))

def short_dir(config_dir) -> str:
    if not config_dir:
        return DEFAULT_CLAUDE_DIR
    path = os.path.normpath(os.path.expanduser(config_dir))
    home = str(Path.home())
    return "~" + path[len(home):] if path == home or path.startswith(home + os.sep) else path

def claude_dir(profile: dict):
    account = profile["accounts"].get("claude")
    return None if account is None else short_dir(account.get("configDir"))

def check_across(profiles: dict, errors: list, warnings: list) -> None:
    for key, normalise in (("machines", str), ("folders", absolute_folder)):
        owner = {}
        for name, profile in profiles.items():
            for value in profile[key]:
                first = owner.setdefault(normalise(value), name)
                if first != name:
                    errors.append(f"profiles.{name}.{key}: {value} is also in profile {first}")
    owner = {}
    for name, profile in profiles.items():
        for project_name, project in profile["projects"].items():
            where = f"profiles.{name}.projects.{project_name}"
            claims = [("jira", key, key) for key in project["jira"]]
            claims += [("places", (place["machine"], place["root"]), place["root"]) for place in project["places"]]
            if project["coordinator"]:
                claims.append(("coordinator.folder", project["coordinator"]["folder"], project["coordinator"]["folder"]))
            for key, claimed, shown in claims:
                first = owner.setdefault((key, claimed), where)
                if first != where:
                    errors.append(f"{where}.{key}: {shown} is also in {first}")
    by_dir = {}
    for name, profile in profiles.items():
        if claude_dir(profile) is not None:
            by_dir.setdefault(claude_dir(profile), []).append(name)
    for config_dir, names in by_dir.items():
        if len(names) > 1 and not any(profiles[name]["folders"] for name in names):
            warnings.append(f"profiles {', '.join(names)} share the Claude account {config_dir} and declare no folders: "
                            "a folder there can't be told apart")

def load(home: Path, templates: Path = TEMPLATES) -> Config:
    return build(read_raw(home), home, templates)

def build(raw: dict, home: Path, templates: Path = TEMPLATES, new_coordinator_of=None) -> Config:
    errors, warnings = [], []
    for key in sorted(set(without_comments(raw)) - {"profiles", "providers"}):
        errors.append(f"{key}: unknown key (known: profiles, providers)")
    providers = read_providers(raw, errors)
    raw_profiles = raw.get("profiles", {})
    if not isinstance(raw_profiles, dict):
        errors.append("profiles: must be an object of name -> profile")
        raw_profiles = {}
    profiles = {name: read_profile(name, value, providers, home, templates, errors, warnings, name == new_coordinator_of)
                for name, value in without_comments(raw_profiles).items()}
    check_across(profiles, errors, warnings)
    if errors:
        raise InvalidProfiles(errors)
    return Config(profiles, providers, warnings)

def match(config: Config, item: dict) -> dict:
    env = item.get("env")
    machine = item.get("machine") or None
    folder = item.get("folder")
    declared = (env or {}).get("HERDR_PROFILE")
    if declared in config.profiles:
        return {"profile": declared, "by": "env"}
    for name, profile in config.profiles.items():
        if machine and machine in profile["machines"]:
            return {"profile": name, "by": "machine"}
    if folder and not machine:
        folder = absolute_folder(folder)
        under = [(len(root), name) for name, profile in config.profiles.items()
                 for root in map(absolute_folder, profile["folders"])
                 if is_inside(folder, root)]
        if under:
            return {"profile": max(under)[1], "by": "folder"}
    if env is not None and "CLAUDE_CONFIG_DIR" in env:
        names = [name for name, profile in config.profiles.items() if claude_dir(profile) == short_dir(env["CLAUDE_CONFIG_DIR"])]
        if len(names) == 1:
            return {"profile": names[0], "by": "account"}
    return {"profile": None, "by": None}

def is_inside(folder: str, root: str) -> bool:
    return folder == root or folder.startswith(root.rstrip(os.sep) + os.sep)

def project_at(profile: dict, folder: str):
    folder = absolute_folder(folder)
    for name, project in profile["projects"].items():
        roots = [place["root"] for place in project["places"] if not place["machine"]]
        if project["coordinator"]:
            roots.append(project["coordinator"]["folder"])
        if any(is_inside(folder, root) for root in roots):
            return name
    return None

def current(config: Config, environ=os.environ, folder=None) -> dict:
    env = {"HERDR_PROFILE": environ.get("HERDR_PROFILE"), "CLAUDE_CONFIG_DIR": environ.get("CLAUDE_CONFIG_DIR")}
    folder = folder or os.getcwd()
    found = match(config, {"machine": None, "folder": folder, "env": env})
    profile = config.profiles.get(found["profile"])
    return {**found, "project": project_at(profile, folder) if profile else None}

def resolve_secret(reference: dict, where: str) -> str:
    if "env" in reference:
        script = '[ -f "$HOME/.profile" ] && . "$HOME/.profile" >/dev/null 2>&1; eval "printf %s \\"\\${$1}\\""'
        result = subprocess.run(["sh", "-c", script, "sh", reference["env"]], capture_output=True, text=True, timeout=SECRET_TIMEOUT)
        if result.returncode != 0 or not result.stdout.strip():
            raise ProfileError(f"{where}: {reference['env']} is not set (in the environment or ~/.profile)")
        return result.stdout.strip()
    command, program = reference["command"], os.path.basename(reference["command"][0])
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=SECRET_TIMEOUT, stdin=subprocess.DEVNULL)
    except subprocess.TimeoutExpired:
        raise ProfileError(f"{where}: its command ({program}) gave no answer in {SECRET_TIMEOUT} s") from None
    except OSError as error:
        raise ProfileError(f"{where}: its command ({program}) didn't start: {error.strerror}") from None
    if result.returncode != 0:
        raise ProfileError(f"{where}: its command ({program}) failed with exit {result.returncode}; run it yourself to see why")
    if not result.stdout.strip():
        raise ProfileError(f"{where}: its command ({program}) printed nothing")
    return result.stdout.strip()

def fill(text: str, account: dict):
    names = PLACEHOLDER.findall(text)
    if any(account.get(name) is None for name in names):
        return None
    return PLACEHOLDER.sub(lambda found: account[found.group(1)], text)

def value_source(template, account: dict):
    if isinstance(template, dict):
        if "env" in template:
            return template
        command = [fill(part, account) for part in template["command"]]
        return None if None in command else {"command": command}
    alone = PLACEHOLDER.fullmatch(template)
    if alone and is_secret_reference(account.get(alone.group(1))):
        return account[alone.group(1)]
    return fill(template, account)

def profile_sources(config: Config, name: str) -> dict:
    accounts = profile_of(config, name)["accounts"]
    sources = {}
    for provider, declared in config.providers.items():
        for variable, template in declared["env"].items():
            source = value_source(template, accounts[provider]) if provider in accounts else None
            if variable not in sources or source is not None:
                sources[variable] = (provider, source)
    return sources

def envrc_line(variable: str, source) -> str:
    if source is None:
        return f"unset {variable}"
    if isinstance(source, dict):
        inner = f"${{{source['env']}}}" if "env" in source else f"$({shlex.join(source['command'])})"
        return f'export {variable}="{inner}"'
    if source.startswith("~/"):
        rest = re.sub(r'(["$`\\])', r"\\\1", source[1:])
        return f'export {variable}="$HOME{rest}"'
    return f"export {variable}={shlex.quote(source)}"

def envrc(config: Config, name: str) -> list:
    return [f"# Herdr profile {name}: printed by `profiles.py envrc {name}`. Change profiles.json, then these lines.",
            f"export HERDR_PROFILE={shlex.quote(name)}",
            *(envrc_line(variable, source) for variable, (_provider, source) in profile_sources(config, name).items())]

def profile_of(config: Config, name: str) -> dict:
    if name not in config.profiles:
        raise ProfileError(f"No profile {name} (there are: {', '.join(config.profiles) or 'none'})")
    return config.profiles[name]

def profile_env(config: Config, name: str, resolve=resolve_secret) -> dict:
    env = {"HERDR_PROFILE": name}
    for variable, (provider, source) in profile_sources(config, name).items():
        if isinstance(source, dict):
            env[variable] = resolve(source, f"profiles.{name}.accounts.{provider} ({variable})")
        else:
            env[variable] = os.path.expanduser(source) if source and source.startswith("~/") else source
    return env

def account(config: Config, name: str, provider: str, resolve=resolve_secret):
    settings = profile_of(config, name)["accounts"].get(provider)
    if settings is None:
        return None
    return {key: resolve(value, f"profiles.{name}.accounts.{provider}.{key}") if is_secret_reference(value) else value
            for key, value in settings.items()}

def run(config: Config, name: str, argv: list) -> None:
    if not argv:
        raise ProfileError("run needs a program: profiles.py run <profile> -- <argv>")
    environ = dict(os.environ)
    for variable, value in profile_env(config, name).items():
        if value is None:
            environ.pop(variable, None)
        else:
            environ[variable] = value
    try:
        os.execvpe(argv[0], argv, environ)
    except OSError as error:
        raise ProfileError(f"{argv[0]} didn't start: {error}")

def unguarded(config: Config) -> list:
    found = []
    for name, profile in config.profiles.items():
        if not profile["agents"]["machines"] or claude_dir(profile) is None:
            continue
        settings = Path(os.path.expanduser(claude_dir(profile))) / "settings.json"
        try:
            hooks = json.loads(settings.read_text()).get("hooks", {}).get("PreToolUse", [])
        except (FileNotFoundError, json.JSONDecodeError):
            hooks = []
        if "agent-guard" not in json.dumps(hooks):
            found.append(f"profiles.{name}.agents.machines: not enforced: {settings} runs no "
                         "agent-guard.py PreToolUse hook (scripts/agent-guard.py says how to add it)")
    return found

def save(home: Path, raw: dict, templates: Path = TEMPLATES, new_coordinator_of=None) -> Config:
    config = build(raw, home, templates, new_coordinator_of)
    if new_coordinator_of:
        profile = config.profiles[new_coordinator_of]
        for project in profile["projects"].values():
            make_coordinator_folder(home, profile, project)
    path = home / PROFILES_FILE
    mode = path.stat().st_mode & 0o777 if path.exists() else 0o644
    if path.exists():
        (home / f"{PROFILES_FILE}.bak").write_text(path.read_text())
    with tempfile.NamedTemporaryFile("w", dir=home, prefix=f"{PROFILES_FILE}.", suffix=".tmp", delete=False) as pending:
        pending.write(json.dumps(raw, indent=2, ensure_ascii=False) + "\n")
    os.chmod(pending.name, mode)
    os.replace(pending.name, path)
    return config

@contextlib.contextmanager
def writing(home: Path):
    try:
        import fcntl
    except ImportError:
        yield
        return
    with open(home / f"{PROFILES_FILE}.lock", "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield

def one_writer(change):
    @functools.wraps(change)
    def locked(home: Path, *args, **kwargs):
        with writing(home):
            return change(home, *args, **kwargs)
    return locked

def make_coordinator_folder(home: Path, profile: dict, project: dict) -> None:
    if not project["coordinator"]:
        return
    folder = Path(project["coordinator"]["folder"])
    if folder.exists():
        return
    folder.mkdir(parents=True)
    example = home / "coordinators/example/CLAUDE.md"
    text = example.read_text() if example.is_file() else "# {project} coordinator\n\nYou start and track tasks for {project}; you do not write the code yourself.\n"
    (folder / "CLAUDE.md").write_text(text.replace("{project}", project["label"]).replace("{profile}", profile["label"]))

def raw_profiles(raw: dict) -> dict:
    found = raw.setdefault("profiles", {})
    if not isinstance(found, dict):
        raise InvalidProfiles(["profiles: must be an object of name -> profile"])
    return found

@one_writer
def put(home: Path, name: str, profile: dict, templates: Path = TEMPLATES) -> Config:
    if not isinstance(profile, dict):
        raise InvalidProfiles([f"profiles.{name}: must be an object"])
    raw = read_raw(home)
    known = raw_profiles(raw)
    old = known.get(name) if isinstance(known.get(name), dict) else {}
    known[name] = {**{key: value for key, value in old.items() if key.startswith("//")}, **profile}
    return save(home, raw, templates, new_coordinator_of=name)

@one_writer
def remove(home: Path, name: str, templates: Path = TEMPLATES) -> Config:
    raw = read_raw(home)
    if name not in without_comments(raw_profiles(raw)):
        raise ProfileError(f"No profile {name}")
    del raw["profiles"][name]
    return save(home, raw, templates)

@one_writer
def order(home: Path, names: list, templates: Path = TEMPLATES) -> Config:
    raw = read_raw(home)
    known = raw_profiles(raw)
    if sorted(names) != sorted(without_comments(known)):
        raise ProfileError(f"order needs every profile once: {', '.join(without_comments(known))}")
    comments = {key: value for key, value in known.items() if key.startswith("//")}
    raw["profiles"] = {**comments, **{name: known[name] for name in names}}
    return save(home, raw, templates)

def portable_folder(folder: str) -> str:
    path, home = absolute_folder(folder), str(Path.home())
    return "~" + path[len(home):] if path == home or path.startswith(home + os.sep) else path

@one_writer
def assign(home: Path, kind: str, value: str, name: str, templates: Path = TEMPLATES) -> Config:
    if kind not in ("machine", "folder"):
        raise ProfileError(f"assign takes machine or folder, not {kind}")
    key, same = ("machines", str) if kind == "machine" else ("folders", absolute_folder)
    raw = read_raw(home)
    known = without_comments(raw_profiles(raw))
    if name != "-" and not isinstance(known.get(name), dict):
        raise ProfileError(f"No profile {name} (there are: {', '.join(known) or 'none'})")
    for profile in known.values():
        if isinstance(profile, dict) and isinstance(profile.get(key), list):
            profile[key] = [other for other in profile[key] if not isinstance(other, str) or same(other) != same(value)]
            if not profile[key]:
                del profile[key]
        agent_machines = profile.get("agents", {}).get("machines") if isinstance(profile, dict) and isinstance(profile.get("agents"), dict) else None
        if kind == "machine" and isinstance(agent_machines, dict):
            agent_machines.pop(value, None)
    if name != "-":
        known[name].setdefault(key, []).append(value if kind == "machine" else portable_folder(value))
    return save(home, raw, templates)

def cmd_check(config: Config, _args: list) -> None:
    for warning in [*config.warnings, *unguarded(config)]:
        print(f"warning: {warning}")
    print(f"{PROFILES_FILE}: ok ({len(config.profiles)} profile{'' if len(config.profiles) == 1 else 's'})")

def cmd_list(config: Config, _args: list) -> None:
    print(json.dumps({"profiles": config.profiles, "providers": config.providers, "warnings": config.warnings}))

def cmd_match(config: Config, args: list) -> None:
    items = json.loads(args[0])
    if not isinstance(items, list):
        raise ValueError("match takes a JSON list")
    print(json.dumps([match(config, item) for item in items]))

def cmd_current(config: Config, _args: list) -> None:
    print(json.dumps(current(config)))

def cmd_env(config: Config, args: list) -> None:
    print(json.dumps(profile_env(config, args[0])))

def cmd_run(config: Config, args: list) -> None:
    run(config, args[0], args[2:] if args[1:2] == ["--"] else args[1:])

def cmd_account(config: Config, args: list) -> None:
    found = account(config, args[0], args[1])
    if found is None:
        print(f"profiles: profile {args[0]} has no {args[1]} account", file=sys.stderr)
        sys.exit(NONE_EXIT)
    print(json.dumps(found))

def cmd_reviewer(config: Config, args: list) -> None:
    agents = profile_of(config, args[0])["agents"]
    if not agents["reviewer"]:
        print(f"profiles: profile {args[0]} uses no reviewer", file=sys.stderr)
        sys.exit(NONE_EXIT)
    if not agents["reviewerTemplate"]:
        raise ProfileError(f"No hc template in {TEMPLATES} runs {agents['reviewer']}, the reviewer of profile {args[0]}")
    print(agents["reviewerTemplate"])

def cmd_envrc(config: Config, args: list) -> None:
    print("\n".join(envrc(config, args[0])))

COMMANDS = {"check": cmd_check, "list": cmd_list, "match": cmd_match, "current": cmd_current,
            "env": cmd_env, "run": cmd_run, "account": cmd_account, "reviewer": cmd_reviewer, "envrc": cmd_envrc}

WRITES = {
    "put": lambda home, args: put(home, args[0], json.loads(args[1])),
    "remove": lambda home, args: remove(home, args[0]),
    "order": lambda home, args: order(home, args),
    "assign": lambda home, args: assign(home, args[0], args[1], args[2]),
}

def main(argv: list) -> int:
    command, *args = argv or ["--help"]
    if command not in COMMANDS and command not in WRITES:
        print(__doc__ or "")
        return 0 if command in ("--help", "-h", "help") else 2
    try:
        if command in WRITES:
            WRITES[command](app_home(), args)
        else:
            COMMANDS[command](load(app_home()), args)
    except InvalidProfiles as error:
        if command == "list":
            print(json.dumps({"errors": error.errors}))
        for line in error.errors:
            print(f"profiles: {line}", file=sys.stderr)
        return 1
    except ProfileError as error:
        print(f"profiles: {error}", file=sys.stderr)
        return 1
    except (IndexError, ValueError) as error:
        print(f"profiles: bad arguments ({error})", file=sys.stderr)
        return 2
    return 0

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
