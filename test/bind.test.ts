import { describe, expect, test } from "vitest"
import { assertListenAllowed, authorize, classifyHost, tokenMatches } from "../src/bind"

describe("bind policy", () => {
  test("classifies loopback, LAN, Tailscale, and public addresses", () => {
    expect(classifyHost("127.0.0.1")).toBe("loopback")
    expect(classifyHost("localhost")).toBe("loopback")
    expect(classifyHost("::1")).toBe("loopback")
    expect(classifyHost("192.168.1.9")).toBe("private")
    expect(classifyHost("10.1.2.3")).toBe("private")
    expect(classifyHost("100.64.0.1")).toBe("tailscale")
    expect(classifyHost("fd7a:115c:a1e0::8")).toBe("tailscale")
    expect(classifyHost("0.0.0.0")).toBe("unspecified")
    expect(classifyHost("1.2.3.4")).toBe("public")
    expect(classifyHost("mini.tailnet.ts.net")).toBe("hostname")
  })

  test("loopback can omit a token, and other binds cannot", () => {
    expect(() => assertListenAllowed("127.0.0.1", { allowLan: false, allowPublic: false })).not.toThrow()
    expect(() => assertListenAllowed("0.0.0.0", { allowLan: false, allowPublic: false })).toThrow(/token/)
    expect(() => assertListenAllowed("0.0.0.0", { token: "t", allowLan: false, allowPublic: false })).toThrow(/allow-lan/)
    expect(() => assertListenAllowed("0.0.0.0", { token: "t", allowLan: true, allowPublic: false })).not.toThrow()
    expect(() => assertListenAllowed("1.2.3.4", { token: "t", allowLan: true, allowPublic: false })).toThrow(/allow-public/)
    expect(() => assertListenAllowed("100.80.1.2", { token: "t", allowLan: false, allowPublic: false })).not.toThrow()
  })

  test("rejects a public peer and a wrong token", () => {
    expect(tokenMatches("secret", "secret")).toBe(true)
    expect(tokenMatches("secret", "secret-x")).toBe(false)
    expect(
      authorize({
        expectedToken: "secret",
        presentedToken: "nope",
        remoteAddress: "127.0.0.1",
        allowPublic: false,
        listenHost: "127.0.0.1",
      }).ok,
    ).toBe(false)
    const blocked = authorize({
      expectedToken: "secret",
      presentedToken: "secret",
      remoteAddress: "8.8.8.8",
      allowPublic: false,
      listenHost: "0.0.0.0",
    })
    expect(blocked.ok).toBe(false)
    if (!blocked.ok) expect(blocked.status).toBe(403)
  })
})
