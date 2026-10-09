import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ConfigError, loadDesktops, parseArgs, parseListen, slug } from "../src/config"

describe("config", () => {
  test("parses listen addresses and slugs", () => {
    expect(parseListen("127.0.0.1:3213")).toEqual({ host: "127.0.0.1", port: 3213 })
    expect(parseListen("[::1]:3213")).toEqual({ host: "::1", port: 3213 })
    expect(slug("Lab desktop")).toBe("lab-desktop")
  })

  test("reads a token file and a desktop list", () => {
    const dir = mkdtempSync(join(tmpdir(), "cua-config-"))
    const tokenFile = join(dir, "token")
    writeFileSync(tokenFile, "abc\n")
    const desktops = join(dir, "desktops.json")
    writeFileSync(
      desktops,
      JSON.stringify([{ id: "desk", name: "desktop", url: "http://127.0.0.1:3213", placement: "native", token: "abc" }]),
    )
    const cli = parseArgs(["serve", "--token-file", tokenFile], {})
    expect(cli.command).toBe("serve")
    if (cli.command === "serve") {
      expect(cli.token).toBe("abc")
      expect(cli.placement).toBe("native")
      expect(cli.driver).toBe("memory")
    }
    expect(loadDesktops(desktops)[0]?.id).toBe("desk")
    expect(() => parseArgs(["dispatch"], {})).toThrow(ConfigError)
    expect(() => parseArgs(["serve", "--placement", "cloud"], {})).toThrow(ConfigError)
  })
})
