<div align="center">
  <img src="./docs/assets/pidance-banner.png" alt="Pidance — Move with Pi" width="760">
  <p><strong>Let Pi sessions, tools, and project workflows move naturally in the browser.</strong></p>
  <p>
    <a href="./README.md">简体中文</a> ·
    <a href="https://github.com/henlii/pidance/issues">Issues</a> ·
    <a href="./docs/README.md">Documentation</a>
  </p>
</div>

Pidance is an open-source web client for the [Pi](https://github.com/badlogic/pi-mono) coding agent. It reads local Pi session files directly and preserves Pi SDK session and runtime semantics, bringing live chat, project files, Git, subagents, and configuration into one browser workspace. Pi remains the source of truth for data and execution semantics; Pidance provides a clearer and more complete interface.

> Current version: `0.2.40` · npm package: `@henlii/pidance` · CLI: `pidance`

## Design principles

**Compatibility first, then general display improvements on top of it.**

1. **Content completeness comes first.** Pidance aims to let you experience what a native TUI session shows — **including extension (plugin) custom UI** — in the browser. Anything the native TUI can display, Pidance should display too; prefer showing it as-is over hiding it because it “looks off on the web”.
2. **Compatibility outranks looks.** Content a plugin expresses through the TUI extension API (self-drawn components, overlays, widgets, status lines, dialogs) must always have a landing spot. When a capability is missing, degrade **visibly** — notify or return an explicit value, never drop it silently (silence makes plugin authors think it worked).
3. **Improvements must be general.** Display-layer work (layout, collapsing, card shells, titles, accessibility) goes through mechanisms shared by every plugin — no per-plugin special cases. Plugin-specific code is allowed only in the compatibility layer: parsing a plugin's private payloads, or bridging TUI semantics to the web.
4. **Pi stays the source of truth.** Session files, tool execution, compaction and branch semantics are decided by the Pi SDK; Pidance only projects and presents them. See [`docs/ui-vs-tui.md`](./docs/ui-vs-tui.md) for the surface-by-surface mapping.

## Preview

![Pidance new-session workspace](./docs/screenshots/desktop.png)

<p align="center"><sub>New-session workspace with the project selector, model controls, and contextual side panels. The path shown is anonymized.</sub></p>

![Pidance appearance settings](./docs/screenshots/settings.png)

<p align="center"><sub>Appearance settings with Light, Dark, System, Chamber, and Fusion options.</sub></p>

## Features

- **Project-oriented sessions**: browse a Project → Session tree (a project is the directory you added) with search, recent sessions, archive/restore, rename, automatic titles, and HTML export.
- **Live agent chat**: stream responses, thinking, tool calls, ANSI terminal output, compaction, and running state over SSE, with reconciliation after reconnects.
- **Safe exploration**: continue from an earlier message, create an in-session branch, or fork to an independent `.jsonl` session without conflating those semantics.
- **Project workspace**: browse and preview source, Markdown, images, audio, PDFs, and DOCX; search files, use `@` mentions, and inspect Git status and diffs.
- **One directory, one project**: for a second Git checkout, create it with `git worktree` yourself and add that directory as a project. Pidance does not manage worktrees; new sessions and the file workspace always follow the selected directory.
- **Pi ecosystem integration**: inspect synchronous and asynchronous subagent run status, interact with generic extension UI cards, and view read-only projections of structured todos.
- **Central configuration**: manage provider authentication, API keys, models and model tests, session defaults, skills, plugins, and project trust.
- **Polished interface**: responsive desktop/mobile layouts, a command palette, session minimap, completion sound, English and Chinese, plus Light / Dark / System themes.
- **Access protection**: Host/CSRF guards, login authentication, and mandatory passwords for non-loopback CLI listeners. Agent and file access are for trusted operators; there is no project-directory sandbox. See [security boundaries](./docs/security.md).

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

`PORT` and `PIDANCE_NO_OPEN=1` are also supported. The port can be configured in **Settings → General → Service and remote access** (default 31415; restart required). Pidance reads `~/.pi/agent` by default; set `PI_CODING_AGENT_DIR` to use another Pi agent directory.

### Remote or LAN access

The CLI binds to `127.0.0.1` by default. In **Settings → General → Service and remote access**, set a password and enable remote access to listen on `0.0.0.0` after a restart. Alternatively, configure it explicitly below. Listening on a non-loopback address requires a password; the CLI refuses to start without one:

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
npm run dev       # standalone source development server: 127.0.0.1:31416, output .next
npm run check     # typecheck + lint + unit tests
```

Additional acceptance checks:

```bash
npm run verify:render-bridge  # real pi-subagents rendering bridge
npm run test:browser          # browser regression (needs a running instance; default http://127.0.0.1:31416)
```

Do **not** run `npm run build` or `next build` during everyday development: it writes to `.next/` and can disrupt the development server. Production builds belong in an isolated release checkout through `npm run release:check`.

Development convention: **31415 is reserved for the stable installation; the working tree uses 31416**. Continuous testing writes `.next-public`; standalone dev writes `.next`. `npm run dev` now targets 127.0.0.1:31416 (same port as the continuous deployment — do not run both). See the [development guide](./docs/development.md) for test isolation and multi-client checks.

## Release process

Before releasing, run `npm run check`, prepare the version and bilingual release notes, then explicitly commit and push an annotated tag. Tag CI builds in isolation, audits before and after packing, publishes through npm OIDC, and creates the GitHub Release. npm and GitHub must use the same accepted tgz and SHA-256. The local candidate script does not change versions, tag, push, or publish.

See [docs/release.md](./docs/release.md) for the complete procedure.

## Architecture

Pidance is a Pi Web mode adapter: the main Agent runs the in-process Pi SDK (`AgentSessionRuntime`). See the [architecture guide](./docs/architecture.md) for current responsibilities and interaction flows; [#20](https://github.com/henlii/pidance/issues/20) records the earlier migration specification.

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
- **Write operations or explicit wake requests** create or reuse an SDK session host when needed; SSE only observes an existing Host.
- Pi owns agent lifecycle, session replacement, resources, and JSONL/tree semantics. Pidance owns product use cases, the live registry, Web event projection, and UI adapters.
- One-way dependencies and single-writer ownership are maintenance constraints, not a claim of complete concurrency safety. See the [known lifecycle, queue, cancellation, and recovery risks](./docs/architecture-review-2026-09-15.md).
- File access is currently not restricted to project roots. Authenticated users must be trusted with the local Agent and file capabilities.

## Documentation

Start with the [documentation index](./docs/README.md). Detailed maintainer guides are currently in Chinese.

- [Architecture](./docs/architecture.md) · [Static review](./docs/architecture-review-2026-09-15.md)
- [Development](./docs/development.md) · [Security](./docs/security.md)
- [Windows desktop shell](./desktop/README.md) · [Version history](./docs/release-notes/README.md)
- [Release and package auditing](./docs/release.md)
- [Historical interface prototypes](./docs/ui-redesign/README.md)
- [Theme token design reference](./docs/ui-redesign/theme-tokens.md)

## Upstream and license

Pidance is derived from [agegr/pi-web](https://github.com/agegr/pi-web) and is built around the session and runtime semantics of [badlogic/pi-mono](https://github.com/badlogic/pi-mono). Many thanks to both upstream projects and their contributors.

Pidance is available under the [MIT License](./LICENSE). Upstream and derivative-work notices are retained in LICENSE: Copyright © 2026 agegr; Copyright © 2026 Henry Li.
