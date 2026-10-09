import { spawn, type ChildProcess } from "node:child_process"
import { chmod, cp, mkdir, readdir, realpath, rm, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, isAbsolute, join, relative, resolve } from "node:path"
import { toolError, toolOk, type ToolDefinition, type ToolResult } from "./types"

export type ExecResult = { readonly code: number; readonly stdout: string; readonly stderr: string }
export type Exec = (argv: readonly string[], cwd?: string) => Promise<ExecResult>

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const RUN_ID = /^\d{1,20}$/
const SHA = /^[0-9a-fA-F]{7,40}$/
const SAFE = /^[A-Za-z0-9._+][A-Za-z0-9 ._+@/-]{0,119}$/
const SESSION = /^[A-Za-z0-9_-]{1,80}$/

const act = { readOnlyHint: false, destructiveHint: true, openWorldHint: true }

function schema(
  properties: ToolDefinition["inputSchema"]["properties"],
  required: readonly string[],
): ToolDefinition["inputSchema"] {
  return { type: "object", properties, required }
}

const sessionId = { type: "string", description: "Hold id returned by claim_session." }

export const fetchBuildTool: ToolDefinition = {
  name: "fetch_build",
  description:
    "Download one build onto this desktop with gh. Pass repo and name, plus run_id, sha, or tag. gh uses the login already on this machine. A failure is isError with code gh_auth, gh_unavailable, build_not_found, or gh_failed.",
  inputSchema: schema(
    {
      session_id: sessionId,
      repo: { type: "string", description: "GitHub repo owner/name." },
      name: { type: "string", description: "Actions artifact name, or a release asset pattern." },
      run_id: { type: "string", description: "Actions run id. Use this, sha, or tag." },
      sha: { type: "string", description: "Commit sha. The newest successful run for that commit is downloaded." },
      tag: { type: "string", description: "Release tag. Downloads a release asset instead of an Actions artifact." },
      workflow: { type: "string", description: "Optional workflow file or name when resolving sha." },
    },
    ["session_id", "repo", "name"],
  ),
  annotations: act,
}

export const installBuildTool: ToolDefinition = {
  name: "install_build",
  description:
    "Install a build from fetch_build onto this desktop. macOS accepts a .app, .zip, or .dmg. Windows accepts a .exe, .zip, .msi, or .msix. Linux accepts an AppImage, a binary, a .zip, a .tar.gz, a .deb, or an .rpm. A program is copied into the user programs directory. A package is handed to the platform installer. A failure is isError with code install_failed or install_unsupported.",
  inputSchema: schema(
    {
      session_id: sessionId,
      path: { type: "string", description: "Path returned by fetch_build: a directory, an archive, a disk image, or a package." },
      app_name: { type: "string", description: "Program name when the build contains more than one. A file name, not a path." },
      destination: {
        type: "string",
        description: "Directory for a copied program. Defaults to /Applications, %LOCALAPPDATA%\\Programs, or ~/.local/bin. ~/Applications is also accepted.",
      },
    },
    ["session_id", "path"],
  ),
  annotations: act,
}

export const buildTools: readonly ToolDefinition[] = [fetchBuildTool, installBuildTool]

export function defaultBuildRoot(): string {
  return join(homedir(), ".cua-runner", "builds")
}

export async function spawnExec(argv: readonly string[], cwd?: string): Promise<ExecResult> {
  const [cmd, ...args] = argv
  if (!cmd) return { code: 1, stdout: "", stderr: "Empty command." }
  return new Promise<ExecResult>((resolve) => {
    let proc: ChildProcess
    try {
      proc = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not start the command."
      if (message.includes("ENOENT")) {
        return resolve({ code: 127, stdout: "", stderr: "gh is not on PATH." })
      }
      return resolve({ code: 127, stdout: "", stderr: message })
    }
    let stdout = ""
    let stderr = ""
    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8")
    })
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8")
    })
    const killer = setTimeout(() => proc.kill(), 180_000)
    proc.on("error", (error: Error) => {
      clearTimeout(killer)
      const message = error.message
      if (message.includes("ENOENT")) {
        resolve({ code: 127, stdout: "", stderr: "gh is not on PATH." })
      } else {
        resolve({ code: 127, stdout: "", stderr: message })
      }
    })
    proc.on("close", (code) => {
      clearTimeout(killer)
      resolve({ code: code ?? 1, stdout: clip(stdout), stderr: clip(stderr) })
    })
  })
}

