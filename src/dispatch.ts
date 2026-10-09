import { Effect, Ref } from "effect"
import { holdErrorToTool, makeHold, sessionJson, type Hold, type Session } from "./hold"
import {
  claimSessionTool,
  computerTools,
  describeDesktopTool,
  listDesktopsTool,
  listSessionsTool,
  releaseSessionTool,
} from "./tools"
import {
  DEFAULT_TTL_SECONDS,
  errorCode,
  isRecord,
  mcpUrl,
  omitKey,
  toolError,
  toolOk,
  withSessionArg,
  type AgentSurface,
  type DesktopTarget,
  type ToolDefinition,
  type ToolResult,
} from "./types"
import { UpstreamClient, UpstreamHttpError } from "./upstream"

const CONTROL = new Set(["describe_desktop", "list_desktops", "claim_session", "release_session", "list_sessions"])

type Probe = {
  readonly tools: readonly ToolDefinition[]
  readonly remoteLease: boolean
  readonly offline: boolean
}

type Route = { readonly desktopId: string; readonly remote: boolean }

function desktopIdOf(args: Record<string, unknown>): string | undefined {
  const value = args["desktop_id"]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function sessionIdOf(args: Record<string, unknown>): string | undefined {
  const value = args["session_id"]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function offlineMessage(error: unknown): string {
  if (error instanceof UpstreamHttpError) return `Desktop returned HTTP ${error.status}.`
  if (error instanceof Error) return error.message
  return "Desktop is unreachable."
}

export const makeDispatch = (targets: readonly DesktopTarget[], opts?: { readonly now?: () => number }) =>
  Effect.gen(function* () {
    if (targets.length === 0) {
      return yield* Effect.die(new Error("Dispatch needs at least one desktop."))
    }
    const ids = new Set<string>()
    for (const target of targets) {
      if (ids.has(target.id)) return yield* Effect.die(new Error(`Duplicate desktop id ${target.id}.`))
      ids.add(target.id)
    }
    const now = opts?.now ?? Date.now
    const holds = new Map<string, Hold>()
    for (const target of targets) holds.set(target.id, yield* makeHold({ now }))
    const clients = new Map(targets.map((target) => [target.id, new UpstreamClient(mcpUrl(target.url), target.token)]))
    const probes = yield* Ref.make(new Map<string, Probe>())
    const routes = yield* Ref.make(new Map<string, Route>())

    const remember = (sessionId: string, route: Route) =>
      Ref.update(routes, (current) => new Map(current).set(sessionId, route))

    const forget = (sessionId: string) =>
      Ref.update(routes, (current) => {
        const next = new Map(current)
        next.delete(sessionId)
        return next
      })

    const ensure = (target: DesktopTarget): Effect.Effect<Probe> =>
      Effect.gen(function* () {
        const cached = (yield* Ref.get(probes)).get(target.id)
        if (cached && !cached.offline) return cached
        const client = clients.get(target.id)
        if (!client) return { tools: [], remoteLease: target.lease !== "local", offline: true }
        const probe = yield* Effect.tryPromise(() => client.listTools()).pipe(
          Effect.map((tools): Probe => ({
            tools,
            remoteLease:
              target.lease === "local" ? false : target.lease === "remote" ? true : tools.some((tool) => tool.name === "claim_session"),
            offline: false,
          })),
          Effect.catchAll(() =>
            Effect.succeed<Probe>({
              tools: [],
              remoteLease: target.lease !== "local",
              offline: true,
            }),
          ),
        )
        yield* Ref.update(probes, (current) => new Map(current).set(target.id, probe))
        return probe
      })

    const markOffline = (desktopId: string) =>
      Ref.update(probes, (current) => {
        const previous = current.get(desktopId)
        const next = new Map(current)
        next.set(desktopId, {
          tools: previous?.tools ?? [],
          remoteLease: previous?.remoteLease ?? true,
          offline: true,
        })
        return next
      })

    const instructions = [
      "This MCP dispatches app testing onto desktops that are not this computer.",
      "Call list_desktops, then claim_session with desktop_id when more than one is listed.",
      "Pass session_id on every computer tool. Release the hold when the test is finished.",
    ].join(" ")

    const desktopRecord = (target: DesktopTarget, probe: Probe | undefined) => ({
      id: target.id,
      name: target.name,
      placement: target.placement,
      online: probe ? !probe.offline : false,
      hold: probe?.remoteLease === false ? "dispatch" : "runner",
      origin: new URL(target.url).origin,
    })

    const listTools = () =>
      Effect.gen(function* () {
        const extra = new Map<string, ToolDefinition>()
        for (const target of targets) {
          const probe = yield* ensure(target)
          const source = probe.offline ? computerTools : probe.tools
          for (const tool of source) {
            if (!CONTROL.has(tool.name)) extra.set(tool.name, withSessionArg(tool))
          }
        }
        return [describeDesktopTool, listDesktopsTool, claimSessionTool, releaseSessionTool, listSessionsTool, ...extra.values()]
      })

    const resolveTarget = (args: Record<string, unknown>): DesktopTarget | ToolResult => {
      const requested = desktopIdOf(args)
      if (requested) {
        const found = targets.find((target) => target.id === requested)
        return found ?? toolError("invalid_argument", `No desktop named ${requested}.`, { desktop_ids: targets.map((target) => target.id) })
      }
      if (targets.length === 1) return targets[0] as DesktopTarget
      return toolError("invalid_argument", "Pass desktop_id.", { desktop_ids: targets.map((target) => target.id) })
    }

    const claim = (args: Record<string, unknown>) =>
      Effect.gen(function* () {
        const target = resolveTarget(args)
        if ("isError" in target) return target
        const probe = yield* ensure(target)
        if (probe.offline) return toolError("desktop_offline", `${target.name} is unreachable.`, { desktop_id: target.id })
        const holder = typeof args["holder"] === "string" ? args["holder"] : ""
        const purpose = typeof args["purpose"] === "string" ? args["purpose"] : ""
        const ttl = typeof args["ttl_seconds"] === "number" ? args["ttl_seconds"] : DEFAULT_TTL_SECONDS
        if (probe.remoteLease) {
          const client = clients.get(target.id)
          if (!client) return toolError("desktop_offline", `${target.name} is unreachable.`, { desktop_id: target.id })
          const result = yield* Effect.tryPromise(() =>
            client.callTool("claim_session", { holder, purpose, ttl_seconds: ttl }),
          ).pipe(
            Effect.catchAll((error) => {
              return markOffline(target.id).pipe(Effect.as(toolError("desktop_offline", offlineMessage(error), { desktop_id: target.id })))
            }),
          )
          if (result.isError) return result
          const sessionId = isRecord(result.structuredContent) ? result.structuredContent["session_id"] : undefined
          if (typeof sessionId !== "string") {
            return toolError("upstream_invalid", "claim_session returned no session_id.", { desktop_id: target.id })
          }
          yield* remember(sessionId, { desktopId: target.id, remote: true })
          return {
            ...result,
            structuredContent: {
              ...(isRecord(result.structuredContent) ? result.structuredContent : {}),
              desktop_id: target.id,
            },
          }
        }
        const hold = holds.get(target.id)
        if (!hold) return toolError("desktop_offline", `${target.name} is unreachable.`, { desktop_id: target.id })
        const session = yield* hold.claim({ holder, purpose, ttlSeconds: ttl }).pipe(Effect.either)
        if (session._tag === "Left") return holdErrorToTool(session.left)
        yield* remember(session.right.id, { desktopId: target.id, remote: false })
        return toolOk(`Claimed ${target.name} as ${session.right.holder}.`, sessionJson(session.right, target.id))
      })

    const release = (args: Record<string, unknown>) =>
      Effect.gen(function* () {
        const sessionId = sessionIdOf(args)
        if (!sessionId) return toolError("invalid_argument", "Pass session_id.")
        const route = (yield* Ref.get(routes)).get(sessionId)
        if (!route) return toolError("unknown_session", "No hold matches that session_id.")
        if (!route.remote) {
          const hold = holds.get(route.desktopId)
          if (!hold) return toolError("unknown_session", "No hold matches that session_id.")
          const released = yield* hold.release(sessionId).pipe(Effect.either)
          if (released._tag === "Left") return holdErrorToTool(released.left)
          yield* forget(sessionId)
          return toolOk(`Released hold ${sessionId}.`, { released: true, ...sessionJson(released.right, route.desktopId) })
        }
        const client = clients.get(route.desktopId)
        if (!client) return toolError("desktop_offline", "Desktop is unreachable.", { desktop_id: route.desktopId })
        const result = yield* Effect.tryPromise(() => client.callTool("release_session", { session_id: sessionId })).pipe(
          Effect.catchAll((error) =>
            markOffline(route.desktopId).pipe(
              Effect.as(toolError("desktop_offline", offlineMessage(error), { desktop_id: route.desktopId })),
            ),
          ),
        )
        const code = errorCode(result)
        if (!result.isError || code === "unknown_session" || code === "session_expired") yield* forget(sessionId)
        return result
      })

    const drive = (name: string, args: Record<string, unknown>) =>
      Effect.gen(function* () {
        const sessionId = sessionIdOf(args)
        if (!sessionId) return toolError("session_required", "claim_session first and pass session_id.")
        const route = (yield* Ref.get(routes)).get(sessionId)
        if (!route) return toolError("unknown_session", "No hold matches that session_id.")
        const target = targets.find((item) => item.id === route.desktopId)
        if (!target) return toolError("unknown_session", "No hold matches that session_id.")
        const probe = yield* ensure(target)
        if (probe.offline) return toolError("desktop_offline", `${target.name} is unreachable.`, { desktop_id: target.id })
        if (!route.remote) {
          const hold = holds.get(target.id)
          if (!hold) return toolError("unknown_session", "No hold matches that session_id.")
          const gate = yield* hold.require(sessionId).pipe(Effect.either)
          if (gate._tag === "Left") {
            yield* forget(sessionId)
            return holdErrorToTool(gate.left)
          }
        }
        const client = clients.get(target.id)
        if (!client) return toolError("desktop_offline", `${target.name} is unreachable.`, { desktop_id: target.id })
        const forwarded = route.remote ? args : omitKey(args, "session_id")
        const result = yield* Effect.tryPromise(() => client.callTool(name, forwarded)).pipe(
          Effect.catchAll((error) =>
            markOffline(target.id).pipe(Effect.as(toolError("desktop_offline", offlineMessage(error), { desktop_id: target.id }))),
          ),
        )
        const code = errorCode(result)
        if (code === "session_expired" || code === "unknown_session") yield* forget(sessionId)
        return result
      })

    const listSessions = () =>
      Effect.gen(function* () {
        const sessions: unknown[] = []
        for (const target of targets) {
          const probe = yield* ensure(target)
          if (probe.offline) continue
          if (probe.remoteLease) {
            const client = clients.get(target.id)
            if (!client) continue
            const listed = yield* Effect.tryPromise(() => client.callTool("list_sessions", {})).pipe(
              Effect.catchAll(() => Effect.succeed(toolError("desktop_offline", "unreachable"))),
            )
            if (listed.isError || !isRecord(listed.structuredContent) || !Array.isArray(listed.structuredContent["sessions"])) {
              continue
            }
            for (const session of listed.structuredContent["sessions"]) {
              if (isRecord(session)) sessions.push({ ...session, desktop_id: target.id })
            }
          } else {
            const hold = holds.get(target.id)
            if (!hold) continue
            const local: readonly Session[] = yield* hold.list()
            for (const session of local) sessions.push(sessionJson(session, target.id))
          }
        }
        return toolOk(`${sessions.length} holds.`, { sessions })
      })

    const call: AgentSurface["call"] = (name, args) => {
      switch (name) {
        case "describe_desktop":
          return Effect.succeed(
            toolOk(`Dispatch across ${targets.length} desktops.`, {
              kind: "dispatch",
              protocol: 1,
              desktops: targets.length,
              mcp: "/mcp",
              health: "/health",
            }),
          )
        case "list_desktops":
          return Effect.gen(function* () {
            const desktops = []
            for (const target of targets) desktops.push(desktopRecord(target, yield* ensure(target)))
            return toolOk(`${desktops.length} desktops.`, { desktops })
          })
        case "claim_session":
          return claim(args)
        case "release_session":
          return release(args)
        case "list_sessions":
          return listSessions()
        default:
          return drive(name, args)
      }
    }

    return { instructions, listTools, call } satisfies AgentSurface
  })
