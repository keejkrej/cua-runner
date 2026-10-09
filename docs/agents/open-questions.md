# Open questions

## 2026-10-09

- decided: The hold is cooperative and keyed by holder. The bearer token is the credential. The same holder refreshes the hold and keeps the same id.
- decided: The current product is one runner on the test machine. The agent connects over localhost, LAN, Tailscale, or the relay. `dispatch`, a VM placement, and a hosted sandbox are later. The dispatch module remains in the repo and is not a command.
- decided: What matches a sandbox is the tool error (`isError` plus `structuredContent.code`). The agent recovers from that code. The desktop is not a sandbox.
- decided: `fetch_build` uses the `gh` login on the desktop. Tool arguments do not carry a GitHub token. `install_build` installs the program for darwin, win32, or linux. A `.deb`, `.rpm`, `.msi`, or `.msix` uses that platform's installer.
- decided: The memory driver is the default, so the protocol runs without Cua Driver. `--driver cua` shells out to `cua-driver mcp`.
- decided: The hosted relay in v1 is `cua-runner relay` on a machine the operator runs. Runners dial out. Agents call `/r/<id>/mcp`.
- decided: Tailscale is a network (CGNAT and `fd7a:115c:a1e0::/48`), not a separate protocol.
- open: Native accessibility input with no Cua Driver process. The current path on each desktop is `--driver cua`. macOS needs Screen Recording and Accessibility. Windows needs the interactive user session. Linux needs X11 or XWayland.
- open: A token per caller, so CI and the interactive agent do not share one credential. The hold still would not authenticate; it only names the holder.
- open: Screenshot streaming and video. v1 returns one image per tool result. The memory driver returns a fixed PNG; the state the agent reads is the text and `structuredContent`.
- deferred: A hosted sandbox. Revisit only when the error contract is no longer the part you want from it.
- open: Silent flags for arbitrary Windows `.exe` installers. An `.exe` is copied as a program. An `.msi` or `.msix` is installed.
