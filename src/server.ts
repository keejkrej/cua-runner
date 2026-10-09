import { authorize, bearerFrom } from "./bind"
import type { RelayHub } from "./relay-hub"
import { handleSurfaceHttp } from "./surface-http"
import { isRecord, type AgentSurface } from "./types"

export type ListenOptions = {
  readonly hostname: string
  readonly port: number
  readonly token?: string
  readonly allowLan: boolean
  readonly allowPublic: boolean
}

export type RunningServer = {
  readonly port: number
  readonly url: string
  readonly stop: () => void
}

const MAX_BODY = 32 * 1024 * 1024

function tooLarge(request: Request): boolean {
  const length = request.headers.get("content-length")
  return length !== null && Number(length) > MAX_BODY
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

export function startSurfaceServer(listen: ListenOptions, surface: AgentSurface): RunningServer {
  const server = Bun.serve({
    hostname: listen.hostname,
    port: listen.port,
    idleTimeout: 240,
    fetch: async (request, bunServer) => {
      if (tooLarge(request)) return json(413, { error: "body_too_large" })
      const url = new URL(request.url)
      if (request.method === "GET" && url.pathname === "/health") {
        return new Response(null, { status: 204 })
      }
      const decision = authorize({
        expectedToken: listen.token,
        presentedToken: bearerFrom(request.headers),
        remoteAddress: bunServer.requestIP(request)?.address ?? null,
        allowPublic: listen.allowPublic,
        listenHost: listen.hostname,
      })
      if (!decision.ok) return json(decision.status, { error: decision.code })
      const bodyText = request.method === "GET" ? "" : await request.text()
      const result = await handleSurfaceHttp({
        method: request.method,
        path: url.pathname,
        bodyText,
        accept: request.headers.get("accept"),
        surface,
      })
      return new Response(result.bodyText.length > 0 ? result.bodyText : null, {
        status: result.status,
        headers: { "content-type": result.contentType },
      })
    },
  })
  return {
    port: server.port ?? listen.port,
    url: `http://${listen.hostname}:${server.port ?? listen.port}`,
    stop: () => {
      server.stop(true)
    },
  }
}

export function startRelayServer(listen: ListenOptions, hub: RelayHub): RunningServer {
  const server = Bun.serve({
    hostname: listen.hostname,
    port: listen.port,
    idleTimeout: 240,
    fetch: async (request, bunServer) => {
      if (tooLarge(request)) return json(413, { error: "body_too_large" })
      const url = new URL(request.url)
      if (request.method === "GET" && url.pathname === "/health") {
        return new Response(null, { status: 204 })
      }
      const decision = authorize({
        expectedToken: listen.token,
        presentedToken: bearerFrom(request.headers),
        remoteAddress: bunServer.requestIP(request)?.address ?? null,
        allowPublic: listen.allowPublic,
        listenHost: listen.hostname,
      })
      if (!decision.ok) return json(decision.status, { error: decision.code })
      if (request.method === "POST" && url.pathname === "/relay/hello") return hello(hub, await request.json().catch(() => null))
      if (request.method === "POST" && url.pathname === "/relay/pull") return pull(hub, await request.json().catch(() => null))
      if (request.method === "POST" && url.pathname === "/relay/respond") return respond(hub, await request.json().catch(() => null))
      const proxied = /^\/r\/([a-z0-9][a-z0-9-]{0,63})(\/mcp|\/health)$/.exec(url.pathname)
      if (proxied && (request.method === "POST" || request.method === "GET")) {
        const runnerId = proxied[1]
        const path = proxied[2]
        if (!runnerId || !path) return new Response("not found", { status: 404 })
        const result = await hub.proxy(runnerId, {
          method: request.method,
          path,
          bodyText: request.method === "GET" ? "" : await request.text(),
          accept: request.headers.get("accept"),
        })
        if (!result.ok) return json(statusFor(result.code), { error: result.code })
        return new Response(result.value.bodyText.length > 0 ? result.value.bodyText : null, {
          status: result.value.status,
          headers: { "content-type": result.value.contentType },
        })
      }
      return new Response("not found", { status: 404 })
    },
  })
  return {
    port: server.port ?? listen.port,
    url: `http://${listen.hostname}:${server.port ?? listen.port}`,
    stop: () => {
      server.stop(true)
    },
  }
}

function statusFor(code: string): number {
  switch (code) {
    case "offline":
    case "replaced":
      return 502
    case "busy":
      return 429
    case "timeout":
      return 504
    case "stale":
    case "pull_in_progress":
      return 409
    case "unknown_request":
      return 404
    default:
      return 500
  }
}

async function hello(hub: RelayHub, body: unknown): Promise<Response> {
  if (!isRecord(body) || typeof body["runner_id"] !== "string" || typeof body["name"] !== "string") {
    return json(400, { error: "invalid_hello" })
  }
  const placement = typeof body["placement"] === "string" ? body["placement"] : "native"
  return json(200, hub.hello({ runnerId: body["runner_id"], name: body["name"], placement }))
}

async function pull(hub: RelayHub, body: unknown): Promise<Response> {
  if (!isRecord(body) || typeof body["runner_id"] !== "string" || typeof body["generation"] !== "number") {
    return json(400, { error: "invalid_pull" })
  }
  const result = await hub.pull(body["runner_id"], body["generation"])
  if (!result.ok) return json(statusFor(result.code), { error: result.code })
  return json(200, result.value)
}

async function respond(hub: RelayHub, body: unknown): Promise<Response> {
  if (
    !isRecord(body) ||
    typeof body["runner_id"] !== "string" ||
    typeof body["generation"] !== "number" ||
    typeof body["request_id"] !== "string" ||
    typeof body["status"] !== "number" ||
    typeof body["body_text"] !== "string"
  ) {
    return json(400, { error: "invalid_respond" })
  }
  const result = hub.respond(body["runner_id"], body["generation"], body["request_id"], {
    status: body["status"],
    contentType: typeof body["content_type"] === "string" ? body["content_type"] : "application/json",
    bodyText: body["body_text"],
  })
  if (!result.ok) return json(statusFor(result.code), { error: result.code })
  return json(200, result.value)
}
