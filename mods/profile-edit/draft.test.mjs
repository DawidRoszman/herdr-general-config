import assert from "node:assert/strict";
import { secretText, secretOf, portableFolder, toDraft, newDraft, duplicateOf, toProfile, projectLines, moved, takenMachines, errorLines } from "./draft.js";

const providers = {
  claude: { fields: { configDir: false } },
  github: { fields: { user: false } },
  jira: { fields: { site: false, email: false, token: true } },
};
const places = { appHome: "/home/jane/.config/herdr-app", home: "/home/jane" };

const listed = {
  label: "Work", badge: "Acme", color: "ansi3", machines: ["work-box"], folders: ["~/work", "~/clients"],
  projects: {
    shop: { label: "Shop", jira: ["SHOP"], places: [{ machine: "work-box", root: "/srv/shop" }, { machine: null, root: "/home/jane/work/shop" }],
      coordinator: { folder: "/home/jane/.config/herdr-app/coordinators/work" } },
    blog: { label: "Blog", jira: [], places: [], coordinator: null },
  },
  agents: { reviewer: "codex", reviewerTemplate: "reviewer", machines: {} },
  accounts: { claude: { configDir: "~/.claude-acme" }, jira: { site: "acme.atlassian.net", email: "j@acme.example", token: { env: "JIRA_TOKEN" } } },
};

const written = {
  label: "Work", badge: "Acme", color: "ansi3", machines: ["work-box"], folders: ["~/work", "~/clients"],
  projects: {
    shop: { label: "Shop", jira: ["SHOP"], places: [{ machine: "work-box", root: "/srv/shop" }, { root: "~/work/shop" }], coordinator: { folder: "coordinators/work" } },
    blog: { label: "Blog" },
  },
  agents: { reviewer: "codex" },
  accounts: { claude: { configDir: "~/.claude-acme" }, jira: { site: "acme.atlassian.net", email: "j@acme.example", token: { env: "JIRA_TOKEN" } } },
};

assert.equal(secretText({ env: "TOKEN" }), "TOKEN");
assert.equal(secretText({ command: ["pass", "show", "jira"] }), '["pass","show","jira"]');
assert.equal(secretText(null), "");
assert.deepEqual(secretOf(" TOKEN "), { env: "TOKEN" });
assert.deepEqual(secretOf('["pass", "show", "jira"]'), { command: ["pass", "show", "jira"] });
assert.equal(secretOf("  "), null);
assert.throws(() => secretOf("[pass"), /a command is a JSON list/);

assert.equal(portableFolder("/home/jane/.config/herdr-app/coordinators/work", places.appHome, places.home), "coordinators/work");
assert.equal(portableFolder("/home/jane/notes/coord", places.appHome, places.home), "~/notes/coord");
assert.equal(portableFolder("/srv/coord", places.appHome, places.home), "/srv/coord");

const draft = toDraft("work", listed, providers, places);
assert.deepEqual(draft.folders, ["~/work", "~/clients"]);
assert.equal(draft.accounts.jira.token, "JIRA_TOKEN");
assert.deepEqual(toProfile(draft, providers), written);

const odd = toDraft("work", { ...listed, folders: ["~/clients/Acme, Inc", "~/a\tb"] }, providers, places);
assert.deepEqual(toProfile({ ...odd, label: "Renamed" }, providers).folders, ["~/clients/Acme, Inc", "~/a\tb"]);
assert.deepEqual(toProfile({ ...odd, folders: ["  ~/x ", "", "  "] }, providers).folders, ["~/x"]);
assert.equal("folders" in toProfile({ ...odd, folders: [""] }, providers), false);

const bare = toDraft("personal", { label: "Personal", badge: "Personal", color: null, machines: [], folders: [], projects: {},
  agents: { reviewer: null, reviewerTemplate: null, machines: {} }, accounts: { claude: { configDir: null } } }, providers, places);
assert.equal(bare.badge, "");
assert.deepEqual(toProfile(bare, providers), { label: "Personal", accounts: { claude: { configDir: null } } });
assert.deepEqual(toProfile({ ...newDraft(), label: " Side " }, providers), { label: "Side" });

assert.equal("agents" in toProfile({ ...draft, reviewer: "" }, providers), false);
assert.deepEqual(toProfile({ ...newDraft(), label: "S", reviewer: "claude" }, providers).agents, { reviewer: "claude" });
assert.deepEqual(toProfile({ ...newDraft(), label: "S", accounts: { jira: { site: "s", email: "", token: "" } } }, providers).accounts,
  { jira: { site: "s", email: null, token: null } });

const copy = duplicateOf(draft);
assert.deepEqual([copy.isNew, copy.name, copy.label, copy.machines, copy.folders, copy.projects], [true, "", "Work copy", [], [], {}]);
assert.deepEqual(projectLines(draft.projects), ["Shop · SHOP · work-box, this computer · coordinator", "Blog · no coordinator"]);
assert.deepEqual(copy.accounts, draft.accounts);
copy.accounts.claude.configDir = "changed";
assert.equal(draft.accounts.claude.configDir, "~/.claude-acme", "a copy doesn't share its accounts");

assert.deepEqual(moved(["a", "b", "c"], "a", 1), ["b", "a", "c"]);
assert.deepEqual(moved(["a", "b", "c"], "c", -1), ["a", "c", "b"]);
assert.deepEqual(moved(["a", "b", "c"], "a", -1), ["a", "b", "c"]);
assert.deepEqual(moved(["a", "b", "c"], "c", 1), ["a", "b", "c"]);

assert.deepEqual(takenMachines({ work: { label: "Work", machines: ["w"] }, personal: { label: "Personal", machines: ["p", "q"] } }, "work"), { p: "Personal", q: "Personal" });

assert.deepEqual(errorLines("profiles: profiles.work.label: needed, a text\nprofiles: profiles.work.machines: home-box is also in profile personal\n", "work"),
  ["label: needed, a text", "machines: home-box is also in profile personal"]);

const held = toDraft("work", { ...listed, agents: { ...listed.agents, machines: { local: [], "work-box": ["claude", "codex"] } } }, providers, places);
assert.deepEqual(toProfile(held, providers).agents.machines, { local: [], "work-box": ["claude", "codex"] });
held.agentMachines["work-box"].pop();
assert.deepEqual(toProfile(held, providers).agents.machines, { local: [], "work-box": ["claude"] });
assert.equal("machines" in toProfile(draft, providers).agents, false, "no rule: nothing written");

assert.deepEqual(toProfile({ ...held, machines: [] }, providers).agents.machines, { local: [] });
assert.deepEqual(duplicateOf(held).agentMachines, { local: [] });
duplicateOf(held).agentMachines.local.push("claude");
assert.deepEqual(held.agentMachines.local, [], "a copy doesn't share its rules");

console.log("draft: ok");
