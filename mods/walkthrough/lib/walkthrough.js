export const VERSION = 1;

export const PROMPT_VERSION = 1;

export const LIMITS = { parts: 6, steps: 16, hunksPerStep: 14, partTitle: 28, notes: 6, notesPerStep: 2, skipped: 200, asks: 12, askText: 200 };
export const WEIGHTS = ["key", "normal", "skim"];
export const NOTE_KINDS = ["choice", "upkeep", "gap", "divergence", "untested"];

export const COVERAGE = ["seen", "partly", "absent"];

const str = { type: "string" };
export const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "summary", "parts", "skipped"],
  properties: {
    title: str,
    summary: str,
    parts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "blurb", "steps"],
        properties: {
          title: str,
          blurb: str,
          steps: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["title", "hunks", "weight", "text", "notes"],
              properties: {
                title: str,
                hunks: { type: "array", items: str },
                weight: { type: "string", enum: WEIGHTS },
                text: str,
                notes: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["kind", "text"],
                    properties: { kind: { type: "string", enum: NOTE_KINDS }, text: str },
                  },
                },
              },
            },
          },
        },
      },
    },
    skipped: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["path", "note"], properties: { path: str, note: str } },
    },
  },
};

export function schemaFor(withTask) {
  if (!withTask) return SCHEMA;
  return {
    ...SCHEMA,
    required: [...SCHEMA.required, "asks"],
    properties: {
      ...SCHEMA.properties,
      asks: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["text", "hunks", "coverage"],
          properties: { text: str, hunks: { type: "array", items: str }, coverage: { type: "string", enum: COVERAGE } },
        },
      },
    },
  };
}

