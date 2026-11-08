// Atlassian Document Format (Jira's rich text) to markdown for TextView. Checked by `node board.test.mjs`.
// Unknown nodes keep their text, so nothing written in Jira is silently dropped.

function marked(text, marks = []) {
  return marks.reduce((out, mark) => {
    if (mark.type === "strong") return `**${out}**`;
    if (mark.type === "em") return `_${out}_`;
    if (mark.type === "code") return `\`${out}\``;
    if (mark.type === "strike") return `~~${out}~~`;
    if (mark.type === "link") return `[${out}](${mark.attrs?.href ?? ""})`;
    return out;
  }, text);
}

function inline(nodes = []) {
  return nodes.map((node) => {
    switch (node.type) {
      case "text": return marked(node.text ?? "", node.marks);
      case "hardBreak": return "  \n";
      case "mention": return `**${node.attrs?.text ?? "@someone"}**`;
      case "emoji": return node.attrs?.text ?? node.attrs?.shortName ?? "";
      case "inlineCard": return `<${node.attrs?.url ?? ""}>`;
      case "status": return `\`${node.attrs?.text ?? ""}\``;
      case "date": return node.attrs?.timestamp ? new Date(Number(node.attrs.timestamp)).toISOString().slice(0, 10) : "";
      default: return inline(node.content);
    }
  }).join("");
}

function block(node, indent = "") {
  const children = (separator = "\n\n") => (node.content ?? []).map((child) => block(child, indent)).filter(Boolean).join(separator);
  switch (node.type) {
    case "doc": return children();
    case "paragraph": return inline(node.content);
    case "heading": return `${"#".repeat(Math.min(6, node.attrs?.level ?? 2))} ${inline(node.content)}`;
    case "bulletList":
    case "orderedList":
      return (node.content ?? []).map((item, i) => {
        const bullet = node.type === "orderedList" ? `${(node.attrs?.order ?? 1) + i}.` : "-";
        const [first = "", ...rest] = (item.content ?? []).map((child) => block(child, `${indent}  `));
        return [`${indent}${bullet} ${first}`, ...rest].join("\n");
      }).join("\n");
    case "codeBlock": return `\`\`\`${node.attrs?.language ?? ""}\n${inline(node.content)}\n\`\`\``;
    case "blockquote":
    case "panel": return children().split("\n").map((line) => `> ${line}`).join("\n");
    case "rule": return "---";
    case "mediaSingle":
    case "mediaGroup": return "_(attachment: open in Jira)_";
    case "table":
      return (node.content ?? []).map((row, i) => {
        const cells = (row.content ?? []).map((cell) => (cell.content ?? []).map((child) => block(child)).join(" ").replaceAll("\n", " "));
        const line = `| ${cells.join(" | ")} |`;
        return i === 0 ? `${line}\n|${cells.map(() => " --- |").join("")}` : line;
      }).join("\n");
    default: return node.content ? children() : inline([node]);
  }
}

export function adfToMarkdown(doc) {
  if (!doc) return "";
  if (typeof doc === "string") return doc; // older API versions answer plain text
  return block(doc).trim();
}
