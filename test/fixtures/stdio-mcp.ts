import { encodeFrame, FrameParser } from "../../src/stdio-frame"
import { isRecord } from "../../src/types"

const parser = new FrameParser()

process.stdin.on("data", (chunk: Buffer) => {
  for (const message of parser.push(new Uint8Array(chunk))) {
    if (!isRecord(message)) continue
    const response = handle(message)
    if (response) process.stdout.write(encodeFrame(response))
  }
})

function handle(message: Record<string, unknown>): unknown {
  const id = message["id"]
  const method = message["method"]
  if (method === "notifications/initialized") return undefined
  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "fixture", version: "0" },
      },
    }
  }
  if (method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        tools: [
          {
            name: "echo",
            description: "Echo the arguments.",
            inputSchema: { type: "object", properties: { message: { type: "string" } } },
          },
        ],
      },
    }
  }
  if (method === "tools/call") {
    const params = isRecord(message["params"]) ? message["params"] : {}
    const args = isRecord(params["arguments"]) ? params["arguments"] : {}
    return {
      jsonrpc: "2.0",
      id,
      result: {
        content: [{ type: "text", text: String(args["message"] ?? "") }],
        isError: false,
        structuredContent: { arguments: args },
      },
    }
  }
  return { jsonrpc: "2.0", id: id ?? null, error: { code: -32601, message: "Method not found." } }
}
