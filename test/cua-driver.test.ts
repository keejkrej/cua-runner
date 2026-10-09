import { describe, expect, test } from "vitest"
import { Effect } from "effect"
import { startCuaDriver } from "../src/cua-driver"
import { FrameParser, encodeFrame } from "../src/stdio-frame"
import { makeHold } from "../src/hold"
import { makeRunner } from "../src/runner"
import { facts } from "./helpers"

describe("cua driver stdio", () => {
  test("frames split across chunks", () => {
    const parser = new FrameParser()
    const frame = encodeFrame({ ok: true })
    expect(parser.push(frame.subarray(0, 5))).toEqual([])
    expect(parser.push(frame.subarray(5))).toEqual([{ ok: true }])
  })

  test("strips session_id before the driver sees the call", async () => {
    const started = await startCuaDriver([process.execPath, "--import", "tsx", "test/fixtures/stdio-mcp.ts"])
    try {
      const hold = await Effect.runPromise(makeHold())
      const surface = makeRunner({ facts: facts("mini"), hold, driver: started.driver })
      const claim = await Effect.runPromise(
        surface.call("claim_session", { holder: "claude", purpose: "driver" }),
      )
      const sessionId = (claim.structuredContent as { session_id: string }).session_id
      const echoed = await Effect.runPromise(
        surface.call("echo", { session_id: sessionId, message: "hello" }),
      )
      expect(echoed.isError).toBe(false)
      expect(echoed.structuredContent).toEqual({ arguments: { message: "hello" } })
    } finally {
      started.close()
    }
  })
})
