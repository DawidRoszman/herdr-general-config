# Agent Rules

## No Comments (Strict)

- NEVER write comments of any kind in code files (`.js`, `.mjs`, `.cjs`, `.ts`, `.py`, `.sh`, `.c`, etc.).
- This bans line comments (`//`, `#`), block comments (`/* ... */`), JSDoc / `@type` comments, and Python docstrings (`"""..."""`, `'''...'''`).
- The ONLY permitted exception is a line-1 executable shebang (`#!/...`).
- Write clear, self-documenting code with intention-revealing names instead of comments.
- Applies to all agents (`claude`, `codex`, `agy`, and any subagents).
