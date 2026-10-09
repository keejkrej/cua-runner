import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeBuilds, type Exec } from "../src/build"
import { makeHold } from "../src/hold"
import { makeMemoryDriver } from "../src/memory-desktop"
import { makeRunner } from "../src/runner"
import { errorCode } from "../src/types"
import { facts } from "./helpers"

describe("builds", () => {
  test("fetch_build asks gh for the run behind a sha", async () => {
    const root = await mkdtemp(join(tmpdir(), "cua-builds-"))
    const calls: string[][] = []
    const exec: Exec = async (argv) => {
      calls.push([...argv])
      if (argv[1] === "run" && argv[2] === "list") {
        return {
          code: 0,
          stdout: JSON.stringify([{ databaseId: 42, url: "https://github.com/acme/app/actions/runs/42", headSha: "abc1234", displayTitle: "fix" }]),
          stderr: "",
        }
      }
      const dir = argv[argv.indexOf("--dir") + 1] ?? root
      await writeFile(join(dir, "Acme.zip"), "zip")
      return { code: 0, stdout: "", stderr: "" }
    }
    const builds = makeBuilds({ root, platform: "darwin", home: root, exec })
    const result = await builds.call("fetch_build", {
      session_id: "s1",
      repo: "acme/app",
      sha: "abc1234",
      name: "mac-app",
    })
    expect(result.isError).toBe(false)
    expect(result.structuredContent).toMatchObject({ repo: "acme/app", run_id: "42", sha: "abc1234" })
    expect(calls[0]?.slice(0, 4)).toEqual(["gh", "run", "list", "--repo"])
    expect(calls[1]?.slice(0, 4)).toEqual(["gh", "run", "download", "42"])
  })

  test("gh auth failure is a tool error and the token is redacted", async () => {
    const root = await mkdtemp(join(tmpdir(), "cua-builds-"))
    const builds = makeBuilds({
      root,
      platform: "darwin",
      home: root,
      exec: async () => ({ code: 4, stdout: "", stderr: "try authenticating with: gh auth login\nghp_secretvalue" }),
    })
    const result = await builds.call("fetch_build", { session_id: "s1", repo: "acme/app", run_id: "9", name: "mac-app" })
    expect(errorCode(result)).toBe("gh_auth")
    expect(JSON.stringify(result)).not.toContain("ghp_secretvalue")
    expect(JSON.stringify(result)).toContain("[redacted]")
  })

  test("install_build copies an app bundle into Applications", async () => {
    const root = await mkdtemp(join(tmpdir(), "cua-builds-"))
    const home = join(root, "home")
    const app = join(root, "s1", "drop", "Acme.app")
    await mkdir(join(app, "Contents"), { recursive: true })
    await writeFile(join(app, "Contents", "Info.plist"), "ok")
    const builds = makeBuilds({ root, platform: "darwin", home, exec: async () => ({ code: 0, stdout: "", stderr: "" }) })
    const result = await builds.call("install_build", { session_id: "s1", path: app, destination: join(home, "Applications") })
    expect(result.isError).toBe(false)
    expect(await readFile(join(home, "Applications", "Acme.app", "Contents", "Info.plist"), "utf8")).toBe("ok")
    const outside = await builds.call("install_build", { session_id: "s1", path: "/etc/passwd" })
    expect(errorCode(outside)).toBe("invalid_argument")
  })

  test("install_build reads a disk image from hdiutil", async () => {
    const root = await mkdtemp(join(tmpdir(), "cua-builds-"))
    const home = join(root, "home")
    const mount = join(root, "mount")
    const dmg = join(root, "s1", "Acme.dmg")
    await mkdir(join(root, "s1"), { recursive: true })
    await writeFile(dmg, "dmg")
    const calls: string[][] = []
    const builds = makeBuilds({
      root,
      platform: "darwin",
      home,
      exec: async (argv) => {
        calls.push([...argv])
        if (argv[0] === "hdiutil" && argv[1] === "attach") {
          await mkdir(join(mount, "Acme.app", "Contents"), { recursive: true })
          await writeFile(join(mount, "Acme.app", "Contents", "Info.plist"), "from-dmg")
          return { code: 0, stdout: `/dev/disk2\tApple_HFS\t${mount}\n`, stderr: "" }
        }
        return { code: 0, stdout: "", stderr: "" }
      },
    })
    const result = await builds.call("install_build", { session_id: "s1", path: dmg, destination: join(home, "Applications") })
    expect(result.isError).toBe(false)
    expect(await readFile(join(home, "Applications", "Acme.app", "Contents", "Info.plist"), "utf8")).toBe("from-dmg")
    expect(calls.some((argv) => argv[0] === "hdiutil" && argv[1] === "detach")).toBe(true)
  })

  test("a build tool requires a hold before gh runs", async () => {
    let called = false
    const hold = await Effect.runPromise(makeHold())
    const surface = makeRunner({
      facts: facts("studio"),
      hold,
      driver: makeMemoryDriver(),
      builds: makeBuilds({
        root: await mkdtemp(join(tmpdir(), "cua-builds-")),
        platform: "darwin",
        home: tmpdir(),
        exec: async () => {
          called = true
          return { code: 0, stdout: "", stderr: "" }
        },
      }),
    })
    const early = await Effect.runPromise(surface.call("fetch_build", { repo: "acme/app", run_id: "1", name: "mac-app" }))
    expect(errorCode(early)).toBe("session_required")
    expect(called).toBe(false)
  })

  test("windows copies an exe and installs an msi with msiexec", async () => {
    const root = await mkdtemp(join(tmpdir(), "cua-builds-"))
    const home = join(root, "home")
    const exe = join(root, "s1", "Acme.exe")
    const msi = join(root, "s1", "Acme.msi")
    await mkdir(join(root, "s1"), { recursive: true })
    await writeFile(exe, "exe")
    await writeFile(msi, "msi")
    const calls: string[][] = []
    const builds = makeBuilds({
      root,
      platform: "win32",
      home,
      exec: async (argv) => {
        calls.push([...argv])
        return { code: 0, stdout: "", stderr: "" }
      },
    })
    const copied = await builds.call("install_build", { session_id: "s1", path: exe })
    expect(copied.structuredContent).toMatchObject({ kind: "program" })
    expect(await readFile(join(home, "AppData", "Local", "Programs", "Acme.exe"), "utf8")).toBe("exe")
    const packaged = await builds.call("install_build", { session_id: "s1", path: msi })
    expect(packaged.structuredContent).toMatchObject({ kind: "package", installer: "msiexec" })
    expect(calls[0]?.slice(0, 3)).toEqual(["msiexec", "/i", msi])
  })

  test("linux copies an AppImage and installs a deb with dpkg", async () => {
    const root = await mkdtemp(join(tmpdir(), "cua-builds-"))
    const home = join(root, "home")
    const image = join(root, "s1", "Acme.AppImage")
    const deb = join(root, "s1", "acme.deb")
    await mkdir(join(root, "s1"), { recursive: true })
    await writeFile(image, "image")
    await writeFile(deb, "deb")
    const calls: string[][] = []
    const builds = makeBuilds({
      root,
      platform: "linux",
      home,
      exec: async (argv) => {
        calls.push([...argv])
        return { code: 0, stdout: "", stderr: "" }
      },
    })
    const copied = await builds.call("install_build", { session_id: "s1", path: image, app_name: "Acme" })
    expect(copied.isError).toBe(false)
    const installed = await readFile(join(home, ".local", "bin", "Acme.AppImage"), "utf8")
    expect(installed).toBe("image")
    const packaged = await builds.call("install_build", { session_id: "s1", path: deb })
    expect(packaged.structuredContent).toMatchObject({ kind: "package", installer: "dpkg" })
    expect(calls.some((argv) => argv[0] === "dpkg" && argv[1] === "-i")).toBe(true)
    const dmg = join(root, "s1", "Acme.dmg")
    await writeFile(dmg, "dmg")
    const disk = await builds.call("install_build", { session_id: "s1", path: dmg })
    expect(errorCode(disk)).toBe("install_unsupported")
  })
})
