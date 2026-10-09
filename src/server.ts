import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
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

function readBodyText(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on("data", (chunk: Buffer) => chunks.push(chunk))
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    req.on("error", reject)
  })
}

function reqHeaders(req: IncomingMessage): Headers {
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v)
    } else if (value !== undefined) {
      headers.set(key, value)
    }
  }
  return headers
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader("content-type", "application/json")
  res.end(JSON.stringify(body))
}

function sendResponse(res: ServerResponse, status: number, contentType: string, bodyText: string): void {
  res.statusCode = status
  res.setHeader("content-type", contentType)
  res.end(bodyText.length > 0 ? bodyText : undefined)
}

export async function startSurfaceServer(listen: ListenOptions, surface: AgentSurface): Promise<RunningServer> {
  const server = createServer(async (req, res) => {
    const headers = reqHeaders(req)
    const length = headers.get("content-length")
    if (length !== null && Number(length) > MAX_BODY) {
      sendJson(res, 413, { error: "body_too_large" })
      return
    }
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? listen.hostname}`)
    if (req.method === "GET" && url.pathname === "/health") {
      res.statusCode = 204
      res.end()
      return
    }
    const remoteAddress = req.socket.remoteAddress ?? null
    const decision = authorize({
      expectedToken: listen.token,
      presentedToken: bearerFrom(headers),
      remoteAddress,
      allowPublic: listen.allowPublic,
      listenHost: listen.hostname,
    })
    if (!decision.ok) {
      sendJson(res, decision.status, { error: decision.code })
      return
    }
    const bodyText = req.method === "GET" ? "" : await readBodyText(req)
    const result = await handleSurfaceHttp({
      method: req.method ?? "GET",
      path: url.pathname,
      bodyText,
      accept: headers.get("accept"),
      surface,
    })
    sendResponse(res, result.status, result.contentType, result.bodyText)
  })

  await new Promise<void>((resolve, reject) => {
    server.listen(listen.port, listen.hostname, () => resolve())
    server.on("error", reject)
  })

  const addr = server.address() as AddressInfo | null
  const port = addr ? addr.port : listen.port
  return {
    port,
    url: `http://${listen.hostname}:${port}`,
    stop: () => {
      server.closeAllConnections?.()
      server.close()
    },
  }
}

export async function startRelayServer(listen: ListenOptions, hub: RelayHub): Promise<RunningServer> {
  const server = createServer(async (req, res) => {
    const headers = reqHeaders(req)
    const length = headers.get("content-length")
    if (length !== null && Number(length) > MAX_BODY) {
      sendJson(res, 413, { error: "body_too_large" })
      return
    }
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? listen.hostname}`)
    if (req.method === "GET" && url.pathname === "/health") {
      res.statusCode = 204
      res.end()
      return
    }
    const remoteAddress = req.socket.remoteAddress ?? null
    const decision = authorize({
      expectedToken: listen.token,
      presentedToken: bearerFrom(headers),
      remoteAddress,
      allowPublic: listen.allowPublic,
      listenHost: listen.hostname,
    })
    if (!decision.ok) {
      sendJson(res, decision.status, { error: decision.code })
      return
    }
    const bodyText = req.method === "GET" ? "" : await readBodyText(req)
    const parseJson = () => {
      try {
        return JSON.parse(bodyText)
      } catch {
        return null
      }
    }
    if (req.method === "POST" && url.pathname === "/relay/hello") {
      hello(hub, parseJson(), res)
      return
    }
    if (req.method === "POST" && url.pathname === "/relay/pull") {
      await pull(hub, parseJson(), res)
      return
    }
    if (req.method === "POST" && url.pathname === "/relay/respond") {
      respond(hub, parseJson(), res)
      return
    }
    const proxied = /^\/r\/([a-z0-9][a-z0-9-]{0,63})(\/mcp|\/health)$/.exec(url.pathname)
    if (proxied && (req.method === "POST" || req.method === "GET")) {
      const runnerId = proxied[1]
      const path = proxied[2]
      if (!runnerId || !path) {
        res.statusCode = 404
        res.end("not found")
        return
      }
      const result = await hub.proxy(runnerId, {
        method: req.method,
        path,
        bodyText: req.method === "GET" ? "" : bodyText,
        accept: headers.get("accept"),
      })
      if (!result.ok) {
        sendJson(res, statusFor(result.code), { error: result.code })
        return
      }
      sendResponse(res, result.value.status, result.value.contentType, result.value.bodyText)
      return
    }
    res.statusCode = 404
    res.end("not found")
  })

  await new Promise<void>((resolve, reject) => {
    server.listen(listen.port, listen.hostname, () => resolve())
    server.on("error", reject)
  })

  const addr = server.address() as AddressInfo | null
  const port = addr ? addr.port : listen.port
  return {
    port,
    url: `http://${listen.hostname}:${port}`,
    stop: () => {
      server.closeAllConnections?.()
      server.close()
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

function hello(hub: RelayHub, body: unknown, res: ServerResponse): void {
  if (!isRecord(body) || typeof body["runner_id"] !== "string" || typeof body["name"] !== "string") {
    sendJson(res, 400, { error: "invalid_hello" })
    return
  }
  const placement = typeof body["placement"] === "string" ? body["placement"] : "native"
  sendJson(res, 200, hub.hello({ runnerId: body["runner_id"], name: body["name"], placement }))
}

async function pull(hub: RelayHub, body: unknown, res: ServerResponse): Promise<void> {
  if (!isRecord(body) || typeof body["runner_id"] !== "string" || typeof body["generation"] !== "number") {
    sendJson(res, 400, { error: "invalid_pull" })
    return
  }
  const result = await hub.pull(body["runner_id"], body["generation"])
  if (!result.ok) {
    sendJson(res, statusFor(result.code), { error: result.code })
    return
  }
  sendJson(res, 200, result.value)
}

function respond(hub: RelayHub, body: unknown, res: ServerResponse): void {
  if (
    !isRecord(body) ||
    typeof body["runner_id"] !== "string" ||
    typeof body["generation"] !== "number" ||
    typeof body["request_id"] !== "string" ||
    typeof body["status"] !== "number" ||
    typeof body["body_text"] !== "string"
  ) {
    sendJson(res, 400, { error: "invalid_respond" })
    return
  }
  const result = hub.respond(body["runner_id"], body["generation"], body["request_id"], {
    status: body["status"],
    contentType: typeof body["content_type"] === "string" ? body["content_type"] : "application/json",
    bodyText: body["body_text"],
  })
  if (!result.ok) {
    sendJson(res, statusFor(result.code), { error: result.code })
    return
  }
  sendJson(res, 200, result.value)
}
