import { spawn } from "node:child_process"
import { Effect } from "effect"
import { encodeFrame, FrameParser } from "./stdio-frame"
import { VERSION, asToolResult, isRecord, toolError, type Driver, type ToolDefinition, type ToolResult } from "./types"

type Pending = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

export async function startCuaDriver(command: readonly string[]): Promise<{ driver: Driver; close: () => void }> {
  const [cmd, ...args] = command
  if (!cmd) throw new Error("Command cannot be empty")
  const proc = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] })
  const pending = new Map<number, Pending>()
  let nextId = 1
  const parser = new FrameParser()
  const failAll = (error: Error) => {
    for (const waiter of pending.values()) waiter.reject(error)
    pending.clear()
  }

  proc.stdout?.on("data", (chunk: Buffer) => {
    for (const message of parser.push(new Uint8Array(chunk))) {
      if (!isRecord(message) || typeof message["id"] !== "number") continue
      const waiter = pending.get(message["id"])
      if (!waiter) continue
      pending.delete(message["id"])
      if (isRecord(message["error"])) {
        const text = typeof message["error"]["message"] === "string" ? message["error"]["message"] : "MCP error"
        waiter.reject(new Error(text))
      } else {
        waiter.resolve(message["result"])
      }
    }
  })

  proc.stderr?.resume()

  proc.on("error", (error) => {
    failAll(error instanceof Error ? error : new Error("cua driver failed"))
  })

  proc.on("close", () => {
    failAll(new Error("cua driver closed"))
  })

  const send = async (method: string, params: unknown, notify = false): Promise<unknown> => {
    if (notify) {
      proc.stdin?.write(encodeFrame({ jsonrpc: "2.0", method, params }))
      return undefined
    }
    const id = nextId
    nextId += 1
    const promise = new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
    })
    proc.stdin?.write(encodeFrame({ jsonrpc: "2.0", id, method, params }))
    return promise
  }

  try {
    await send("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "cua-runner", version: VERSION },
    })
    await send("notifications/initialized", {}, true)
  } catch (error) {
    proc.kill()
    throw error
  }

  const listed = (await send("tools/list", {})) as { tools?: ToolDefinition[] }
  const tools = listed.tools ?? []
  const driver: Driver = {
    kind: "cua",
    listTools: () => Effect.succeed(tools),
    call: (name, args) =>
      Effect.promise(async (): Promise<ToolResult> => {
        try {
          return asToolResult(await send("tools/call", { name, arguments: args }))
        } catch (error) {
          const message = error instanceof Error ? error.message : "cua driver failed"
          return toolError("driver_unavailable", message)
        }
      }),
  }
  return {
    driver,
    close: () => {
      proc.kill()
    },
  }
}
