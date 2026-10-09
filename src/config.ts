import { readFileSync } from "node:fs"
import { Schema } from "effect"
import { DEFAULT_PORT, type DesktopTarget, type DriverKind, type Placement } from "./types"

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ConfigError"
  }
}

type Listen = { readonly host: string; readonly port: number }

export type ServeConfig = {
  readonly command: "serve"
  readonly listen: Listen
  readonly token?: string
  readonly name: string
  readonly id: string
  readonly placement: Placement
  readonly driver: DriverKind
  readonly allowLan: boolean
  readonly allowPublic: boolean
  readonly relay?: string
  readonly cuaCommand: readonly string[]
  readonly printConfig: boolean
}

export type RelayConfig = {
  readonly command: "relay"
  readonly listen: Listen
  readonly token?: string
  readonly allowLan: boolean
  readonly allowPublic: boolean
  readonly printConfig: boolean
}

export type McpConfigCommand = {
  readonly command: "mcp-config"
  readonly url: string
  readonly auth: boolean
}

export type HelpCommand = { readonly command: "help" }

export type Cli = ServeConfig | RelayConfig | McpConfigCommand | HelpCommand

const DesktopRecord = Schema.Struct({
  id: Schema.String.pipe(Schema.pattern(/^[a-z0-9][a-z0-9-]{0,63}$/)),
  name: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(120)),
  url: Schema.String,
  token: Schema.optional(Schema.String),
  placement: Schema.Literal("native", "vm", "cloud"),
  lease: Schema.optional(Schema.Literal("remote", "local")),
})

const DesktopFile = Schema.Array(DesktopRecord)

export function loadDesktops(path: string): readonly DesktopTarget[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"))
  } catch (error) {
    const message = error instanceof Error ? error.message : "unreadable"
    throw new ConfigError(`Could not read desktops file ${path}: ${message}`)
  }
  let records: ReadonlyArray<{
    id: string
    name: string
    url: string
    token?: string
    placement: Placement
    lease?: "remote" | "local"
  }>
  try {
    records = Schema.decodeUnknownSync(DesktopFile)(parsed)
  } catch {
    throw new ConfigError(
      "Desktops file must be a JSON array of { id, name, url, placement, token?, lease? }. ids are lowercase letters, digits, and hyphens.",
    )
  }
  if (records.length === 0) throw new ConfigError("Desktops file is empty.")
  const seen = new Set<string>()
  return records.map((record) => {
    if (seen.has(record.id)) throw new ConfigError(`Duplicate desktop id ${record.id}.`)
    seen.add(record.id)
    let url: URL
    try {
      url = new URL(record.url)
    } catch {
      throw new ConfigError(`Desktop ${record.id} has an invalid url.`)
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new ConfigError(`Desktop ${record.id} url must be http or https.`)
    }
    return {
      id: record.id,
      name: record.name,
      url: record.url,
      ...(record.token !== undefined ? { token: record.token } : {}),
      placement: record.placement,
      ...(record.lease !== undefined ? { lease: record.lease } : {}),
    }
  })
}

export function parseArgs(argv: readonly string[], env: Record<string, string | undefined> = process.env): Cli {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) return { command: "help" }
  const [command, ...rest] = argv
  if (command === "dispatch") {
    throw new ConfigError("dispatch is later. Point the agent at this runner's /mcp.")
  }
  if (command !== "serve" && command !== "relay" && command !== "mcp-config") {
    throw new ConfigError(`Unknown command ${command ?? ""}.`)
  }
  const flags = readFlags(rest)
  const token = resolveToken(flags, env)
  const listen = parseListen(flags.get("listen") ?? env["CUA_RUNNER_LISTEN"] ?? `127.0.0.1:${DEFAULT_PORT}`)
  const allowLan = flags.has("allow-lan")
  const allowPublic = flags.has("allow-public")
  const printConfig = flags.has("print-config")
  if (command === "mcp-config") {
    const url = flags.get("url")
    if (!url) throw new ConfigError("mcp-config requires --url.")
    return { command, url, auth: !flags.has("no-auth") }
  }
  if (command === "relay") {
    return { command, listen, ...(token ? { token } : {}), allowLan, allowPublic, printConfig }
  }
  const name = flags.get("name") ?? env["CUA_RUNNER_NAME"] ?? "desktop"
  if (flags.has("placement") && flags.get("placement") !== "native") {
    throw new ConfigError("This runner serves the machine it is running on. Other placements are later.")
  }
  const placement = "native" as const
  const driver = parseDriver(flags.get("driver") ?? "memory")
  const cuaBin = flags.get("cua-bin") ?? "cua-driver"
  const relay = flags.get("relay") ?? env["CUA_RUNNER_RELAY"]
  const id = flags.get("id") ?? env["CUA_RUNNER_ID"] ?? slug(name)
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) {
    throw new ConfigError("Runner id must be lowercase letters, digits, and hyphens.")
  }
  return {
    command,
    listen,
    ...(token ? { token } : {}),
    name,
    id,
    placement,
    driver,
    allowLan,
    allowPublic,
    ...(relay ? { relay } : {}),
    cuaCommand: [cuaBin, "mcp"],
    printConfig,
  }
}

