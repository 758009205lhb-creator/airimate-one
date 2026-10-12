# AGENTS.md

## Project

AiriMate One is a private Windows Electron desktop companion built from an
npm-workspace monorepo.

- Root: `F:\deepseek harness\AI女友\新工程`
- Package manager: npm (`package-lock.json`)
- Language: TypeScript and Vue
- Runtime: Electron with a Windows SAPI TTS adapter

## Commands

- Build all application artifacts: `npm run build`
- Build and verify the distribution payload: `npm run build:dist`
- Scan an assembled payload: `node tools/qa/scan-dist-payload.mjs`
- Verify payload hashes: `node tools/qa/verify-dist-integrity.mjs`
- Install the local payload: `tools/runtime/install-airimate.ps1`

## Architecture

- `apps/desktop`: Electron main process and preload bridge.
- `apps/renderer`: Vue renderer and avatar presentation.
- `packages/shared`: shared contracts and zod schemas.
- `packages/security`: path, secret, and logging safety helpers.
- `packages/companion-kit`: adapter framework and capability contracts.
- `tools/qa`: explicit payload assembly, scanning, and integrity checks.
- `tools/runtime`: local installation and launch helpers.

## Release Rules

- `tools/qa/stage-dist.mjs` is the source of truth for distribution contents.
- Runtime dependencies must be listed explicitly; never copy the full workspace
  `node_modules` tree into `dist-package`.
- A development-tree run is not sufficient validation. Verify the installed copy
  can resolve every runtime dependency after it leaves the source tree.
- Never include private VRM, VRMA, or Mate Engine assets in a distributable
  payload unless the license is explicitly changed.
- Do not store credentials or secret values in source, logs, manifests, or
  memory files.

## Verification

Before reporting a distribution fix as complete:

1. Run `node tools/qa/stage-dist.mjs --clean --with-runtime`.
2. Run `node tools/qa/scan-dist-payload.mjs`.
3. Run `node tools/qa/verify-dist-integrity.mjs`.
4. Launch the installed copy from `%LOCALAPPDATA%\Programs\AiriMateOne`.
5. Confirm the main process stays alive without a missing-module error.
