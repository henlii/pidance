<div align="center">
  <img src="./docs/assets/pidance-banner.png" alt="Pidance — Move with Pi" width="760">
  <p><strong>Let Pi sessions, tools, and project workflows move naturally in the browser.</strong></p>
  <p>
    <a href="./README.md">简体中文</a> ·
    <a href="https://github.com/henlii/pidance/issues">Issues</a> ·
    <a href="./docs/release.md">Release guide</a>
  </p>
</div>

Pidance is an open-source web client for the [Pi](https://github.com/badlogic/pi-mono) coding agent. It reads local Pi session files directly and preserves Pi SDK session and runtime semantics, bringing live chat, project files, Git, worktrees, subagents, and configuration into one browser workspace. Pi remains the source of truth for data and execution semantics; Pidance provides a clearer and more complete interface.

> Current version: `0.2.15` · npm package: `@henlii/pidance` · CLI: `pidance`

## Preview

![Pidance new-session workspace](./docs/screenshots/desktop.png)

<p align="center"><sub>New-session workspace with project and worktree selectors, model controls, and contextual side panels. The path shown is anonymized.</sub></p>

![Pidance appearance settings](./docs/screenshots/settings.png)

<p align="center"><sub>Appearance settings with Light, Dark, System, Chamber, and Fusion options.</sub></p>

## Features

- **Project-oriented sessions**: browse a Project → Worktree → Session tree with search, recent sessions, archive/restore, rename, automatic titles, and HTML export.
- **Live agent chat**: stream responses, thinking, tool calls, ANSI terminal output, compaction, and running state over SSE, with reconciliation after reconnects.
- **Safe exploration**: continue from an earlier message, create an in-session branch, or fork to an independent `.jsonl` session without conflating those semantics.
- **Project workspace**: browse and preview source, Markdown, images, audio, PDFs, and DOCX; search files, use `@` mentions, and inspect Git status and diffs.
- **Git worktree workflow**: select, create, and remove worktrees in the UI while new sessions and the file workspace follow the chosen checkout.
- **Pi ecosystem integration**: inspect synchronous and asynchronous subagent run status, interact with generic extension UI cards, and view read-only projections of structured todos.
- **Central configuration**: manage provider authentication, API keys, models and model tests, session defaults, skills, plugins, and project trust.
- **Polished interface**: responsive desktop/mobile layouts, a command palette, session minimap, completion sound, English and Chinese, plus Light / Dark / System themes.
- **Explicit security boundaries**: project file allowlists, path and symlink checks, Host and CSRF guards, and mandatory passwords for non-loopback listeners.

## Quick start

Node.js `>= 22.19.0` is required.

### Run without installing

```bash
npx @henlii/pidance@latest
```

### Install globally

```bash
npm install -g @henlii/pidance
pidance
```

Open [http://localhost:31415](http://localhost:31415) when the server is ready. The CLI attempts to open the browser by default.

```bash
pidance --port 8080
pidance --hostname 127.0.0.1
pidance -p 8080 -H 127.0.0.1
pidance --no-open
```

`PORT` and `PIDANCE_NO_OPEN=1` are also supported. Pidance reads `~/.pi/agent` by default; set `PI_CODING_AGENT_DIR` to use another Pi agent directory.

### Remote or LAN access

Listening on `0.0.0.0`, `::`, a LAN address, or another non-loopback host requires a password. The CLI refuses to start without one:

```bash
PIDANCE_PASSWORD='use-a-strong-password' pidance --hostname 0.0.0.0
```

For local-only use, bind explicitly to `127.0.0.1`. The legacy `PI_WEB_PASSWORD` variable remains compatible; new deployments should prefer `PIDANCE_PASSWORD`.

### HTTP proxy

Server-side model and API requests honor `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY`:

```bash
HTTPS_PROXY=http://127.0.0.1:7890 \
NO_PROXY=localhost,127.0.0.1 \
pidance
```

## Development and testing

```bash
npm install
npm run dev       # http://localhost:31415
npm run check     # typecheck + lint + unit tests
```

Additional acceptance checks:

```bash
npm run verify:render-bridge  # real pi-subagents rendering bridge
npm run test:browser          # browser regression (needs a running instance; default http://127.0.0.1:31416)
```

Do **not** run `npm run build` or `next build` during everyday development: it writes to `.next/` and can disrupt the development server. Production builds belong in an isolated release checkout through `npm run release:check`.

The default development and product port is **31415**. If you also run upstream [pi-web](https://github.com/agegr/pi-web) on the same machine, keep its own port and do not share processes or data directories with Pidance.

## Release process

Formal releases use a two-stage audit gate: run checks and the build in an isolated checkout, audit the prospective package, explicitly create the tgz, and then audit the real archive. Only that same accepted tgz may be used for installation smoke tests, npm, and the GitHub Release. No script automatically changes versions, creates tags, pushes, or publishes.

See [docs/release.md](./docs/release.md) for the complete procedure.

## Architecture

Pidance is a Pi Web mode adapter: the main Agent runs the in-process Pi SDK (`AgentSessionRuntime`). See [#20](https://github.com/henlii/pidance/issues/20) for the implementation specification and acceptance criteria.

```text
Browser / Route Handlers
          │
          ▼
SessionService ───────▶ read-only session projections and caches
          │
          ▼
LiveSessionRegistry
          │
          ▼
SdkSessionHost ───────▶ Web Extension UI Adapter
          │
          ▼
Pi AgentSessionRuntime
  ├─ AgentSession
  ├─ AgentSessionServices
  └─ SessionManager

~/.pi/agent/sessions/*.jsonl remains the Pi session source of truth
```

- **Read-only browsing** parses Pi `.jsonl` sessions without creating an AgentSession; scanners and caches never write JSONL.
- **Sending a message** creates or reuses an in-process SDK session host only when needed.
- Pi owns agent lifecycle, session replacement, resources, and JSONL/tree semantics. Pidance owns product use cases, the live registry, Web event projection, and UI adapters.
- Session service, event streaming, Extension UI, project context, and chat composition remain one-way dependencies so the UI cannot bypass session lifecycle rules.
- File endpoints only expose explicit roots such as selected projects, worktrees, and session working directories.

## Documentation

- [Git worktrees](./docs/worktrees.md)
- [Release and package auditing](./docs/release.md)
- [Interface design system](./docs/ui-redesign/README.md)
- [Theme tokens](./docs/ui-redesign/theme-tokens.md)

## Upstream and license

Pidance is derived from [agegr/pi-web](https://github.com/agegr/pi-web) and is built around the session and runtime semantics of [badlogic/pi-mono](https://github.com/badlogic/pi-mono). Many thanks to both upstream projects and their contributors.

Pidance is available under the [MIT License](./LICENSE). Upstream and derivative-work notices are retained in LICENSE: Copyright © 2026 agegr; Copyright © 2026 Henry Li.