const text = (value, max = 0) => {
  if (typeof value !== "string") return "";
  const t = value.trim();
  return max && t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

const fail = (message) => Object.assign(new Error(message), { code: "invalid" });

const idOf = (idByAlias, alias) => idByAlias[typeof alias === "string" ? alias.trim().replace(/^\[|\]$/g, "") : ""];

export function normalize(raw, idByAlias, digestFiles = [], { asks: withTask = false } = {}) {
  if (!raw || typeof raw !== "object") throw fail("The model returned no walkthrough.");
  const used = new Set();
  let steps = 0, notes = 0, dropped = 0;
  const parts = [];

  for (const rawPart of Array.isArray(raw.parts) ? raw.parts : []) {
    if (parts.length >= LIMITS.parts) break;
    if (!rawPart || typeof rawPart !== "object") continue;
    const partSteps = [];
    for (const rawStep of Array.isArray(rawPart.steps) ? rawPart.steps : []) {
      if (steps >= LIMITS.steps) break;
      if (!rawStep || typeof rawStep !== "object") continue;
      const hunkIds = [];
      for (const alias of Array.isArray(rawStep.hunks) ? rawStep.hunks : []) {
        const id = idOf(idByAlias, alias);
        if (!id) { dropped++; continue; }

        if (used.has(id) || hunkIds.includes(id) || hunkIds.length >= LIMITS.hunksPerStep) continue;
        hunkIds.push(id);
      }
      const body = text(rawStep.text);

      if (!hunkIds.length || !body) continue;
      for (const id of hunkIds) used.add(id);
      const stepNotes = [];
      for (const n of Array.isArray(rawStep.notes) ? rawStep.notes : []) {
        if (stepNotes.length >= LIMITS.notesPerStep || notes >= LIMITS.notes) break;
        const t = text(n?.text);
        if (!t || !NOTE_KINDS.includes(n.kind)) continue;
        stepNotes.push({ kind: n.kind, text: t });
        notes++;
      }
      steps++;
      partSteps.push({
        id: `s${steps}`,
        title: text(rawStep.title, 120) || `Step ${steps}`,
        weight: WEIGHTS.includes(rawStep.weight) ? rawStep.weight : "normal",
        text: body,
        notes: stepNotes,
        hunkIds,
      });
    }
    if (!partSteps.length) continue;
    parts.push({ title: text(rawPart.title, LIMITS.partTitle) || `Part ${parts.length + 1}`, blurb: text(rawPart.blurb), steps: partSteps });
  }
  if (!parts.length) throw fail("The model's answer had no usable steps for this diff.");

  const leftOut = new Set(digestFiles.filter((f) => f.aliases.some((a) => !used.has(idByAlias[a]))).map((f) => f.path));
  const skipped = [];
  const noted = new Set();
  for (const s of Array.isArray(raw.skipped) ? raw.skipped : []) {
    if (skipped.length >= LIMITS.skipped) break;
    const path = text(s?.path), note = text(s?.note, 200);
    if (!note || !leftOut.has(path) || noted.has(path)) continue;
    noted.add(path);
    skipped.push({ path, note });
  }

  const asks = withTask ? normalizeAsks(raw.asks, idByAlias) : null;
  return { title: text(raw.title, 140) || "Walkthrough", summary: text(raw.summary), parts, skipped, dropped, asks };
}

function normalizeAsks(rawAsks, idByAlias) {
  const asks = [];
  for (const a of Array.isArray(rawAsks) ? rawAsks : []) {
    if (asks.length >= LIMITS.asks) break;
    const body = text(a?.text, LIMITS.askText);
    if (!body) continue;
    const hunkIds = [];
    for (const alias of Array.isArray(a.hunks) ? a.hunks : []) {
      const id = idOf(idByAlias, alias);
      if (id && !hunkIds.includes(id)) hunkIds.push(id);
    }
    const said = COVERAGE.includes(a.coverage) ? a.coverage : "seen";
    const coverage = !hunkIds.length ? "absent" : said === "absent" ? "partly" : said;
    asks.push({ id: `a${asks.length + 1}`, text: body, coverage, hunkIds });
  }
  return asks;
}

export function overlayAsks(asks, view) {
  if (!Array.isArray(asks)) return null;
  const stepOf = new Map();
  for (const s of view.steps) for (const f of s.found) stepOf.set(f.hunk.id, s);
  const current = new Set(stepOf.keys());
  for (const u of view.uncovered) for (const h of u.hunks) current.add(h.id);
  const tied = new Set();
  const list = asks.map((a) => {
    const steps = [];
    let tail = 0, missing = 0;
    for (const id of a.hunkIds) {
      const s = stepOf.get(id);
      if (s) { tied.add(s.id); if (!steps.includes(s)) steps.push(s); } else if (current.has(id)) tail++; else missing++;
    }
    steps.sort((x, y) => x.position - y.position);
    return { ...a, steps, tail, missing, outdated: missing > 0 };
  });

  const outside = asks.length ? view.steps.filter((s) => !tied.has(s.id)) : [];
  const met = list.filter((a) => a.coverage !== "absent").length;
  return { asks: list, outside, met, total: list.length };
}

export const asksOf = (task, step) => (task ? task.asks.filter((a) => a.steps.includes(step)) : []);

export function parseJson(answer) {
  if (answer && typeof answer === "object") return answer;
  const t = String(answer ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  if (!t) throw fail("The model's answer was empty.");
  try { return JSON.parse(t); } catch {  }
  const start = t.indexOf("{");
  for (let end = t.lastIndexOf("}"); start !== -1 && end > start; end = t.lastIndexOf("}", end - 1)) {
    try { return JSON.parse(t.slice(start, end + 1)); } catch {  }
  }
  throw fail("The model's answer was not JSON.");
}

export function overlay(walkthrough, files) {
  const index = new Map();
  for (const f of files) for (const h of f.hunks) index.set(h.id, { hunk: h, file: f });
  const covered = new Set();
  const steps = [];
  const parts = walkthrough.parts.map((part, p) => ({
    ...part,
    steps: part.steps.map((step) => {
      const found = [], missing = [];
      for (const id of step.hunkIds) {
        const hit = index.get(id);
        if (hit) { found.push(hit); covered.add(id); } else missing.push(id);
      }
      const view = { ...step, part: p, position: steps.length + 1, found, missing: missing.length, outdated: missing.length > 0 };
      steps.push(view);
      return view;
    }),
  }));
  const notes = new Map(walkthrough.skipped.map((s) => [s.path, s.note]));
  const uncovered = files
    .map((f) => ({ file: f, hunks: f.hunks.filter((h) => !covered.has(h.id)) }))

    .filter(({ file, hunks }) => hunks.length > 0 || file.hunks.length === 0)
    .map(({ file, hunks }) => ({
      file, hunks,
      note: notes.get(file.path) ?? (file.status === "conflicted" ? "Merge conflict: not read. Resolve it, and it is read again."
        : file.generated ? "Generated file, not sent to the model." : file.binary ? "Binary file." : ""),
    }));
  return { parts, steps, uncovered, outdated: steps.filter((s) => s.outdated).length };
}

export function fileTotals(found) {
  const by = new Map();
  for (const { hunk, file } of found) {
    const t = by.get(file.path) ?? { path: file.path, added: 0, deleted: 0 };
    t.added += hunk.added;
    t.deleted += hunk.deleted;
    by.set(file.path, t);
  }
  return [...by.values()];
}
