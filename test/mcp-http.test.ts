import { afterEach, describe, expect, test } from "bun:test"
import { PIXEL_PNG } from "../src/memory-desktop"
import { parsePayload } from "../src/codec"
import type { RunningServer } from "../src/server"
import { mcp, startMemoryDesktop, toolResult } from "./helpers"

const servers: RunningServer[] = []

afterEach(() => {
  for (const server of servers) server.stop()
  servers.length = 0
})

describe("desktop MCP", () => {
  test("claims a hold and drives the memory calculator", async () => {
    const { server } = await startMemoryDesktop({ id: "mini", token: "secret" })
    servers.push(server)
    const health = await fetch(`${server.url}/health`)
    expect(health.status).toBe(204)
    const denied = await mcp(`${server.url}/mcp`, "tools/list")
    expect(denied.status).toBe(401)

    const listed = await mcp(`${server.url}/mcp`, "tools/list", {}, { token: "secret" })
    expect(listed.status).toBe(200)
    const tools = (listed.body as { result: { tools: Array<{ name: string }> } }).result.tools.map((tool) => tool.name)
    expect(tools).toContain("claim_session")
    expect(tools).toContain("click")
    expect(tools).toContain("get_window_state")

    const early = toolResult(await mcp(`${server.url}/mcp`, "tools/call", { name: "click", arguments: {} }, { token: "secret" }).then((response) => response.body))
    expect(early.structuredContent?.["code"]).toBe("session_required")

    const claim = toolResult(
      (
        await mcp(
          `${server.url}/mcp`,
          "tools/call",
          { name: "claim_session", arguments: { holder: "claude", purpose: "calculator" } },
          { token: "secret" },
        )
      ).body,
    )
    const sessionId = claim.structuredContent?.["session_id"]
    expect(typeof sessionId).toBe("string")

    const busy = toolResult(
      (
        await mcp(
          `${server.url}/mcp`,
          "tools/call",
          { name: "claim_session", arguments: { holder: "ci", purpose: "other" } },
          { token: "secret" },
        )
      ).body,
    )
    expect(busy.structuredContent?.["code"]).toBe("desktop_busy")

    const launch = toolResult(
      (
        await mcp(
          `${server.url}/mcp`,
          "tools/call",
          { name: "launch_app", arguments: { session_id: sessionId, bundle_id: "com.apple.calculator" } },
          { token: "secret" },
        )
      ).body,
    )
    const pid = launch.structuredContent?.["pid"]
    const windows = launch.structuredContent?.["windows"]
    const windowId = Array.isArray(windows) ? (windows[0] as { window_id?: number } | undefined)?.window_id : undefined
    const click = (elementIndex: number) =>
      mcp(
        `${server.url}/mcp`,
        "tools/call",
        { name: "click", arguments: { session_id: sessionId, pid, window_id: windowId, element_index: elementIndex } },
        { token: "secret" },
      )
    await click(6)
    await click(11)
    await click(7)
    await click(12)
    const state = toolResult(
      (
        await mcp(
          `${server.url}/mcp`,
          "tools/call",
          {
            name: "get_window_state",
            arguments: { session_id: sessionId, pid, window_id: windowId },
          },
          { token: "secret" },
        )
      ).body,
    )
    const elements = state.structuredContent?.["elements"]
    const display = Array.isArray(elements)
      ? (elements as Array<{ label: string; value?: string }>).find((element) => element.label === "display")
      : undefined
    expect(display?.value).toBe("13")
    expect(state.text).toContain("[6]")

    const stream = await fetch(`${server.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        authorization: "Bearer secret",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    })
    const text = await stream.text()
    expect(stream.headers.get("content-type")).toContain("text/event-stream")
    expect(text.startsWith("event: message\ndata:")).toBe(true)
    expect(parsePayload(stream.headers.get("content-type"), text)).toEqual({ jsonrpc: "2.0", id: 1, result: {} })
  })

  test("memory screenshots are a real PNG", () => {
    const bytes = Buffer.from(PIXEL_PNG, "base64")
    expect(bytes.subarray(0, 4).toString("hex")).toBe("89504e47")
  })
})
