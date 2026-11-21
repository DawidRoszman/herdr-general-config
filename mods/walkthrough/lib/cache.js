import { longHash, hash } from "./hash.js";
import { VERSION, PROMPT_VERSION } from "./walkthrough.js";

export const codeKey = (files) => longHash(JSON.stringify(
  files.filter((f) => !f.generated && !f.unread).map((f) => [f.path, f.status, f.hunks.map((h) => h.id)])));

export function cacheKey({ top, source, model, language, preferences = "", files, task = "" }) {
  return longHash(JSON.stringify([VERSION, PROMPT_VERSION, top, source, model, language, hash(String(preferences).trim()), codeKey(files), ...(task ? [task] : [])]));
}

export const placeKey = (top, source) => longHash(`${top}\n${source}`);

export const deadline = (hunkCount) => Math.min(15 * 60, 120 + hunkCount) * 1000;

export const estimateTokens = (chars) => Math.ceil(chars / 3.6);

export const MAX_PROMPT_CHARS = 640_000;

export const shortKey = (text) => hash(text).slice(-6);
