import { describe, expect, test } from "vitest"
import { Effect } from "effect"
import { makeHold } from "../src/hold"

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

describe("hold", () => {
  test("one holder at a time, with refresh and expiry", async () => {
    let now = 1_000
    const ids = ["s1", "s2"]
    const hold = await run(makeHold({ now: () => now, newId: () => ids.shift() ?? "sx" }))
    const first = await run(hold.claim({ holder: "claude", purpose: "smoke", ttlSeconds: 10 }))
    expect(first.id).toBe("s1")
    const refreshed = await run(hold.claim({ holder: "claude", purpose: "still smoke", ttlSeconds: 10 }))
    expect(refreshed.id).toBe("s1")
    expect(refreshed.purpose).toBe("still smoke")
    const busy = await run(Effect.either(hold.claim({ holder: "ci", purpose: "other", ttlSeconds: 10 })))
    expect(busy._tag).toBe("Left")
    if (busy._tag === "Left") expect(busy.left._tag).toBe("DesktopBusy")
    now = refreshed.expiresAt + 1
    const next = await run(hold.claim({ holder: "ci", purpose: "other", ttlSeconds: 10 }))
    expect(next.id).toBe("s2")
    const expired = await run(Effect.either(hold.require("s1")))
    expect(expired._tag).toBe("Left")
    await run(hold.release(next.id))
    const missing = await run(Effect.either(hold.require(next.id)))
    expect(missing._tag).toBe("Left")
  })
})