export function publicConfig(cli: Cli): Record<string, unknown> {
  if (cli.command === "help" || cli.command === "mcp-config") return { command: cli.command }
  return {
    command: cli.command,
    listen: `${cli.listen.host}:${cli.listen.port}`,
    token: cli.token ? "set" : "unset",
    allowLan: cli.allowLan,
    allowPublic: cli.allowPublic,
    ...("name" in cli ? { name: cli.name, id: cli.id, placement: cli.placement, driver: cli.driver, relay: cli.relay ?? null } : {}),
  }
}

export const HELP = `cua-runner serve|relay|mcp-config

serve
  Own this machine's desktop and serve its MCP on /mcp.
  --listen 127.0.0.1:${DEFAULT_PORT}
  --name "desktop" --id desktop
  --driver memory|cua
  --token <secret> | --token-file <path>
  --allow-lan          bind all interfaces for LAN and Tailscale clients
  --allow-public       also accept clients from public addresses
  --relay http://host:${DEFAULT_PORT}
  --cua-bin cua-driver
  --print-config

relay
  Runners dial out. Clients call /r/<id>/mcp.
  --listen 0.0.0.0:${DEFAULT_PORT} --allow-public --token <secret>

mcp-config
  Print an MCP client entry. The token stays in CUA_RUNNER_TOKEN.
  --url http://host:${DEFAULT_PORT}/mcp
  --no-auth

Environment: CUA_RUNNER_TOKEN, CUA_RUNNER_LISTEN, CUA_RUNNER_NAME, CUA_RUNNER_ID, CUA_RUNNER_RELAY.
A token is required for any listen address that is not loopback. The token is never printed.
fetch_build uses the gh login on this machine. Do not pass a GitHub token as a tool argument.
`

function readFlags(argv: readonly string[]): Map<string, string> & { has(name: string): boolean } {
  const values = new Map<string, string>()
  const present = new Set<string>()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token?.startsWith("--")) throw new ConfigError(`Unexpected argument ${token ?? ""}.`)
    const name = token.slice(2)
    present.add(name)
    const next = argv[index + 1]
    if (next !== undefined && !next.startsWith("--")) {
      values.set(name, next)
      index += 1
    }
  }
  return Object.assign(values, {
    has(name: string) {
      return present.has(name)
    },
  })
}

function resolveToken(flags: Map<string, string> & { has(name: string): boolean }, env: Record<string, string | undefined>): string | undefined {
  const inline = flags.get("token")
  const file = flags.get("token-file")
  if (inline && file) throw new ConfigError("Pass --token or --token-file, not both.")
  if (file) {
    try {
      const value = readFileSync(file, "utf8").trim()
      if (value.length === 0) throw new ConfigError(`Token file ${file} is empty.`)
      return value
    } catch (error) {
      if (error instanceof ConfigError) throw error
      throw new ConfigError(`Could not read token file ${file}.`)
    }
  }
  return inline ?? env["CUA_RUNNER_TOKEN"]
}

export function parseListen(value: string): Listen {
  if (value.startsWith("[")) {
    const match = /^\[([^\]]+)\]:(\d+)$/.exec(value)
    if (!match?.[1] || !match[2]) throw new ConfigError(`Invalid listen address ${value}.`)
    return { host: match[1], port: parsePort(match[2]) }
  }
  const index = value.lastIndexOf(":")
  if (index <= 0) throw new ConfigError(`Invalid listen address ${value}. Use host:port.`)
  return { host: value.slice(0, index), port: parsePort(value.slice(index + 1)) }
}

function parsePort(value: string): number {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new ConfigError(`Invalid port ${value}.`)
  return port
}

function parseDriver(value: string): DriverKind {
  if (value === "memory" || value === "cua") return value
  throw new ConfigError("--driver must be memory or cua.")
}

export function slug(name: string): string {
  const value = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64)
  return value.length > 0 ? value : "desktop"
}

export function mcpClientConfig(url: string, auth: boolean): unknown {
  return {
    mcpServers: {
      "cua-runner": {
        type: "http",
        url,
        ...(auth ? { headers: { Authorization: "Bearer ${CUA_RUNNER_TOKEN}" } } : {}),
      },
    },
  }
}
