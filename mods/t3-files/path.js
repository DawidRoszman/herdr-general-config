export function parentOf(folder) {
  const trimmed = folder.replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (cut < 0) return null;
  const parent = trimmed.slice(0, cut);
  if (parent === "") return "/";
  return /^[A-Za-z]:$/.test(parent) ? `${parent}\\` : parent;
}
