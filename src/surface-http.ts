import { Effect } from "effect"
import { encodePayload } from "./codec"
import { handleRpc } from "./mcp"
import type { AgentSurface } from "./types"

export type HttpResult = {
  readonly status: number
  readonly contentType: string
  readonly bodyText: string
}

export async function handleSurfaceHttp(input: {
  readonly method: string
  readonly path: string
  readonly bodyText: string
  readonly accept: string | null
  readonly surface: AgentSurface
}): Promise<HttpResult> {
  if (input.method === "GET" && input.path === "/health") {
    return { status: 204, contentType: "text/plain", bodyText: "" }
  }
  if (input.method === "POST" && input.path === "/mcp") {
    let message: unknown
    try {
      message = input.bodyText.length === 0 ? null : JSON.parse(input.bodyText)
    } catch {
      return encoded(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error." } }, input.accept)
    }
    const outcome = await Effect.runPromise(handleRpc(message, input.surface))
    if (outcome.type === "empty") return { status: 202, contentType: "application/json", bodyText: "" }
    return encoded(outcome.status, outcome.body, input.accept)
  }
  return { status: 404, contentType: "text/plain", bodyText: "not found" }
}

function encoded(status: number, payload: unknown, accept: string | null): HttpResult {
  const encodedPayload = encodePayload(payload, accept)
  return { status, contentType: encodedPayload.contentType, bodyText: encodedPayload.bodyText }
}
