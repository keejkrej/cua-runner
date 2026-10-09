import { Effect } from "effect"
import { hostname as osHostname, arch, platform } from "node:os"
import { assertListenAllowed } from "./bind"
import { startCuaDriver } from "./cua-driver"
import {
  HELP,
  mcpClientConfig,
  parseArgs,
  publicConfig,
  type Cli,
  type RelayConfig,
  type ServeConfig,
} from "./config"
import { makeHold } from "./hold"
import { consoleLog } from "./log"
import { makeMemoryDriver } from "./memory-desktop"
import { RelayHub } from "./relay-hub"
import { relayLoop } from "./relay-agent"
import { makeRunner } from "./runner"
import { startRelayServer, startSurfaceServer, type RunningServer } from "./server"
import { handleSurfaceHttp } from "./surface-http"
import type { DesktopFacts } from "./types"

export async function main(argv: readonly string[], env: Record<string, string | undefined> = process.env): Promise<number> {
  let cli: Cli
  try {
    cli = parseArgs(argv, env)
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid arguments."
    console.error(message)
    console.error(HELP)
    return 1
  }
  if (cli.command === "help") {
    console.log(HELP)
    return 0
  }
  if (cli.command === "mcp-config") {
    console.log(JSON.stringify(mcpClientConfig(cli.url, cli.auth), null, 2))
    return 0
  }
  if (cli.printConfig) {
    console.log(JSON.stringify(publicConfig(cli), null, 2))
    return 0
  }
  try {
    assertListenAllowed(cli.listen.host, cli)
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Refusing to listen.")
    return 1
  }
  if (cli.command === "relay" && !cli.token) {
    console.error("relay requires a token.")
    return 1
  }
  if (cli.command === "serve" && cli.relay && !cli.token) {
    console.error("--relay requires a token.")
    return 1
  }
  const abort = new AbortController()
  const onSignal = () => abort.abort()
  process.on("SIGINT", onSignal)
  process.on("SIGTERM", onSignal)
  let server: RunningServer | undefined
  let closeDriver: (() => void) | undefined
  try {
    if (cli.command === "serve") {
      const started = await startServe(cli, abort.signal)
      server = started.server
      closeDriver = started.closeDriver
    } else {
      server = startRelay(cli)
    }
    consoleLog("listen", {
      command: cli.command,
      url: `${server.url}/mcp`,
      token: Boolean(cli.token),
    })
    await new Promise<void>((resolve) => {
      abort.signal.addEventListener("abort", () => resolve(), { once: true })
    })
    return 0
  } catch (error) {
    console.error(error instanceof Error ? error.message : "cua-runner failed to start.")
    return 1
  } finally {
    process.off("SIGINT", onSignal)
    process.off("SIGTERM", onSignal)
    closeDriver?.()
    server?.stop()
  }
}

async function startServe(cli: ServeConfig, signal: AbortSignal): Promise<{ server: RunningServer; closeDriver?: () => void }> {
  const facts: DesktopFacts = {
    id: cli.id,
    name: cli.name,
    placement: cli.placement,
    driver: cli.driver,
    protocol: 1,
    platform: platform(),
    arch: arch(),
  }
  let closeDriver: (() => void) | undefined
  const driver =
    cli.driver === "memory"
      ? makeMemoryDriver()
      : await startCuaDriver(cli.cuaCommand).then((started) => {
          closeDriver = started.close
          return started.driver
        })
  const hold = await Effect.runPromise(makeHold())
  const surface = makeRunner({ facts, hold, driver, log: consoleLog })
  const server = startSurfaceServer(
    {
      hostname: cli.listen.host,
      port: cli.listen.port,
      ...(cli.token ? { token: cli.token } : {}),
      allowLan: cli.allowLan,
      allowPublic: cli.allowPublic,
    },
    surface,
  )
  if (cli.relay) {
    if (!cli.token) throw new Error("--relay requires a token.")
    const token = cli.token
    void relayLoop({
      relayUrl: cli.relay,
      token,
      runnerId: cli.id,
      name: cli.name || osHostname(),
      placement: cli.placement,
      signal,
      handle: (input) => handleSurfaceHttp({ ...input, surface }),
    }).catch((error: unknown) => {
      consoleLog("relay_stopped", { message: error instanceof Error ? error.message : "relay loop stopped" })
    })
  }
  return { server, ...(closeDriver ? { closeDriver } : {}) }
}

function startRelay(cli: RelayConfig): RunningServer {
  const hub = new RelayHub({ pullWaitMs: 20_000, proxyWaitMs: 90_000, maxPending: 8 })
  return startRelayServer(
    {
      hostname: cli.listen.host,
      port: cli.listen.port,
      ...(cli.token ? { token: cli.token } : {}),
      allowLan: cli.allowLan,
      allowPublic: cli.allowPublic,
    },
    hub,
  )
}
