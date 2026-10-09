# cua-runner

cua-runner is the process you install on the machine whose screen is the test desktop. The agent stays on your laptop, or in a CI job. It claims that desktop, downloads a build onto it, and drives the app there.

You edit and build on one machine. On the desktop you run `serve`. The agent points at that MCP over the LAN, or through the relay when the desktop is elsewhere. A CI job is the same kind of client: that job owns the agent, including the model key and the harness. The desktop owns the screen, `gh`, and the app.

A failed tool comes back as `isError` with `structuredContent.code`. The agent reads the code and recovers. That is the part shared with a hosted computer-use sandbox. This desktop is the machine you installed the runner on.

`--driver cua` uses [Cua Driver](https://cua.ai/docs/cua-driver/guide/getting-started/introduction) on macOS, Windows, and Linux. macOS needs Screen Recording and Accessibility. Windows drives the interactive user session. Linux drives X11 and XWayland. `install_build` places the program for the desktop it is running on. The memory driver is the default, so the protocol runs on a machine with no screen.

Listen port is **3213**. `GET /health` is open and returns 204. `POST /mcp` is stateless JSON-RPC.

## Try it on this machine

```sh
bun install
bun src/index.ts serve
```

Loopback with no token is allowed. Point an MCP client at `http://127.0.0.1:3213/mcp`, or print a client snippet:

```sh
bun src/index.ts mcp-config --url http://127.0.0.1:3213/mcp --no-auth
```

The memory desktop has Calculator, Notes, and Safari. Claim a hold, launch Calculator, and click element indexes `6`, `11`, `7`, `12` (`6`, `+`, `7`, `=`). The display value is `13`. Read `get_window_state` text for the `[N]` element indexes. The screenshot is a fixed PNG; the state to trust is the text and `structuredContent`.

## Desktop

Install [Cua Driver](https://cua.ai/docs/cua-driver/reference/cli/mcp.md) and the GitHub CLI. On that machine, `gh auth login` once. The agent does not send a GitHub token. Create a token file the runner process can read:

```sh
umask 077
mkdir -p ~/.cua-runner
openssl rand -hex 32 > ~/.cua-runner/token
```

```sh
cua-runner serve \
  --listen 0.0.0.0:3213 \
  --allow-lan \
  --token-file ~/.cua-runner/token \
  --driver cua \
  --name "desktop"
```

`--allow-lan` accepts loopback, RFC1918, and Tailscale peers (`100.64.0.0/10` and `fd7a:115c:a1e0::/48`). Public peers need `--allow-public`. Any non-loopback listen requires a token. The listener is plain HTTP. The token is the credential. Put it on Tailscale or a LAN you trust.

On the editing machine, set `CUA_RUNNER_TOKEN` to the same secret and give the agent:

```sh
cua-runner mcp-config --url http://100.x.x.x:3213/mcp
```

The printed config uses `${CUA_RUNNER_TOKEN}`. It does not contain the secret. `--print-config` reports the token as `set` or `unset`.

## Build

After `claim_session`, the agent calls `fetch_build` with `repo`, `name`, and one of `run_id`, `sha`, or `tag`. The desktop runs `gh run download` or `gh release download` into `~/.cua-runner/builds`. `install_build` takes a path from that result.

| Desktop | Copied into the programs directory | Handed to the platform installer |
| --- | --- | --- |
| macOS | `.app`, or a `.zip` / `.dmg` that contains one | |
| Windows | `.exe`, or a `.zip` that contains one | `.msi`, `.msix`, `.appx` |
| Linux | AppImage, executable, `.zip`, `.tar.gz` | `.deb`, `.rpm` |

The default directory is `/Applications`, `%LOCALAPPDATA%\Programs`, or `~/.local/bin`. `destination` may be `~/Applications`. A `.deb`, `.rpm`, `.msi`, or `.msix` uses the platform installer and may require an administrator on that desktop. `install_unsupported` means the package is for a different operating system.

Then the agent uses the computer tools to open the app and check the fix. `gh_auth` means this desktop still needs `gh auth login`. `build_not_found` means that run or asset is not there. `install_failed` means the copy or the package installer did not succeed. `desktop_busy` means another holder has the screen.

## Relay

When the desktop should not accept inbound connections, run a relay where agents can reach it, and point the desktop at it:

```sh
# on the relay host
cua-runner relay --listen 0.0.0.0:3213 --allow-public --token-file ~/.cua-runner/token

# on the desktop, added to serve
--relay http://your-relay:3213 --id desktop
```

Agents call `http://your-relay:3213/r/desktop/mcp` with the same bearer token. The runner long-polls `POST /relay/pull`. A client request wakes that poll. Relay requires a token, and so does `serve --relay`. When the relay is the only path, serve can stay on `127.0.0.1:3213`. Paths under `/r/<id>/` are `/mcp` and `/health`. The id is a slug: lowercase letters, digits, and hyphens, up to 64 characters.

## Hold

`claim_session` takes `holder` and `purpose`. `ttl_seconds` defaults to 600 and must be an integer from 10 to 7200. The same holder refreshes the purpose and the expiry and keeps the same `session_id`. A different holder gets `desktop_busy` until release or expiry. Computer tools require `session_id`. The runner removes that field before the driver sees the call.

Tool failures are MCP results with `isError: true` and `structuredContent.code`: `desktop_busy`, `session_required`, `unknown_session`, `session_expired`, `invalid_argument`, `desktop_offline`, `unknown_tool`, `gh_auth`, `gh_unavailable`, `gh_failed`, `build_not_found`, `install_failed`, `install_unsupported`.

Control tools: `describe_desktop`, `list_desktops`, `claim_session`, `release_session`, `list_sessions`.

Build tools: `fetch_build`, `install_build`. Both require `session_id`.

The memory driver, and the tools this repo defines for it: `list_apps`, `launch_app`, `list_windows`, `get_window_state`, `get_desktop_state`, `click`, `type_text`, `press_key`, `scroll`. `--driver cua` publishes whatever `cua-driver mcp` lists, plus the control tools. Each computer tool gains a `session_id` argument.

Accepted bearer headers: `authorization`, `x-cua-runner-authorization`, `x-cua-env-authorization`. When a token is set, every request except `GET /health` needs it, including loopback. MCP `initialize` accepts protocol versions `2025-03-26`, `2025-06-18`, and `2024-11-05`, and echoes the requested version. Any other requested version gets `2025-03-26`. A response is JSON unless the client asks only for `text/event-stream`.

## Develop

```sh
bun install
bun run check
```

`bun run check` is typecheck, `bun test`, and oxlint. Effect is pinned to 3.22.2 so it passes the 7-day install age gate in `bunfig.toml`.

Environment overrides for flags: `CUA_RUNNER_TOKEN`, `CUA_RUNNER_LISTEN`, `CUA_RUNNER_NAME`, `CUA_RUNNER_ID`, `CUA_RUNNER_RELAY`. Flags win.

Words for the domain live in `CONTEXT.md`. The desktop decision is `docs/adr/0001-one-desktop-one-mcp.md`. Builds and tool errors are `docs/adr/0002-builds-and-tool-errors.md`.
