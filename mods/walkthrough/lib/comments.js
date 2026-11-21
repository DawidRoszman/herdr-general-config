export function formatComments(comments, what, { mixed = false } = {}) {
  const items = comments.map((c) => {
    const notes = [c.kind === "-" ? "removed line" : "", mixed && c.scope === "staged" ? "staged version" : mixed && c.scope === "working" ? "unstaged version" : ""].filter(Boolean);
    const where = `${c.path}:${c.line}${notes.length ? ` (${notes.join(", ")})` : ""}`;
    const code = c.code.trim() ? ` \`${c.code.trim().slice(0, 160)}\`` : "";
    return `- ${where}${code}: ${c.text.trim()}`;
  });
  return `Comments from reading the walkthrough of ${what}\n${items.join("\n")}`;
}

export const sameSpot = (a, b) => a.sk === b.sk && a.scope === b.scope && a.path === b.path && a.line === b.line && a.kind === b.kind;

export function addComment(comments, comment) {
  return [...comments.filter((c) => !sameSpot(c, comment)), comment];
}
