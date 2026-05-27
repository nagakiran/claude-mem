# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Claude-mem is a Claude Code plugin providing persistent memory across sessions. It captures tool usage, compresses observations using the Claude Agent SDK, and injects relevant context into future sessions.

## Build & Development Commands

```bash
npm run build-and-sync        # Build, sync to marketplace, restart worker (primary dev command)
npm run build                 # Build only (no sync/restart)
npm run typecheck             # Type-check all source including viewer
npm run typecheck:root        # Type-check src/ only (excludes viewer)
npm test                      # Run all tests via bun test
npm run test:sqlite           # Run SQLite tests only
npm run test:agents           # Run agent tests only
npm run test:search           # Run search tests only
npm run test:context          # Run context tests only
npm run test:server           # Run server tests only
npm run worker:start          # Start the worker daemon
npm run worker:restart        # Restart the worker daemon
npm run worker:status         # Check worker status
npm run worker:logs           # View today's worker logs
npm run worker:tail           # Tail worker logs live
npm run strip-comments:check  # Check for comments that should be stripped
```

## Architecture

**6 Lifecycle Hooks**: Setup → SessionStart → UserPromptSubmit → PreToolUse (Read) → PostToolUse → Stop

Each hook dispatches to the unified worker via `bun-runner.js` → `plugin/scripts/worker-service.cjs` (bundled CJS, built from `src/services/worker-service.ts` via `scripts/build-hooks.js`). Hook subcommands: `context`, `session-init`, `observation`, `file-context`, `summarize`. The Setup-phase `version-check.js` is the only standalone hook script.

**Worker Service** (`src/services/worker-service.ts`) — Express HTTP server on per-user port (`37700 + (uid % 100)`, override with `CLAUDE_MEM_WORKER_PORT`). Managed by Bun as a daemon. Handles all AI processing asynchronously.

**Worker HTTP API** (`src/services/worker/http/routes/`) — Route handlers organized by feature:
- `SessionRoutes.ts` — Session lifecycle (init, observations, summarize, complete)
- `DataRoutes.ts` — Data retrieval (observations, summaries, prompts, stats, projects)
- `SearchRoutes.ts` — Search/MCP proxy (unified search, timeline, decisions, changes)
- `SettingsRoutes.ts` — Settings CRUD, MCP toggle, branch switching
- `ViewerRoutes.ts` — Health check (`GET /health`), viewer UI, SSE stream (`GET /stream`)

**AI Providers** (`src/services/worker/`) — `ClaudeProvider.ts`, `GeminiProvider.ts`, `OpenRouterProvider.ts`. Selected via `CLAUDE_MEM_PROVIDER` setting. Tier routing splits simple vs. summary tasks to different models.

**Database** (`src/services/sqlite/`) — SQLite3 at `~/.claude-mem/claude-mem.db`. Tables: sessions, observations, summaries, prompts, timeline.

**Chroma** (`src/services/sync/ChromaSync.ts`) — Optional vector embeddings for semantic search, managed via `ChromaMcpManager.ts`.

**MCP Server** (`src/servers/mcp-server.ts`) — Exposes search tools via MCP protocol; worker proxies search requests to it.

**Server Beta** (`src/server/`) — Optional server-mode variant with BetterAuth API keys, BullMQ queue, PostgreSQL support, and additional routes in `src/server/routes/v1/`.

**Viewer UI** (`src/ui/viewer/`) — React 19 interface built to `plugin/ui/viewer.html`, served by the worker.

**Skills** (`plugin/skills/`) — Markdown-driven orchestrator instructions for user-invocable slash commands: `mem-search`, `make-plan`, `do`, `learn-codebase`, `knowledge-agent`, `timeline-report`, etc.

## Build Pipeline

`scripts/build-hooks.js` uses esbuild to bundle four entry points into `plugin/scripts/`:
- `worker-service.cjs` (from `src/services/worker-service.ts`)
- `mcp-server.cjs` (from `src/servers/mcp-server.ts`)
- `context-generator.cjs` (from `src/services/context-generator.ts`)
- `server-beta-service.cjs` (from `src/server/runtime/ServerBetaService.ts`)

`scripts/sync-plugin-manifests.js` copies version and metadata into nested `package.json` files before the esbuild step. `scripts/sync-marketplace.cjs` copies the built plugin to `~/.claude/plugins/marketplaces/thedotmack/`.

## Privacy Tags
`<private>content</private>` — prevents storage. Stripping happens at hook layer before data reaches the worker. See `src/utils/tag-stripping.ts`.

## Exit Code Strategy

- **Exit 0**: Success (also used for worker errors to prevent Windows Terminal tab accumulation)
- **Exit 1**: Non-blocking error (stderr shown to user, continues)
- **Exit 2**: Blocking error (stderr fed to Claude for processing)

## Configuration

Settings at `~/.claude-mem/settings.json` (auto-created). Key env vars controlling all paths and ports:
- `CLAUDE_MEM_DATA_DIR` — override data directory (default `~/.claude-mem`)
- `CLAUDE_MEM_WORKER_PORT` — override worker port (default `37700 + (uid % 100)`)

See `src/shared/SettingsDefaultsManager.ts` for the full list of configurable keys.

## Multi-account

Set `CLAUDE_MEM_DATA_DIR` per shell to isolate profiles. All hooks, CLI, and skills honor these env vars.

## File Locations

- **Source**: `src/`
- **Built Plugin**: `plugin/`
- **Installed Plugin**: `~/.claude/plugins/marketplaces/thedotmack/`
- **Database**: `~/.claude-mem/claude-mem.db`
- **Chroma**: `~/.claude-mem/chroma/`
- **Logs**: `~/.claude-mem/logs/worker-YYYY-MM-DD.log`

## Requirements

- **Bun** (auto-installed if missing)
- **uv** (auto-installed if missing, provides Python for Chroma)
- Node.js ≥ 20

## Documentation

**Public Docs**: https://docs.claude-mem.ai (Mintlify)
**Source**: `docs/public/` — MDX files, `docs.json` for navigation
**Deploy**: Auto-deploys from GitHub on push to main

## Pro Features Architecture

The open-source core exposes all local worker HTTP API endpoints unchanged. Pro features (external, coming soon) add enhanced UI and additional tools that connect to the same endpoints. Access is gated by license validation, not by modifying core endpoints.

## Important

- Changelog is generated automatically — never edit it manually (`scripts/generate-changelog.js`).
- Tests use Bun's built-in test runner (`bun test`), configured with `smol = true` in `bunfig.toml`.
- The viewer (`src/ui/viewer/`) has its own `tsconfig.json` and is excluded from the root TypeScript project.

## Daily Maintenance

Run a daily version check across all package manifests and upgrade every dependency to its latest version — including major version bumps. Staying on the latest is the goal; do not skip majors.

- Check `package.json` (root) and all nested `package.json` files (e.g. `plugin/`, `openclaw/`) for outdated dependencies via `npm outdated`.
- Upgrade every package to `latest` (use `npm install <pkg>@latest` for each, or `npx npm-check-updates -u && npm install`). Bump majors too.
- Run `npm audit fix` to resolve advisories.
- After upgrades, run `npm run build-and-sync` and verify the worker starts and tests pass. Fix any breakage caused by major bumps in the same change.
- Commit the updated `package.json` and `package-lock.json` files.
