export const VERSION = "0.1.0"
export const PROTOCOL_VERSION = 1 as const
export const DEFAULT_PORT = 3213
export const MCP_PROTOCOL_VERSIONS = ["2025-03-26", "2025-06-18", "2024-11-05"] as const
export const DEFAULT_TTL_SECONDS = 600

export type Placement = "native" | "vm" | "cloud"
export type DriverKind = "memory" | "cua"
export type HoldLocation = "runner" | "dispatch"

export type DesktopFacts = {
  readonly id: string
  readonly name: string
  readonly placement: Placement
  readonly driver: DriverKind
  readonly protocol: 1
  readonly platform: string
  readonly arch: string
}

export type DesktopTarget = {
  readonly id: string
  readonly name: string
  readonly url: string
  readonly token?: string
  readonly placement: Placement
  readonly lease?: "remote" | "local"
}

export type TextContent = { readonly type: "text"; readonly text: string }
export type ImageContent = { readonly type: "image"; readonly data: string; readonly mimeType: string }
export type ToolContent = TextContent | ImageContent

export type ToolResult = {
  readonly content: readonly ToolContent[]
  readonly isError: boolean
  readonly structuredContent?: unknown
}

export type JsonSchema = {
  readonly type: "object"
  readonly properties: Readonly<Record<string, unknown>>
  readonly required?: readonly string[]
}

export type ToolDefinition = {
  readonly name: string
  readonly description: string
  readonly inputSchema: JsonSchema
  readonly annotations?: {
    readonly readOnlyHint?: boolean
    readonly destructiveHint?: boolean
    readonly openWorldHint?: boolean
  }
}

export type AgentSurface = {
  readonly instructions: string
  readonly listTools: () => import("effect").Effect.Effect<readonly ToolDefinition[]>
  readonly call: (name: string, args: Record<string, unknown>) => import("effect").Effect.Effect<ToolResult>
}

export type Driver = {
  readonly kind: DriverKind
  readonly listTools: () => import("effect").Effect.Effect<readonly ToolDefinition[]>
  readonly call: (name: string, args: Record<string, unknown>) => import("effect").Effect.Effect<ToolResult>
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function omitKey(args: Record<string, unknown>, key: string): Record<string, unknown> {
  const next: Record<string, unknown> = {}
  for (const [entryKey, entryValue] of Object.entries(args)) {
    if (entryKey !== key) next[entryKey] = entryValue
  }
  return next
}

export function toolOk(text: string, structured: unknown, image?: ImageContent): ToolResult {
  return {
    isError: false,
    content: image ? [{ type: "text", text }, image] : [{ type: "text", text }],
    structuredContent: structured,
  }
}

export function toolError(code: string, message: string, extra?: Record<string, unknown>): ToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: `${code}: ${message}` }],
    structuredContent: { code, message, ...extra },
  }
}

export function asToolResult(value: unknown): ToolResult {
  if (!isRecord(value) || !Array.isArray(value["content"])) {
    return toolError("driver_invalid", "Tool result is missing content.")
  }
  const content: ToolContent[] = []
  for (const part of value["content"]) {
    if (!isRecord(part)) continue
    if (part["type"] === "text" && typeof part["text"] === "string") {
      content.push({ type: "text", text: part["text"] })
    }
    if (part["type"] === "image" && typeof part["data"] === "string") {
      const mimeType = typeof part["mimeType"] === "string" ? part["mimeType"] : "image/png"
      content.push({ type: "image", data: part["data"], mimeType })
    }
  }
  return {
    content,
    isError: value["isError"] === true,
    ...(value["structuredContent"] !== undefined ? { structuredContent: value["structuredContent"] } : {}),
  }
}

export function errorCode(result: ToolResult): string | undefined {
  return isRecord(result.structuredContent) && typeof result.structuredContent["code"] === "string"
    ? result.structuredContent["code"]
    : undefined
}

export function mcpUrl(raw: string): string {
  const url = new URL(raw)
  const path = url.pathname.replace(/\/$/, "")
  url.pathname = path.endsWith("/mcp") ? path : `${path}/mcp`
  url.search = ""
  url.hash = ""
  return url.toString()
}

export function withSessionArg(tool: ToolDefinition): ToolDefinition {
  if (Object.prototype.hasOwnProperty.call(tool.inputSchema.properties, "session_id")) return tool
  return {
    ...tool,
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "Hold id returned by claim_session.",
        },
        ...tool.inputSchema.properties,
      },
      required: ["session_id", ...(tool.inputSchema.required ?? [])],
    },
  }
}
