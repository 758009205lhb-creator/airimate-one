# MEMORY.md

## Project Context

- AiriMate One is a private self-use Electron desktop companion.
- The development tree runs from `F:\deepseek harness\AI女友\新工程`.
- The installed copy runs from
  `C:\Users\shiqian\AppData\Local\Programs\AiriMateOne`.
- Character and motion assets remain local and are not part of the public
  payload.

## Architecture Decisions

- `dist-package` is assembled from an explicit allowlist in
  `tools/qa/stage-dist.mjs`.
- Workspace packages are shipped under `app/node_modules/@airimate`.
- Third-party runtime dependencies are shipped individually under
  `app/node_modules`; the full dependency tree is never copied.
- `tools/runtime/install-airimate.ps1` patches workspace package manifests and
  probes runtime module resolution after installation.

## Known Pitfalls

- A development-tree run can resolve a dependency from the monorepo root even
  when that dependency is absent from the installed payload.
- `@airimate/shared` imports `zod` at runtime. On 2026-10-10, `zod` was omitted
  from the installed payload, causing `ERR_MODULE_NOT_FOUND` in the Electron
  main process after the app was launched from `%LOCALAPPDATA%`.
- Renderer crashes alone are not enough to identify a missing main-process
  dependency; inspect both the Electron error dialog and
  `%APPDATA%\AiriMateOne\logs\airimate-YYYY-MM-DD.jsonl`.
