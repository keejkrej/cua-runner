import { afterEach, describe, expect, test } from "vitest"
import { Effect } from "effect"
import { makeHold } from "../src/hold"
import { makeMemoryDriver } from "../src/memory-desktop"
import { RelayHub } from "../src/relay-hub"
import { relayLoop } from "../src/relay-agent"
import { makeRunner } from "../src/runner"
import { startRelayServer, type RunningServer } from "../src/server"
import { handleSurfaceHttp } from "../src/surface-http"
import { facts, mcp, toolResult } from "./helpers"

const servers: RunningServer[] = []

afterEach(() => {
  for (const server of servers) server.stop()
  servers.length = 0
})

describe("relay", () => {
  test("wakes a waiting runner and completes the client call", async () => {
    const hub = new RelayHub({ pullWaitMs: 40, proxyWaitMs: 1_000, maxPending: 2 })
    expect(hub.hello({ runnerId: "mini", name: "desktop", placement: "native" }).generation).toBe(1)
    const pending = hub.proxy("mini", { method: "POST", path: "/mcp", bodyText: "{}", accept: null })
    const pulled = await hub.pull("mini", 1)
    expect(pulled.ok).toBe(true)
    if (!pulled.ok || pulled.value.idle) throw new Error("expected a request")
    expect(hub.respond("mini", 1, pulled.value.request.requestId, { status: 200, contentType: "application/json", bodyText: "ok" }).ok).toBe(true)
    const completed = await pending
    expect(completed.ok).toBe(true)
    if (completed.ok) expect(completed.value.bodyText).toBe("ok")
    const idle = await hub.pull("mini", 1)
    expect(idle.ok && idle.value.idle).toBe(true)
  })

  test("a replaced runner fails the in-flight client", async () => {
    const hub = new RelayHub({ pullWaitMs: 50, proxyWaitMs: 1_000, maxPending: 2 })
    hub.hello({ runnerId: "mini", name: "desktop", placement: "native" })
    const pending = hub.proxy("gone", { method: "GET", path: "/health", bodyText: "", accept: null })
    expect((await pending).ok).toBe(false)
    const live = hub.proxy("mini", { method: "GET", path: "/health", bodyText: "", accept: null })
    hub.hello({ runnerId: "mini", name: "desktop", placement: "native" })
    const replaced = await live
    expect(replaced.ok).toBe(false)
    if (!replaced.ok) expect(replaced.code).toBe("replaced")
  })

  test("proxies MCP through an outbound runner", async () => {
    const hold = await Effect.runPromise(makeHold())
    const surface = makeRunner({ facts: facts("mini"), hold, driver: makeMemoryDriver() })
    const hub = new RelayHub({ pullWaitMs: 20_000, proxyWaitMs: 5_000, maxPending: 4 })
    const relay = await startRelayServer(
      { hostname: "127.0.0.1", port: 0, token: "relay-secret", allowLan: false, allowPublic: false },
      hub,
    )
    servers.push(relay)
    const abort = new AbortController()
    const loop = relayLoop({
      relayUrl: relay.url,
      token: "relay-secret",
      runnerId: "mini",
      name: "desktop",
      placement: "native",
      signal: abort.signal,
      retryMs: 20,
      handle: (input) => handleSurfaceHttp({ ...input, surface }),
    })
    const claim = await waitForClaim(relay.url)
    expect(claim.structuredContent?.["holder"]).toBe("claude")
    const launch = toolResult(
      (
        await mcp(
          `${relay.url}/r/mini/mcp`,
          "tools/call",
          {
            name: "launch_app",
            arguments: { session_id: claim.structuredContent?.["session_id"], bundle_id: "com.apple.calculator" },
          },
          { token: "relay-secret" },
        )
      ).body,
    )
    expect(launch.structuredContent?.["pid"]).toBe(1000)
    abort.abort()
    await loop
  })
})

async function waitForClaim(relayUrl: string) {
  let last = "offline"
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await mcp(
      `${relayUrl}/r/mini/mcp`,
      "tools/call",
      { name: "claim_session", arguments: { holder: "claude", purpose: "via relay" } },
      { token: "relay-secret" },
    )
    if (response.status === 200) {
      const result = toolResult(response.body)
      if (result.structuredContent?.["session_id"]) return result
      last = result.text ?? "no session"
    } else {
      last = String(response.status)
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`runner did not attach: ${last}`)
}
