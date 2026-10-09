import { Effect } from "effect"
import { makeHold } from "../src/hold"
import { makeMemoryDriver } from "../src/memory-desktop"
import { makeRunner } from "../src/runner"
import { startSurfaceServer, type RunningServer } from "../src/server"
import type { AgentSurface, DesktopFacts, Placement } from "../src/types"

export function facts(id: string, placement: Placement = "native"): DesktopFacts {
  return { id, name: id, placement, driver: "memory", protocol: 1, platform: "test", arch: "test" }
}

export async function startMemoryDesktop(opts: {
  readonly id: string
  readonly token?: string
  readonly placement?: Placement
}): Promise<{ server: RunningServer; surface: AgentSurface }> {
  const hold = await Effect.runPromise(makeHold())
  const surface = makeRunner({ facts: facts(opts.id, opts.placement), hold, driver: makeMemoryDriver() })
  const server = await startSurfaceServer(
    {
      hostname: "127.0.0.1",
      port: 0,
      ...(opts.token ? { token: opts.token } : {}),
      allowLan: false,
      allowPublic: false,
    },
    surface,
  )
  return { server, surface }
}

export async function mcp(
  url: string,
  method: string,
  params?: unknown,
  opts?: { readonly token?: string; readonly accept?: string },
): Promise<{ status: number; body: unknown; contentType: string | null }> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: opts?.accept ?? "application/json",
  }
  if (opts?.token) headers.authorization = `Bearer ${opts.token}`
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  })
  const text = await response.text()
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    body: text.length === 0 ? null : JSON.parse(text),
  }
}

export function toolResult(body: unknown): { isError?: boolean; structuredContent?: Record<string, unknown>; text?: string } {
  if (!body || typeof body !== "object" || !("result" in body)) return {}
  const result = (body as { result?: unknown }).result
  if (!result || typeof result !== "object") return {}
  const record = result as { isError?: boolean; structuredContent?: Record<string, unknown>; content?: Array<{ text?: string }> }
  return {
    isError: record.isError,
    structuredContent: record.structuredContent,
    text: record.content?.[0]?.text,
  }
}