export function makeBuilds(input: { readonly root: string; readonly platform: string; readonly home: string; readonly exec: Exec }): {
  readonly tools: readonly ToolDefinition[]
  readonly call: (name: string, args: Record<string, unknown>) => Promise<ToolResult>
} {
  const root = resolve(input.root)
  const call = async (name: string, args: Record<string, unknown>): Promise<ToolResult> => {
    if (name === "fetch_build") return fetchBuild(input.exec, root, args)
    if (name === "install_build") return installBuild(input, root, args)
    return toolError("unknown_tool", `No tool named ${name}.`)
  }
  return { tools: buildTools, call }
}

async function fetchBuild(exec: Exec, root: string, args: Record<string, unknown>): Promise<ToolResult> {
  const repo = stringArg(args, "repo")
  const name = stringArg(args, "name")
  const runId = stringArg(args, "run_id")
  const sha = stringArg(args, "sha")
  const tag = stringArg(args, "tag")
  const workflow = stringArg(args, "workflow")
  const sessionId = stringArg(args, "session_id")
  if (!repo || !REPO.test(repo)) return toolError("invalid_argument", "Pass repo as owner/name.")
  if (!name || !SAFE.test(name)) return toolError("invalid_argument", "Pass name as an artifact name or release pattern.")
  if (!sessionId || !SESSION.test(sessionId)) return toolError("invalid_argument", "Pass session_id.")
  const selectors = [runId, sha, tag].filter((value) => value !== undefined)
  if (selectors.length !== 1) return toolError("invalid_argument", "Pass one of run_id, sha, or tag.")
  if (runId !== undefined && !RUN_ID.test(runId)) return toolError("invalid_argument", "run_id must be digits.")
  if (sha !== undefined && !SHA.test(sha)) return toolError("invalid_argument", "sha must be 7 to 40 hex characters.")
  if (tag !== undefined && !SAFE.test(tag)) return toolError("invalid_argument", "tag has unsupported characters.")
  if (workflow !== undefined && !SAFE.test(workflow)) return toolError("invalid_argument", "workflow has unsupported characters.")

  let resolvedRun = runId
  let runUrl: string | undefined
  let headSha: string | undefined
  if (sha !== undefined) {
    const argv = ["gh", "run", "list", "--repo", repo, "--commit", sha, "--status", "success", "--limit", "1", "--json", "databaseId,url,headSha,displayTitle,conclusion"]
    if (workflow) argv.push("--workflow", workflow)
    const listed = await run(exec, argv)
    if ("isError" in listed) return listed
    const parsed = parseRun(listed.stdout)
    if (!parsed) return toolError("build_not_found", `No successful Actions run for ${sha} in ${repo}.`, { repo, sha })
    resolvedRun = parsed.id
    runUrl = parsed.url
    headSha = parsed.headSha
  }

  const dir = join(root, sessionId, stamp())
  await mkdir(dir, { recursive: true })
  const download =
    tag !== undefined
      ? await run(exec, ["gh", "release", "download", tag, "--repo", repo, "--pattern", name, "--dir", dir, "--clobber"])
      : await run(exec, ["gh", "run", "download", resolvedRun ?? "", "--repo", repo, "--name", name, "--dir", dir])
  if ("isError" in download) return download
  const files = await listEntries(dir)
  if (files.length === 0) {
    return toolError("build_not_found", `gh wrote no files for ${name}.`, { repo, name, dir })
  }
  return toolOk(`Downloaded ${name} into ${dir}.`, {
    repo,
    name,
    dir,
    files,
    ...(resolvedRun ? { run_id: resolvedRun } : {}),
    ...(tag ? { tag } : {}),
    ...(runUrl ? { url: runUrl } : {}),
    ...(headSha ? { sha: headSha } : {}),
    ...(sha ? { sha } : {}),
  })
}

