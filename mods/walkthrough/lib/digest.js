import { parseDiff } from "./hunks.js";
import { isGenerated } from "./generated.js";

export function buildDigest(sections) {
  const files = [];
  for (const section of sections) {
    for (const file of parseDiff(section.patch, section.scope, section.prefix)) files.push({ ...file, generated: isGenerated(file.path) });
  }

  const idByAlias = {};
  const digestFiles = [];
  const blocks = [];
  let n = 0;
  for (const file of files) {
    if (file.generated) continue;
    const aliases = [];
    const head = [`=== ${file.path}`, file.status !== "modified" ? `(${file.status}${file.oldPath ? ` from ${file.oldPath}` : ""})` : "",

      file.scope === "staged" || file.scope === "working" ? `[${file.scope}]` : "", file.binary ? "(binary)" : ""].filter(Boolean).join(" ");
    const body = [head];
    for (const hunk of file.hunks) {
      const alias = `h${++n}`;
      idByAlias[alias] = hunk.id;
      aliases.push(alias);
      body.push(`[${alias}] ${hunk.header}`, ...hunk.lines);
    }
    blocks.push(body.join("\n"));
    digestFiles.push({ path: file.path, aliases });
  }

  return {
    files,
    text: blocks.join("\n\n"),
    idByAlias,
    digestFiles,
    hunkCount: n,
    fileCount: digestFiles.length,
    generatedPaths: files.filter((f) => f.generated).map((f) => f.path),
  };
}
