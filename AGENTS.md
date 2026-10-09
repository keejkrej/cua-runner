# AGENTS.md

Humans review this file regularly. Agents maintain it via the memory skill.

## Purpose

- cua-runner lets a coding agent drive app testing on a desktop that is not the one the person is editing on.
- The runner is installed on the desktop. The agent stays on the editing machine, or in a CI job that holds the model key and the harness.
- The agent reaches the runner over localhost, a LAN, Tailscale, or a relay the operator hosts.
- `fetch_build` downloads a GitHub build with the desktop's `gh` login. `install_build` places that program on macOS, Windows, or Linux. Failures are tool errors with `structuredContent.code`.
- Out of scope for now: dispatch across desktops, creating virtual machines, provisioning a hosted sandbox, and reimplementing Cua Driver's tool registry.

## Rules

- Use the words in `CONTEXT.md`. A desktop is not a Space.
- Effect owns the hold, the runner, dispatch, and MCP decode. Node HTTP server owns HTTP, because peer filtering and the relay long-poll need the connection.
- Computer tool names stay aligned with Cua Driver. A new placement is a desktop record, not a new MCP.
- A token is a credential. A holder is a label. Logs record claim, release, and desktop_busy. Logs omit tokens and tool arguments.
- Extensionless TypeScript imports.
- Verify with `pnpm run check`.
- Read `CONTEXT.md` before renaming a domain concept. Read `docs/adr/0001-one-desktop-one-mcp.md` before adding a desktop surface. Read `docs/adr/0002-builds-and-tool-errors.md` before changing how a build is fetched or how a tool failure is reported. Read `docs/agents/open-questions.md` before adding a driver or a credential model.

## Tech stack

<!-- memory:techstack-start -->
- Node.js is the runtime, pnpm is the package manager, and vitest is the test runner.
- Effect 3 for the hold, runner, dispatch, and MCP decode. Schema at the desktops-file boundary.
- HTTP is Node http server: source-address filtering and the relay long-poll.
- oxlint and `tsc --noEmit`. Extensionless TypeScript imports.
- `pnpm run check` is the verification bar: typecheck, vitest, oxlint.
<!-- memory:techstack-end -->

## Context

- Domain language: `CONTEXT.md`
- Why one runner: `docs/adr/0001-one-desktop-one-mcp.md`
- Why builds and tool errors: `docs/adr/0002-builds-and-tool-errors.md`
- Open questions: `docs/agents/open-questions.md`