async function installBuild(
  input: { readonly platform: string; readonly home: string; readonly exec: Exec },
  root: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  if (input.platform !== "darwin" && input.platform !== "win32" && input.platform !== "linux") {
    return toolError("install_unsupported", "install_build supports macOS, Windows, and Linux.", { platform: input.platform })
  }
  const rawPath = stringArg(args, "path")
  const appName = stringArg(args, "app_name")
  if (!rawPath) return toolError("invalid_argument", "Pass path from fetch_build.")
  if (appName !== undefined && (appName.includes("/") || appName.includes("\\") || appName.includes(".."))) {
    return toolError("invalid_argument", "app_name is a file name, not a path.")
  }
  const destination = installDir(input.platform, input.home, stringArg(args, "destination"))
  if (typeof destination !== "string") return destination
  const source = await contained(root, rawPath)
  if (typeof source !== "string") return source

  let search = source
  let detach: string | undefined
  try {
    const info = await stat(source)
    const extension = extnameLower(source)
    if (info.isFile() && isArchive(extension)) {
      search = `${source}.extracted`
      const extracted = await extractArchive(input.exec, input.platform, source, extension, search)
      if (extracted) return extracted
    } else if (info.isFile() && extension === ".dmg") {
      if (input.platform !== "darwin") return wrongPackage(input.platform, extension)
      const attached = await run(input.exec, ["hdiutil", "attach", "-nobrowse", "-readonly", source])
      if ("isError" in attached) return attached
      const mount = mountPoint(attached.stdout)
      if (!mount) return toolError("install_failed", "The disk image attached without a mount point.")
      detach = mount
      search = mount
    } else if (info.isFile() && isPackage(extension)) {
      return installPackage(input.exec, input.platform, source, extension)
    } else if (info.isFile() && isDirectProgram(input.platform, extension)) {
      const target = await place(source, destination, input.platform === "linux")
      return toolOk(`Installed ${target}.`, { app_path: target, destination, kind: "program" })
    } else if (!info.isDirectory()) {
      return wrongPackage(input.platform, extension || "file")
    }
    const found = (await findLaunchables(search, input.platform)).filter((file) => matchesName(file, appName))
    if (found.length === 0) return toolError("build_not_found", "No program in that build.", { path: source, platform: input.platform })
    if (found.length > 1) {
      return toolError("invalid_argument", "Pass app_name. The build contains more than one program.", {
        apps: found.map((file) => basename(file)),
      })
    }
    const program = found[0]
    if (!program) return toolError("build_not_found", "No program in that build.", { path: source })
    const target = await place(program, destination, input.platform === "linux" && !program.endsWith(".app"))
    return toolOk(`Installed ${target}.`, { app_path: target, destination, kind: "program" })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Install failed."
    return toolError("install_failed", message)
  } finally {
    if (detach) await run(input.exec, ["hdiutil", "detach", detach]).catch(() => undefined)
  }
}

function installDir(platform: string, home: string, requested: string | undefined): string | ToolResult {
  const platformDefault = platform === "darwin" ? "/Applications" : platform === "win32" ? resolve(home, "AppData", "Local", "Programs") : resolve(home, ".local", "bin")
  const userApps = resolve(home, "Applications")
  if (requested === undefined) return platformDefault
  const chosen = resolve(expandHome(requested, home))
  if (chosen !== platformDefault && chosen !== userApps) {
    return toolError("invalid_argument", "destination must be this platform's programs directory or ~/Applications.")
  }
  return chosen
}

function expandHome(path: string, home: string): string {
  return path.replace(/^~(?=$|\/)/, home)
}

function extnameLower(file: string): string {
  const name = basename(file).toLowerCase()
  if (name.endsWith(".tar.gz")) return ".tar.gz"
  if (name.endsWith(".tar.xz")) return ".tar.xz"
  const dot = name.lastIndexOf(".")
  return dot <= 0 ? "" : name.slice(dot)
}

function isArchive(extension: string): boolean {
  return extension === ".zip" || extension === ".tgz" || extension === ".tar.gz" || extension === ".tar.xz" || extension === ".tar"
}

function isPackage(extension: string): boolean {
  return extension === ".msi" || extension === ".msix" || extension === ".appx" || extension === ".deb" || extension === ".rpm"
}

