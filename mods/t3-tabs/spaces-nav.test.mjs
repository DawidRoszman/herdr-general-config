import assert from "node:assert/strict";
import { resolveSpaceTargets, pickSpaceTarget, pickAdjacentSpace } from "./spaces-nav.js";

const spaces = [
  { id: "home", active: false },
  { id: "work-coord", active: false },
  { id: "work-1", active: true },
  { id: "work-2", active: false },
  { id: "personal-1", active: false },
];

const context = {
  current: "work",
  offSpaces: ["personal-1"],
  coordinators: { "work/shop": "work-coord" },
};

const publishedRows = {
  profile: "work",
  order: [
    { kind: "coordinator", key: "work/shop" },
    { kind: "space", id: "work-2" },
    { kind: "coordinator", key: "work/blog" },
    { kind: "space", id: "work-1" },
    { kind: "space", id: "personal-1" },
    { kind: "space", id: "closed-space" },
  ],
};

const targets = resolveSpaceTargets({ spaces, homeId: "home", context, publishedRows });
assert.deepEqual(targets, [
  { kind: "coordinator", key: "work/shop" },
  { kind: "space", id: "work-2" },
  { kind: "coordinator", key: "work/blog" },
  { kind: "space", id: "work-1" },
]);

assert.deepEqual(pickSpaceTarget(targets, 1), { kind: "coordinator", key: "work/shop" });
assert.deepEqual(pickSpaceTarget(targets, 2), { kind: "space", id: "work-2" });
assert.deepEqual(pickSpaceTarget(targets, 3), { kind: "coordinator", key: "work/blog" });
assert.equal(pickSpaceTarget(targets, 5), null);
assert.equal(pickSpaceTarget(targets, 0), null);

const fallback = resolveSpaceTargets({
  spaces,
  homeId: "home",
  context,
  publishedRows: { profile: "personal", order: [{ kind: "space", id: "personal-1" }] },
});
assert.deepEqual(fallback, [
  { kind: "space", id: "work-coord" },
  { kind: "space", id: "work-1" },
  { kind: "space", id: "work-2" },
]);

assert.equal(
  pickAdjacentSpace({ targets, spaces, coordinators: context.coordinators, by: 1 })?.id,
  "work-coord",
  "wraps from last live space to first (running coordinator)"
);
assert.equal(
  pickAdjacentSpace({ targets, spaces, coordinators: context.coordinators, by: -1 })?.id,
  "work-2",
  "skips unstarted coordinator when walking backward"
);

const atHomeSpaces = spaces.map((s) => ({ ...s, active: s.id === "home" }));
assert.equal(
  pickAdjacentSpace({ targets, spaces: atHomeSpaces, coordinators: context.coordinators, by: 1 })?.id,
  "work-coord"
);
assert.equal(
  pickAdjacentSpace({ targets, spaces: atHomeSpaces, coordinators: context.coordinators, by: -1 })?.id,
  "work-1"
);

console.log("spaces-nav: ok");
