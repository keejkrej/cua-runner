# Builds are fetched on the desktop, and failures are tool errors

The agent stays on the editing machine, or in a CI job that holds the model key and the harness. The desktop is a machine you already have. That split looks like a hosted computer-use sandbox from the agent's side: a tool fails, the result carries a code, and the agent decides whether to retry, stop, or ask a person. The desktop is not a sandbox. cua-runner does not provision one, snapshot one, or bill one.

`fetch_build` runs `gh` on the desktop with the login already on that machine. The agent names `repo` and `name`, plus `run_id`, `sha`, or `tag`. It does not send a GitHub token or a binary. `install_build` places the program for the operating system it finds: a macOS app, a Windows program or package, or a Linux program or package. `gh_auth`, `build_not_found`, `install_failed`, and `install_unsupported` are MCP tool errors (`isError` and `structuredContent.code`), the same channel as `desktop_busy` and `session_required`.

## Considered options

- The laptop uploads the binary over the MCP connection. The desktop would trust bytes from the agent, and a large build would sit in the tool call.
- The agent passes `GH_TOKEN` into the tool. The token would cross the laptop, the CI log, and the desktop. The desktop's own `gh auth login` keeps the credential in one place.
- A hosted sandbox for every run. The error contract is the part worth sharing. The machine stays the desktop you already run.