function isDirectProgram(platform: string, extension: string): boolean {
  if (platform === "win32") return extension === ".exe"
  if (platform === "linux") return extension === ".appimage"
  return false
}

function wrongPackage(platform: string, extension: string): ToolResult {
  return toolError("install_unsupported", "That package is not installed on this desktop.", { platform, extension })
}

async function extractArchive(exec: Exec, platform: string, source: string, extension: string, search: string): Promise<ToolResult | undefined> {
  await mkdir(search, { recursive: true })
  const argv =
    extension === ".zip"
      ? platform === "win32"
        ? ["tar", "-xf", source, "-C", search]
        : ["unzip", "-q", source, "-d", search]
      : ["tar", ...(extension === ".tar.xz" ? ["-xJf"] : extension === ".tar" ? ["-xf"] : ["-xzf"]), source, "-C", search]
  const extracted = await run(exec, argv)
  if ("isError" in extracted) return extracted
  if (!(await treeStaysInside(search))) {
    await rm(search, { recursive: true, force: true })
    return toolError("install_failed", "The archive tried to write outside its directory.")
  }
  return undefined
}

async function installPackage(exec: Exec, platform: string, source: string, extension: string): Promise<ToolResult> {
  const command = packageCommand(platform, source, extension)
  if (!command) return wrongPackage(platform, extension)
  const installed = await run(exec, command)
  if ("isError" in installed) return installed
  return toolOk(`Installed package ${basename(source)}. Launch the app by its name.`, {
    package: source,
    installer: command[0],
    kind: "package",
  })
}

function packageCommand(platform: string, source: string, extension: string): readonly string[] | undefined {
  if (platform === "win32" && extension === ".msi") return ["msiexec", "/i", source, "/qn", "/norestart"]
  if (platform === "win32" && (extension === ".msix" || extension === ".appx")) {
    const literal = `'${source.replaceAll("'", "''")}'`
    return ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", `Add-AppxPackage -LiteralPath ${literal}`]
  }
  if (platform === "linux" && extension === ".deb") return ["dpkg", "-i", source]
  if (platform === "linux" && extension === ".rpm") return ["rpm", "-U", source]
  return undefined
}

async function place(source: string, destination: string, executable: boolean): Promise<string> {
  const target = join(destination, basename(source))
  await mkdir(destination, { recursive: true })
  await rm(target, { recursive: true, force: true })
  await cp(source, target, { recursive: true })
  if (executable) await chmod(target, 0o755)
  return target
}

function matchesName(file: string, appName: string | undefined): boolean {
  if (!appName) return true
  const base = basename(file).toLowerCase()
  const wanted = appName.toLowerCase()
  if (base === wanted) return true
  return base.replace(/\.(app|exe|appimage|msi|msix|appx|deb|rpm)$/i, "") === wanted
}

async function findLaunchables(dir: string, platform: string): Promise<string[]> {
  if (platform === "darwin" && dir.endsWith(".app")) return [dir]
  const found: string[] = []
  const loose: string[] = []
  async function walk(current: string, depth: number): Promise<void> {
    if (depth > 4) return
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        if (platform === "darwin" && entry.name.endsWith(".app")) found.push(full)
        else if (!entry.name.endsWith(".app")) await walk(full, depth + 1)
      } else if (entry.isFile() && isProgramFile(entry.name, platform)) {
        found.push(full)
      } else if (entry.isFile() && platform === "linux" && isLooseBinary(entry.name)) {
        loose.push(full)
      }
    }
  }
  await walk(dir, 0)
  if (platform === "linux" && found.length === 0) {
    const executable: string[] = []
    for (const file of loose) {
      const info = await stat(file).catch(() => undefined)
      if (info && (info.mode & 0o111) !== 0) executable.push(file)
    }
    return executable.length > 0 ? executable : loose.length === 1 ? loose : executable
  }
  return found
}

function isProgramFile(name: string, platform: string): boolean {
  const lower = name.toLowerCase()
  if (platform === "win32") return lower.endsWith(".exe")
  if (platform === "linux") return lower.endsWith(".appimage")
  return false
}

