import { Effect } from "effect"
import { MCP_PROTOCOL_VERSIONS, VERSION, isRecord, type AgentSurface } from "./types"

export type RpcId = string | number | null

export type RpcOutcome =
  | { readonly type: "empty" }
  | { readonly type: "json"; readonly status: number; readonly body: unknown }

function errorBody(id: RpcId, code: number, message: string) {
  return { jsonrpc: "2.0" as const, id, error: { code, message } }
}

function resultBody(id: RpcId, result: unknown) {
  return { jsonrpc: "2.0" as const, id, result }
}

export function handleRpc(message: unknown, surface: AgentSurface): Effect.Effect<RpcOutcome> {
  if (!isRecord(message) || Array.isArray(message)) {
    return Effect.succeed({
      type: "json",
      status: 400,
      body: errorBody(null, -32600, "Expected one JSON-RPC object."),
    })
  }
  const id = "id" in message ? (message["id"] as RpcId) : undefined
  const method = message["method"]
  if (message["jsonrpc"] !== "2.0" || typeof method !== "string") {
    return Effect.succeed({
      type: "json",
      status: 400,
      body: errorBody(id ?? null, -32600, "Invalid JSON-RPC request."),
    })
  }
  const hasId = id !== undefined
  const params = message["params"]
  if (method === "notifications/initialized" || method.startsWith("notifications/")) {
    return Effect.succeed({ type: "empty" })
  }
  if (!hasId) {
    return Effect.succeed({
      type: "json",
      status: 400,
      body: errorBody(null, -32600, "Request is missing id."),
    })
  }
  switch (method) {
    case "initialize":
      return Effect.succeed({ type: "json", status: 200, body: resultBody(id, initializeResult(params, surface)) })
    case "ping":
      return Effect.succeed({ type: "json", status: 200, body: resultBody(id, {}) })
    case "tools/list":
      return surface.listTools().pipe(Effect.map((tools) => ({ type: "json" as const, status: 200, body: resultBody(id, { tools }) })))
    case "tools/call":
      return callTool(id, params, surface)
    default:
      return Effect.succeed({
        type: "json",
        status: 200,
        body: errorBody(id, -32601, `Unknown method ${method}.`),
      })
  }
}

function initializeResult(params: unknown, surface: AgentSurface) {
  const requested = isRecord(params) && typeof params["protocolVersion"] === "string" ? params["protocolVersion"] : ""
  const protocolVersion = MCP_PROTOCOL_VERSIONS.find((version) => version === requested) ?? "2025-03-26"
  return {
    protocolVersion,
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: "cua-runner", version: VERSION },
    instructions: surface.instructions,
  }
}

function callTool(id: RpcId, params: unknown, surface: AgentSurface): Effect.Effect<RpcOutcome> {
  if (!isRecord(params) || typeof params["name"] !== "string" || params["name"].length === 0) {
    return Effect.succeed({
      type: "json",
      status: 200,
      body: errorBody(id, -32602, "tools/call requires name."),
    })
  }
  const rawArgs = params["arguments"] ?? {}
  if (!isRecord(rawArgs)) {
    return Effect.succeed({
      type: "json",
      status: 200,
      body: errorBody(id, -32602, "tools/call arguments must be an object."),
    })
  }
  return surface.call(params["name"], rawArgs).pipe(
    Effect.map((result) => ({ type: "json" as const, status: 200, body: resultBody(id, result) })),
  )
}
