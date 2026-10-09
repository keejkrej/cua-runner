# One desktop, one MCP

A coding agent should drive a test desktop that is not the desktop the human is using. cua-runner serves one MCP for the machine it is installed on. The agent connects from the laptop, or from a CI job, over the LAN or the relay. Several desktops, a VM placement, and a hosted sandbox are later.

The hold lives on that runner. One holder drives the screen. A second holder gets `desktop_busy` until release or expiry. Computer tools, `fetch_build`, and `install_build` require the `session_id` from `claim_session`.

The listen port is 3213, beside cua-spacesd on 3211. HTTP is Node http server: source-address filtering needs the connection peer, and the relay is a long-poll. Effect owns the hold, the runner, and MCP decode.

## Considered options

- Reimplement Cua Driver's tool registry. `--driver cua` passes the live registry through. The memory driver implements the subset the tests drive, so the protocol runs on a machine with no desktop.
- Start VMs the way Cua Spaces does. The operator already has a desktop. CPU and memory stay on that machine.
- WebSockets for the relay. The runner long-polls. One waiting pull takes the next client request in the same turn the request arrives, and a reconnect replaces the previous generation.

## Consequences

- The agent recovers from tool errors. That recovery shape is recorded in `docs/adr/0002-builds-and-tool-errors.md`. A hosted sandbox is not a current surface.
