import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, test } from "vitest"
import { Effect } from "effect"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeDispatch } from "../src/dispatch"
import { startSurfaceServer, type RunningServer } from "../src/server"
import type { AgentSurface } from "../src/types"
import { mcp, startMemoryDesktop, toolResult } from "./helpers"

const servers: RunningServer[] = []

afterEach(() => {
  for (const server of servers) server.stop()
  servers.length = 0
})

function startDispatch(desktops: unknown): Promise<{ server: RunningServer; surface: AgentSurface }> {
  const dir = mkdtempSync(join(tmpdir(), "cua-desktops-"))
  const path = join(dir, "desktops.json")
  writeFileSync(path, JSON.stringify(desktops))
  return (async () => {
    const { loadDesktops } = await import("../src/config")
    const surface = await Effect.runPromise(makeDispatch(loadDesktops(path)))
    const server = await startSurfaceServer(
      { hostname: "127.0.0.1", port: 0, token: "dispatch", allowLan: false, allowPublic: false },
      surface,
    )
    servers.push(server)
    return { server, surface }
  })()
}

describe("dispatch", () => {
  test("routes each hold to its own desktop", async () => {
    const mini = await startMemoryDesktop({ id: "mini", token: "mini-token", placement: "native" })
    const vm = await startMemoryDesktop({ id: "vm", token: "vm-token", placement: "vm" })
    servers.push(mini.server, vm.server)
    const { server } = await startDispatch([
      { id: "mini", name: "desktop", url: `${mini.server.url}/mcp`, token: "mini-token", placement: "native" },
      { id: "vm", name: "Local VM", url: `${vm.server.url}/mcp`, token: "vm-token", placement: "vm" },
    ])
    const desktops = toolResult(
      (await mcp(`${server.url}/mcp`, "tools/call", { name: "list_desktops", arguments: {} }, { token: "dispatch" })).body,
    )
    expect(desktops.structuredContent?.["desktops"]).toHaveLength(2)

    const claimMini = toolResult(
      (
        await mcp(
          `${server.url}/mcp`,
          "tools/call",
          { name: "claim_session", arguments: { desktop_id: "mini", holder: "claude", purpose: "qa" } },
          { token: "dispatch" },
        )
      ).body,
    )
    const miniSession = claimMini.structuredContent?.["session_id"]
    const claimVm = toolResult(
      (
        await mcp(
          `${server.url}/mcp`,
          "tools/call",
          { name: "claim_session", arguments: { desktop_id: "vm", holder: "ci", purpose: "vm qa" } },
          { token: "dispatch" },
        )
      ).body,
    )
    expect(typeof claimVm.structuredContent?.["session_id"]).toBe("string")
    const blocked = toolResult(
      (
        await mcp(
          `${server.url}/mcp`,
          "tools/call",
          { name: "claim_session", arguments: { desktop_id: "mini", holder: "ci", purpose: "steal" } },
          { token: "dispatch" },
        )
      ).body,
    )
    expect(blocked.structuredContent?.["code"]).toBe("desktop_busy")

    const launch = toolResult(
      (
        await mcp(
          `${server.url}/mcp`,
          "tools/call",
          { name: "launch_app", arguments: { session_id: miniSession, name: "Notes" } },
          { token: "dispatch" },
        )
      ).body,
    )
    expect(launch.structuredContent?.["bundle_id"]).toBe("com.apple.notes")
    const direct = toolResult(
      (
        await mcp(
          `${mini.server.url}/mcp`,
          "tools/call",
          { name: "list_windows", arguments: { session_id: miniSession } },
          { token: "mini-token" },
        )
      ).body,
    )
    expect(direct.text).toContain("1 windows")
    const vmWindows = toolResult(
      (
        await mcp(
          `${vm.server.url}/mcp`,
          "tools/call",
          { name: "list_windows", arguments: { session_id: claimVm.structuredContent?.["session_id"] } },
          { token: "vm-token" },
        )
      ).body,
    )
    expect(vmWindows.text).toContain("0 windows")
  })

  test("holds a cloud-style MCP locally and strips session_id", async () => {
    const seen: unknown[] = []
    const echoServer = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk)
      const text = Buffer.concat(chunks).toString("utf8")
      const body = (JSON.parse(text || "{}")) as { id?: number; method?: string; params?: { arguments?: unknown } }
      if (body.method === "initialize") {
        res.statusCode = 200
        res.setHeader("content-type", "application/json")
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "echo", version: "0" } },
        }))
        return
      }
      if (body.method === "notifications/initialized") {
        res.statusCode = 202
        res.end()
        return
      }
      if (body.method === "tools/list") {
        res.statusCode = 200
        res.setHeader("content-type", "application/json")
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            tools: [
              {
                name: "echo",
                description: "Echo",
                inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
              },
            ],
          },
        }))
        return
      }
      seen.push(body.params?.arguments)
      res.statusCode = 200
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        result: { content: [{ type: "text", text: "echoed" }], isError: false, structuredContent: { arguments: body.params?.arguments } },
      }))
    })
    await new Promise<void>((resolve, reject) => {
      echoServer.listen(0, "127.0.0.1", () => resolve())
      echoServer.on("error", reject)
    })
    const echoPort = (echoServer.address() as AddressInfo).port
    servers.push({
      port: echoPort,
      url: `http://127.0.0.1:${echoPort}`,
      stop: () => {
        echoServer.closeAllConnections?.()
        echoServer.close()
      },
    })
    const { server } = await startDispatch([
      {
        id: "cloud",
        name: "Hosted sandbox",
        url: `http://127.0.0.1:${echoPort}/mcp`,
        placement: "cloud",
        lease: "local",
      },
    ])
    const claim = toolResult(
      (
        await mcp(
          `${server.url}/mcp`,
          "tools/call",
          { name: "claim_session", arguments: { holder: "claude", purpose: "sandbox" } },
          { token: "dispatch" },
        )
      ).body,
    )
    const echoed = toolResult(
      (
        await mcp(
          `${server.url}/mcp`,
          "tools/call",
          { name: "echo", arguments: { session_id: claim.structuredContent?.["session_id"], message: "hi" } },
          { token: "dispatch" },
        )
      ).body,
    )
    expect(echoed.structuredContent?.["arguments"]).toEqual({ message: "hi" })
    expect(seen.at(-1)).toEqual({ message: "hi" })
  })
})
