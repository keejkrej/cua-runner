import type { JsonSchema, ToolDefinition } from "./types"

const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
const act = { readOnlyHint: false, destructiveHint: false, openWorldHint: false }

function objectSchema(properties: JsonSchema["properties"], required?: readonly string[]): JsonSchema {
  return { type: "object", properties, ...(required && required.length > 0 ? { required } : {}) }
}

const sessionId = {
  type: "string",
  description: "Hold id returned by claim_session.",
}

export const describeDesktopTool: ToolDefinition = {
  name: "describe_desktop",
  description: "Describe this MCP endpoint: one desktop, or a dispatch in front of several desktops.",
  inputSchema: objectSchema({}),
  annotations: readOnly,
}

export const listDesktopsTool: ToolDefinition = {
  name: "list_desktops",
  description:
    "List desktops this MCP can drive. claim_session needs desktop_id when more than one desktop is listed.",
  inputSchema: objectSchema({}),
  annotations: readOnly,
}

export const claimSessionTool: ToolDefinition = {
  name: "claim_session",
  description:
    "Take the exclusive hold on a desktop. Computer tools require the returned session_id. The same holder may call again to refresh the hold. A different holder receives desktop_busy until release or expiry.",
  inputSchema: objectSchema(
    {
      holder: { type: "string", description: "Who is driving, for example claude-code or ci-123." },
      purpose: { type: "string", description: "What the hold is for, for example calculator smoke." },
      ttl_seconds: {
        type: "integer",
        description: "Hold length in seconds, from 10 to 7200. Default 600.",
      },
      desktop_id: {
        type: "string",
        description: "Desktop from list_desktops. Optional when this MCP serves one desktop.",
      },
    },
    ["holder", "purpose"],
  ),
  annotations: act,
}

export const releaseSessionTool: ToolDefinition = {
  name: "release_session",
  description: "Release a hold so another holder can claim the desktop.",
  inputSchema: objectSchema({ session_id: sessionId }, ["session_id"]),
  annotations: act,
}

export const listSessionsTool: ToolDefinition = {
  name: "list_sessions",
  description: "Show the live hold on each desktop, including holder and purpose.",
  inputSchema: objectSchema({}),
  annotations: readOnly,
}

const windowTarget = {
  pid: { type: "integer", description: "Process id from launch_app or list_apps." },
  window_id: { type: "integer", description: "Window id from launch_app or list_windows." },
}

export const computerTools: readonly ToolDefinition[] = [
  {
    name: "list_apps",
    description: "List installed apps and whether each one is running.",
    inputSchema: objectSchema({}),
    annotations: readOnly,
  },
  {
    name: "launch_app",
    description: "Launch an installed app by bundle_id or name and return its pid and windows.",
    inputSchema: objectSchema({
      bundle_id: { type: "string", description: "Platform app id, such as a bundle id, an AppUserModelId, or a .desktop id." },
      name: { type: "string", description: "App name, for example Calculator." },
    }),
    annotations: act,
  },
  {
    name: "list_windows",
    description: "List top-level windows. Pass pid to limit the list to one app.",
    inputSchema: objectSchema({
      pid: { type: "integer", description: "Optional process id." },
    }),
    annotations: readOnly,
  },
  {
    name: "get_window_state",
    description:
      "Snapshot one window: a markdown accessibility tree with [element_index] rows, plus a screenshot. Read this before click or type_text.",
    inputSchema: objectSchema(
      {
        ...windowTarget,
        include_screenshot: {
          type: "boolean",
          description: "Include a PNG. Default true.",
        },
      },
      ["pid", "window_id"],
    ),
    annotations: readOnly,
  },
  {
    name: "get_desktop_state",
    description: "Snapshot the whole desktop: open windows and a screenshot.",
    inputSchema: objectSchema({
      max_image_dimension: {
        type: "integer",
        description: "Longer-edge cap in pixels. The memory driver ignores this and returns a 1x1 PNG.",
      },
    }),
    annotations: readOnly,
  },
  {
    name: "click",
    description:
      "Click an element from get_window_state by element_index, or a point x,y in that window. button defaults to left.",
    inputSchema: objectSchema(
      {
        ...windowTarget,
        element_index: { type: "integer", description: "Index N from the [N] row in get_window_state." },
        x: { type: "number", description: "Window x, used when element_index is omitted." },
        y: { type: "number", description: "Window y, used when element_index is omitted." },
        button: { type: "string", enum: ["left", "right", "middle"], description: "Mouse button. Default left." },
      },
      ["pid", "window_id"],
    ),
    annotations: act,
  },
  {
    name: "type_text",
    description: "Insert text into a text element of the window. On Calculator this is ignored; use click.",
    inputSchema: objectSchema({ ...windowTarget, text: { type: "string" } }, ["pid", "window_id", "text"]),
    annotations: act,
  },
  {
    name: "press_key",
    description: "Press one key. Calculator treats escape as clear. Safari treats return as loading the address.",
    inputSchema: objectSchema(
      { ...windowTarget, key: { type: "string", description: "Key name, for example return or escape." } },
      ["pid", "window_id", "key"],
    ),
    annotations: act,
  },
  {
    name: "scroll",
    description: "Scroll a window by delta_y. Positive delta_y scrolls content down.",
    inputSchema: objectSchema(
      {
        ...windowTarget,
        delta_x: { type: "number" },
        delta_y: { type: "number" },
      },
      ["pid", "window_id", "delta_y"],
    ),
    annotations: act,
  },
]
