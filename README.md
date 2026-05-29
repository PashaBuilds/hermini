# Hermini

> meet Hermini: a tiny Hermes agent that lives on your Mac desktop.
>
> _chatbots live in tabs. agents should live on your desktop._

Hermini is a local macOS desktop companion for Hermes. A small glowing
Hermes mascot walks above your Dock, watches your local cron output, and
turns fresh signals into a tiny speech bubble or an expanded glass panel.

It is intentionally local-first: Hermini does not post to X, Telegram, or
any external service, and it does not modify your `~/.hermes` state. It
reads `~/.hermes/cron/output/**/*.md`, distills the freshest useful signal,
and renders it on your desktop.

## Stack

- Electron 33 for the transparent always-on-top desktop strip
- Vite + React 18 + TypeScript for the renderer
- Plain CSS for the mascot layout, glass panel, glow, and motion
- A Node scanner that turns Hermes cron output into `data/current-signal.json`
- Transparent WebM mascot video for smooth walking

```text
electron/main.cjs           transparent window, IPC handlers, signal cache
electron/preload.cjs        safe bridge -> window.tinyHermes
scripts/refresh-signal.mjs  cron output -> current-signal.json
src/App.tsx                 multi-agent state, bubbles, expanded panels
src/Mascot.tsx              transparent video mascot playback
src/styles.css              desktop strip, glow, panel, motion styling
src/types.ts                Signal types, kind themes, bridge typing
data/sample-signal.json     fallback signal shipped with the app
```

## Install

```bash
npm install
```

## Run

```bash
npm run start
```

This refreshes the local signal, builds the renderer, and launches the
Electron desktop strip.

For hot reload:

```bash
npm run dev
```

For checks:

```bash
npm run typecheck
npm run build
```

## Signal Pipeline

1. `scripts/refresh-signal.mjs` scans the newest Hermes cron markdown files.
2. Silent/no-op outputs are skipped.
3. Meaningful outputs are classified into agent kinds:
   `x-radar`, `ai-radar`, `wiki`, `system`, or `generic`.
4. The freshest useful signal is written to `data/current-signal.json`.
5. The renderer reads `byKind[kind]` for each mascot, so every agent gets its
   own current bubble and detail panel.

## Desktop Experience

- Four small Hermes agents live along the bottom of the screen.
- The active agent brightens, walks, and shows a short speech bubble.
- Clicking a bubble opens a compact dark-glass detail panel with source,
  summary, timestamp, and trimmed raw output.
- Clicking another mascot switches to that agent's own latest signal.
- Mascot walking uses a transparent WebM loop, so the legs keep moving while
  the body translates and stop when the mascot is idle.

## Local-Only Boundaries

Hermini is a desktop viewer over local Hermes output. It does not:

- send cron content to a server
- post to social platforms
- write into `~/.hermes`
- require hosted infrastructure

Generated files such as `data/current-signal.json`, local demo recordings, and
build outputs are intentionally ignored by git.

## Current Limitations

- macOS only for now.
- Run-from-source; packaging with `electron-builder` is still pending.
- The transparent Electron strip is visually fragile for screen recordings
  unless the desktop background is staged cleanly.
- Position persistence and multi-monitor placement are planned follow-ups.

## Attribution

The transparent walking-video approach is inspired by
[lil-agents](https://github.com/ryanstephen/lil-agents) by Ryan Stephen
(MIT). Hermini's mascot video/assets are project-specific generated assets.
