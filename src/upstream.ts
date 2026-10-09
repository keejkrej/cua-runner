import { parsePayload } from "./codec"
import { VERSION, asToolResult, isRecord, type ToolDefinition, type ToolResult } from "./types"

export class UpstreamHttpError extends Error {
  constructor(readonly status: number) {
    super(`Upstream HTTP ${status}.`)
    this.name = "UpstreamHttpError"
  }
}

export class UpstreamClient {
  private nextId = 1
  private sessionId: string | undefined
  private ready: Promise<void> | null = null

  constructor(
    readonly url: string,
    readonly token?: string,
    readonly timeoutMs = 60_000,
  ) {}

  async listTools(): Promise<readonly ToolDefinition[]> {
    const result = await this.request("tools/list", {})
    if (!isRecord(result) || !Array.isArray(result["tools"])) {
      throw new Error("tools/list returned no tools array.")
    }
    return result["tools"] as ToolDefinition[]
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    return asToolResult(await this.request("tools/call", { name, arguments: args }))
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    if (method !== "initialize" && method !== "notifications/initialized") {
      await this.ensureInitialized()
    }
    return this.send(method, params, false)
  }

  private ensureInitialized(): Promise<void> {
    if (this.ready) return this.ready
    this.ready = (async () => {
      await this.send(
        "initialize",
        {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "cua-runner", version: VERSION },
        },
        false,
      )
      await this.send("notifications/initialized", {}, true)
    })().catch((error: unknown) => {
      this.ready = null
      throw error
    })
    return this.ready
  }

  private async send(method: string, params: unknown, notify: boolean): Promise<unknown> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    }
    if (this.token) {
      const bearer = `Bearer ${this.token}`
      headers.authorization = bearer
      headers["x-cua-runner-authorization"] = bearer
      headers["x-cua-env-authorization"] = bearer
    }
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId
    const body = notify
      ? { jsonrpc: "2.0", method, params }
      : { jsonrpc: "2.0", id: this.nextId, method, params }
    if (!notify) this.nextId += 1
    const response = await fetch(this.url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    const session = response.headers.get("mcp-session-id")
    if (session) this.sessionId = session
    if (response.status === 202 || response.status === 204) return null
    const text = await response.text()
    if (response.status === 401 || response.status === 403) throw new UpstreamHttpError(response.status)
    if (response.status >= 400) throw new UpstreamHttpError(response.status)
    if (text.trim().length === 0) return null
    const payload = parsePayload(response.headers.get("content-type"), text)
    if (!isRecord(payload)) return payload
    if (isRecord(payload["error"])) {
      const message = typeof payload["error"]["message"] === "string" ? payload["error"]["message"] : "Upstream MCP error."
      throw new Error(message)
    }
    return payload["result"]
  }
}
