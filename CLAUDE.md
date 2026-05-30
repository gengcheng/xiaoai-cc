# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`xiaoai-cc` is a self-contained Node/TypeScript app that bridges a Xiaomi "小爱" (XiaoAi) speaker to the Claude Code CLI. Say a trigger phrase to the speaker; the app polls Xiaomi's cloud for the conversation record, runs `claude -p`, and pushes the answer back as TTS so the speaker reads it aloud in its own voice. No Docker, DB, or browser — only Xiaomi's official cloud + the local `claude` binary.

End-to-end flow (see `src/main.ts`):
```
speech → Xiaomi cloud conversation log
  → poll every POLL_INTERVAL_MS (conversation/monitor.ts)
    → trigger word match (main.ts matchTrigger) → claude -p (claude.ts)
      → mina player_play_tts (mina/client.ts) → speaker speaks the answer
```

## Commands

```bash
npm run build      # esbuild-bundle src/main.ts → dist/app.js (ESM, node20 target)
npm start          # run dist/app.js (requires build first)
npm run dev        # run from source, no build (node --experimental-strip-types, needs Node ≥23)
npm run typecheck  # tsc --noEmit
```

There is **no test suite, linter, or CI**. `npm run typecheck` is the only static check; `tsconfig.json` is non-strict (`strict: false`, `noImplicitAny: false`) and `noEmit` (esbuild does the actual bundling).

During development prefer `npm run dev` for a fast edit-run loop; only `build` when validating the shipped bundle. The README's `cd app` is stale — the project root *is* the app.

## Architecture

Two layers, do not blur them:

- **App glue (hand-written, the part you usually edit):** `main.ts` (orchestration), `config.ts` (config schema + loading), `claude.ts` (spawns `claude -p`), `shim.ts` (host shim).
- **Xiaomi stack (mostly leave alone):** `mina/*`, `auth/*`, `qrcode/*`, `conversation/monitor.ts`, `account/manager.ts`, `config/manager.ts`. They handle Xiaomi QR login, token lifecycle, device list, conversation polling, and TTS.

### The `host` global shim (critical)
The Xiaomi-stack modules call `host.log.*` and `host.storage.*` as host-provided globals. `src/shim.ts` installs a `globalThis.host` that maps logging → console and storage → a local JSON file. **`import './shim'` must be the very first import in `main.ts`** (before any of those modules load), or they crash on the missing global. When adding a module that uses other `host.*` capabilities, extend the shim.

### Config layering (`src/config.ts`)
`DEFAULTS` in code, shallow-merged with an optional `config.local.json` at the run-cwd (override the path via the `XIAOAI_CONFIG` env var; data dir via `XIAOAI_DATA_DIR`). Users tune behavior via `config.local.json` **without editing code or rebuilding** — only keys present in the JSON override defaults. Key fields: `TRIGGERS`, `CLAUDE_MODEL` (default `haiku` — fast/cheap for voice), `CLAUDE_BIN`/`CLAUDE_WORKDIR`, `POLL_INTERVAL_MS` (default 1s, the practical cloud-poll ceiling), and the `SKILL_*` group.

### Trigger rules
A `TriggerRule` is `{ keywords: string[]; skill?: string }`. `matchTrigger` (main.ts) does substring matching and picks the **most specific** match (longest keyword wins; ties broken by earliest position), so long and short keywords can coexist. Text after the keyword becomes the argument/question.
- **With `skill`:** runs that Claude skill non-interactively. Headless mode can't use `/skill`, so `claude.ts` triggers it via a natural-language instruction + `--permission-mode bypassPermissions` + `--allowedTools` (voice has no human to approve prompts).
- **Without `skill`:** plain Q&A; `SPOKEN_STYLE` is prepended to constrain the answer to spoken-style, no-Markdown.

### Spawning `claude` (`src/claude.ts`)
`cleanEnv()` strips `CLAUDECODE`, `CLAUDE_CODE_*`, `AI_AGENT`, etc. from the child env. Without this, launching the app from inside a Claude Code terminal makes the spawned `claude` inherit nested-session markers and hit a 403 "Request not allowed". Keep this stripping intact.

## Data & secrets
- Login state (serviceToken / passToken / device config) lives in `data/store.json`, written by the shim's storage. `data/` is **gitignored** — never commit it. Deleting `data/` = logout + reset.
- serviceToken lasts ~12h; `auth/service.ts` auto-refreshes via passToken on a timer. Long offline → re-scan the QR.
- On first run the app prints a Xiaomi login QR link and (macOS) auto-opens the QR image; scan with the 米家/小米 app.

## Logging
Vendored modules are noisy. `shim.ts` silences their `info` logs unless `XIAOAI_VERBOSE=1` or `DEBUG=1`; `warn`/`error` always print. The app's own key logs go through `console.log` directly and are unaffected.
