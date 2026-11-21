import assert from "node:assert/strict";
import { projectOf, projectsFirst } from "./groups.js";

const projects = {
  shop: { places: [{ machine: "work-box", root: "/srv/shop" }, { machine: null, root: "/home/jane/work/shop" }] },
  blog: { places: [{ machine: null, root: "/home/jane/blog" }] },
  notes: { places: [] },
};
const of = (space) => projectOf({ machine: null, place: null, folder: null, git: null, ...space }, projects);

assert.equal(of({ place: "/home/jane/work/shop" }), "shop");
assert.equal(of({ place: "/home/jane/work/shop/api/src" }), "shop", "a folder under the root");
assert.equal(of({ place: "/home/jane/work/shopping" }), null, "a folder beside the root");
assert.equal(of({ place: "/srv/shop" }), null, "another machine's root");
assert.equal(of({ machine: "work-box", place: "/srv/shop/api" }), "shop");
assert.equal(of({ machine: "work-box", place: "/home/jane/work/shop" }), null);
assert.equal(of({ place: "/home/jane", folder: "/home/jane/blog" }), "blog", "made there, its terminal elsewhere now");
assert.equal(of({ machine: "work-box", place: "/home/jane/.herdr/projects/shop/feat-x", git: { root: "/srv/shop", repo: '["work-box","/srv/shop"]' } }), "shop", "a multirepo task");
assert.equal(of({ place: "/home/jane/blog.feature", git: { repo: '[null,"/home/jane/blog/.git"]' } }), "blog", "a git worktree elsewhere");
assert.equal(of({ place: "/home/jane/other", git: { repo: '[null,"/home/jane/other/.git"]' } }), null);
assert.equal(projectOf({ machine: null, place: "/x" }, undefined), null, "no projects");

assert.equal(of({ machine: "sandbox-x", place: "/home/dev/work", git: { root: "/home/dev/work", repo: '["sandbox-x","/home/dev/work"]', host: { machine: "work-box", project: "/srv/shop" } } }), "shop", "sandbox nests under its host's project");
assert.equal(of({ machine: "sandbox-x", place: "/home/dev/work", git: { root: "/home/dev/work", repo: '["sandbox-x","/home/dev/work"]', host: { machine: "work-box", project: "/srv/shop/api" } } }), "shop", "host root subfolder");
assert.equal(of({ machine: "sandbox-x", git: { root: "/home/dev/work", repo: '["sandbox-x","/home/dev/work"]', host: { machine: "elsewhere", project: "/srv/shop" } } }), null, "host machine has no place");

const row = (id, machine, p, tree) => ({ w: { id, machine }, p, tree });
const ids = (rows) => rows.map((r) => r.w.id).join(" ");
const rows = [row("a", null, null), row("b", null, "blog"), row("c", null, null), row("c1", null, null, "└─"), row("d", null, "shop"),
  row("e", "work-box", null), row("f", "work-box", "shop")];
assert.equal(ids(projectsFirst(rows, ["shop", "blog", "notes"])), "d b a c c1 f e", "projects first within each machine, in their order; a row's tree moves with it");
assert.equal(ids(projectsFirst(rows, [])), "a b c c1 d e f", "no projects: as it was");
assert.equal(ids(projectsFirst(projectsFirst(rows, ["shop", "blog"]), ["shop", "blog"])), "d b a c c1 f e", "sorted stays sorted");
assert.deepEqual(projectsFirst([], ["shop"]), []);

console.log("groups: ok");
