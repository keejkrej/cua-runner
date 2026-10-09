import { Effect } from "effect"
import { homedir } from "node:os"
import { defaultBuildRoot, makeBuilds, spawnExec, type Exec } from "./build"
import { holdErrorToTool, sessionJson, type Hold } from "./hold"
import { silentLog, type Log } from "./log"
import {
  claimSessionTool,
  describeDesktopTool,
  listDesktopsTool,
  listSessionsTool,
  releaseSessionTool,
} from "./tools"
import {
  DEFAULT_TTL_SECONDS,
  omitKey,
  toolError,
  toolOk,
  withSessionArg,
  type AgentSurface,
  type DesktopFacts,
  type Driver,
  type ToolDefinition,
  type ToolResult,
} from "./types"

const CONTROL = new Set(["describe_desktop", "list_desktops", "claim_session", "release_session", "list_sessions"])
const BUILD = new Set(["fetch_build", "install_build"])

function sessionIdOf(args: Record<string, unknown>): string | undefined {
  const value = args["session_id"]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

export function makeRunner(input: {
  readonly facts: DesktopFacts
  readonly hold: Hold
  readonly driver: Driver
  readonly log?: Log
  readonly builds?: { readonly tools: readonly ToolDefinition[]; readonly call: (name: string, args: Record<string, unknown>) => Promise<ToolResult> }
  readonly exec?: Exec
}): AgentSurface {
  const log = input.log ?? silentLog
  const builds =
    input.builds ??
    makeBuilds({
      root: defaultBuildRoot(),
      platform: input.facts.platform,
      home: homedir(),
      exec: input.exec ?? spawnExec,
    })
  const instructions = [
    `This MCP drives the desktop "${input.facts.name}" (${input.facts.placement}, ${input.facts.platform}).`,
    "Call claim_session first and pass session_id on later tools.",
    "fetch_build downloads a GitHub build with gh on this desktop. install_build places that program on macOS, Windows, or Linux.",
    "A failed tool returns isError and structuredContent.code. Read the code and recover.",
    "Release the hold when the test is finished.",
    "desktop_busy means another holder has the desktop.",
  ].join(" ")

  const driverTools = (): Effect.Effect<readonly ToolDefinition[]> =>
    input.driver.listTools().pipe(
      Effect.map((tools) =>
        tools.filter((tool) => !CONTROL.has(tool.name)).map((tool) => withSessionArg(tool)),
      ),
    )

  const listTools = () =>
    driverTools().pipe(
      Effect.map((tools) => [
        describeDesktopTool,
        listDesktopsTool,
        claimSessionTool,
        releaseSessionTool,
        listSessionsTool,
        ...builds.tools,
        ...tools,
      ]),
    )

  const call: AgentSurface["call"] = (name, args) => {
    switch (name) {
      case "describe_desktop":
        return Effect.succeed(
          toolOk(`${input.facts.name} is a ${input.facts.placement} desktop.`, {
            ...input.facts,
            lease: "exclusive",
            mcp: "/mcp",
            health: "/health",
          }),
        )
      case "list_desktops":
        return Effect.succeed(
          toolOk(`1 desktop.`, {
            desktops: [
              {
                id: input.facts.id,
                name: input.facts.name,
                placement: input.facts.placement,
                driver: input.facts.driver,
                online: true,
                hold: "runner",
              },
            ],
          }),
        )
      case "claim_session":
        return claim(args)
      case "release_session":
        return release(args)
      case "list_sessions":
        return input.hold.list().pipe(
          Effect.map((sessions) => toolOk(`${sessions.length} holds.`, { sessions: sessions.map((session) => sessionJson(session, input.facts.id)) })),
        )
      default:
        return drive(name, args)
    }
  }

  const claim = (args: Record<string, unknown>) => {
    const holder = typeof args["holder"] === "string" ? args["holder"] : ""
    const purpose = typeof args["purpose"] === "string" ? args["purpose"] : ""
    const ttl = typeof args["ttl_seconds"] === "number" ? args["ttl_seconds"] : DEFAULT_TTL_SECONDS
    return input.hold.claim({ holder, purpose, ttlSeconds: ttl }).pipe(
      Effect.map((session) => {
        log("claim", { desktop: input.facts.id, holder: session.holder, session: session.id })
        return toolOk(`Claimed ${input.facts.name} as ${session.holder}.`, sessionJson(session, input.facts.id))
      }),
      Effect.catchAll((error) => {
        if (error._tag === "DesktopBusy") {
          log("desktop_busy", { desktop: input.facts.id, holder: error.holder })
        }
        return Effect.succeed(holdErrorToTool(error))
      }),
    )
  }

  const release = (args: Record<string, unknown>) => {
    const sessionId = sessionIdOf(args)
    if (!sessionId) return Effect.succeed(toolError("invalid_argument", "Pass session_id."))
    return input.hold.release(sessionId).pipe(
      Effect.map((session) => {
        log("release", { desktop: input.facts.id, holder: session.holder, session: session.id })
        return toolOk(`Released hold ${session.id}.`, { released: true, ...sessionJson(session, input.facts.id) })
      }),
      Effect.catchAll((error) => Effect.succeed(holdErrorToTool(error))),
    )
  }

  const drive = (name: string, args: Record<string, unknown>) => {
    const sessionId = sessionIdOf(args)
    if (!sessionId) {
      return Effect.succeed(toolError("session_required", "claim_session first and pass session_id."))
    }
    if (BUILD.has(name)) {
      return input.hold.require(sessionId).pipe(
        Effect.flatMap(() =>
          Effect.tryPromise(() => builds.call(name, args)).pipe(
            Effect.catchAll((error) =>
              Effect.succeed(toolError("gh_failed", error instanceof Error ? error.message : "The build tool failed.")),
            ),
          ),
        ),
        Effect.catchAll((error) => Effect.succeed(holdErrorToTool(error))),
      )
    }
    return input.hold.require(sessionId).pipe(
      Effect.flatMap(() => input.driver.call(name, omitKey(args, "session_id"))),
      Effect.catchAll((error) => Effect.succeed(holdErrorToTool(error))),
    )
  }

  return { instructions, listTools, call }
}