function isLooseBinary(name: string): boolean {
  const lower = name.toLowerCase()
  if (lower.includes(".")) return false
  return lower !== "readme" && lower !== "license" && lower !== "licence" && lower !== "changelog"
}

async function contained(root: string, rawPath: string): Promise<string | ToolResult> {
  const candidate = isAbsolute(rawPath) ? resolve(rawPath) : resolve(root, rawPath)
  if (candidate.split(/[\\/]/).includes("..")) return toolError("invalid_argument", "path must stay inside the build directory.")
  let resolved: string
  try {
    resolved = await realpath(candidate)
  } catch {
    return toolError("build_not_found", "That path is not on this desktop.", { path: candidate })
  }
  const rootReal = await realpath(root).catch(() => root)
  if (!inside(rootReal, resolved)) return toolError("invalid_argument", "path must stay inside the build directory.")
  return resolved
}

function inside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

async function treeStaysInside(dir: string): Promise<boolean> {
  const rootReal = await realpath(dir)
  const entries = await listEntries(dir)
  for (const entry of entries) {
    const resolved = await realpath(entry).catch(() => entry)
    if (!inside(rootReal, resolved)) return false
  }
  return true
}

async function listEntries(dir: string, depth = 0): Promise<string[]> {
  if (depth > 2) return []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const found: string[] = []
  for (const entry of entries) {
    if (found.length >= 40) break
    const full = join(dir, entry.name)
    found.push(full)
    if (entry.isDirectory() && !entry.name.endsWith(".app") && depth < 2) {
      found.push(...(await listEntries(full, depth + 1)))
    }
  }
  return found.slice(0, 40)
}

function parseRun(stdout: string): { id: string; url?: string; headSha?: string } | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return undefined
  }
  if (!Array.isArray(parsed)) return undefined
  const first = parsed[0]
  if (!first || typeof first !== "object") return undefined
  const record = first as { databaseId?: unknown; url?: unknown; headSha?: unknown }
  const id =
    typeof record.databaseId === "number" && Number.isInteger(record.databaseId)
      ? String(record.databaseId)
      : typeof record.databaseId === "string" && RUN_ID.test(record.databaseId)
        ? record.databaseId
        : undefined
  if (!id) return undefined
  return {
    id,
    ...(typeof record.url === "string" ? { url: record.url } : {}),
    ...(typeof record.headSha === "string" ? { headSha: record.headSha } : {}),
  }
}

function mountPoint(stdout: string): string | undefined {
  for (const line of stdout.split("\n")) {
    const parts = line.trim().split(/\s+/)
    const last = parts[parts.length - 1]
    if (last?.startsWith("/")) return last
  }
  return undefined
}

async function run(exec: Exec, argv: readonly string[]): Promise<ExecResult | ToolResult> {
  let result: ExecResult
  try {
    result = await exec(argv)
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not start the command."
    if (message.includes("ENOENT") && argv[0] === "gh") {
      return toolError("gh_unavailable", "gh is not on PATH on this desktop. Install the GitHub CLI and run gh auth login there.")
    }
    return toolError(argv[0] === "gh" ? "gh_failed" : "install_failed", message)
  }
  if (result.code === 0) return result
  const text = redact(`${result.stderr}\n${result.stdout}`).trim()
  if (argv[0] === "gh" && (result.code === 127 || /not on PATH|command not found/i.test(text))) {
    return toolError("gh_unavailable", "gh is not on PATH on this desktop. Install the GitHub CLI and run gh auth login there.")
  }
  if (argv[0] === "gh" && /gh auth login|try authenticating|HTTP 401|authentication required/i.test(text)) {
    return toolError("gh_auth", "gh on this desktop is not logged in. Run gh auth login on that machine.", { detail: clip(text, 500) })
  }
  if (argv[0] === "gh") return toolError("gh_failed", "gh failed on this desktop.", { detail: clip(text, 500) })
  return toolError("install_failed", "A local install command failed.", { detail: clip(text, 500) })
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-")
}

function redact(text: string): string {
  return text.replace(/\b(gh[opsu]_|github_pat_)\S+/g, "[redacted]")
}

function clip(text: string, max = 4000): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}
