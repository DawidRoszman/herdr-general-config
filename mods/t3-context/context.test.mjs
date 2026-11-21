import assert from "node:assert/strict";
import { machineProfiles, sandboxHosts, shownProfile, coordinatorKey, liveCoordinators, spaceContext, agentContext, offContext } from "./context.js";

const profiles = {
  work: { machines: ["work-box"], projects: { shop: { coordinator: { folder: "/c/shop" } }, blog: { coordinator: null } } },
  personal: { machines: ["home-box", "laptop"], projects: { general: { coordinator: { folder: "/c/general" } } } },
  client: { machines: [], projects: {} },
};
const names = Object.keys(profiles);
const saved = { "work/shop": "s-coord-shop", "personal/general": "s-coord-personal", "work/blog": "s-coord-blog", "gone/x": "s-coord-gone", work: "s-coord-old" };
const coordinators = liveCoordinators(saved, profiles);
assert.equal(coordinatorKey("work", "shop"), "work/shop");
assert.deepEqual(coordinators, { "work/shop": "s-coord-shop", "personal/general": "s-coord-personal" },
  "a removed profile's, a project without a coordinator and a profile's own (before projects) are plain spaces");

assert.deepEqual(machineProfiles(profiles), { "work-box": "work", "home-box": "personal", laptop: "personal" });
assert.deepEqual(machineProfiles({}), {});

const hcMachines = [
  { name: "work-box", target: "work-box", via: false },
  { name: "shop-135", target: "'/app/scripts/sandbox-via.sh' 'work-box' 'shop-135'", via: true },
  { name: "orphan", target: "'/app/scripts/sandbox-via.sh' 'gone-box' 'orphan'", via: true },
  { name: "wsl", target: "wsl.exe -d Ubuntu -e sh -c", via: true },
];
assert.deepEqual(sandboxHosts(hcMachines), { "shop-135": "work-box" });
assert.deepEqual(machineProfiles(profiles, sandboxHosts(hcMachines))["shop-135"], "work");
assert.equal(machineProfiles(profiles, { "x-1": "shared-box" })["x-1"], undefined, "a sandbox of a shared machine is shared too");

assert.equal(shownProfile("personal", names), "personal");
assert.equal(shownProfile("gone", names), "work", "a profile that no longer exists: the first");
assert.equal(shownProfile(null, names), "work");
assert.equal(shownProfile("work", []), null);

const space = (id) => ({ id });
assert.equal(spaceContext({ space: space("s-coord-personal"), coordinators, matched: "work" }), "personal");
assert.equal(spaceContext({ space: space("s-coord-shop"), coordinators, matched: null }), "work");
assert.equal(spaceContext({ space: space("s1"), coordinators, matched: "client" }), "client");
assert.equal(spaceContext({ space: space("s2"), coordinators, matched: null }), null);
assert.equal(spaceContext({ space: space("s3"), coordinators, matched: undefined }), null);
assert.equal(spaceContext({ space: space("s-coord-gone"), coordinators, matched: undefined }), null, "a removed profile's coordinator is a plain space");

assert.equal(agentContext({ matched: "work", spaceProfile: "personal" }), "work");
assert.equal(agentContext({ matched: null, spaceProfile: "personal" }), "personal");
assert.equal(agentContext({ matched: undefined, spaceProfile: null }), null);

assert.deepEqual(offContext({ a: "work", b: "personal", c: null, d: "client" }, "work"), ["b", "d"]);

console.log("context: ok");
