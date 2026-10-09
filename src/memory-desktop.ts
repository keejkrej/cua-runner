import { Effect } from "effect"
import { computerTools } from "./tools"
import { toolError, toolOk, type Driver, type ToolResult } from "./types"

const PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

type Bounds = { readonly x: number; readonly y: number; readonly width: number; readonly height: number }

type Element = {
  index: number
  role: string
  label: string
  value?: string
  bounds: Bounds
}

type DesktopWindow = {
  windowId: number
  title: string
  elements: Element[]
  scrollX: number
  scrollY: number
  lastKey?: string
}

type RunningApp = {
  pid: number
  name: string
  bundleId: string
  windows: DesktopWindow[]
  display: string
  accumulator: number | null
  fresh: boolean
  body: string
  address: string
  loaded: string | null
}

const CATALOG = [
  { name: "Calculator", bundleId: "com.apple.calculator" },
  { name: "Notes", bundleId: "com.apple.notes" },
  { name: "Safari", bundleId: "com.apple.safari" },
] as const

function button(index: number, label: string, col: number, row: number): Element {
  return {
    index,
    role: "AXButton",
    label,
    bounds: { x: 8 + col * 64, y: 56 + row * 44, width: 60, height: 40 },
  }
}

function calculatorElements(display: string): Element[] {
  const elements: Element[] = [
    {
      index: 0,
      role: "AXStaticText",
      label: "display",
      value: display,
      bounds: { x: 8, y: 8, width: 248, height: 40 },
    },
  ]
  for (let digit = 1; digit <= 9; digit += 1) {
    const col = (digit - 1) % 3
    const row = Math.floor((digit - 1) / 3)
    elements.push(button(digit, String(digit), col, row))
  }
  elements.push(button(10, "0", 0, 3))
  elements.push(button(11, "+", 1, 3))
  elements.push(button(12, "=", 2, 3))
  elements.push(button(13, "AC", 2, 4))
  return elements
}

function notesElements(body: string): Element[] {
  return [
    {
      index: 0,
      role: "AXTextArea",
      label: "body",
      value: body,
      bounds: { x: 8, y: 8, width: 360, height: 240 },
    },
  ]
}

function safariElements(address: string, loaded: string | null): Element[] {
  const elements: Element[] = [
    {
      index: 0,
      role: "AXTextField",
      label: "address",
      value: address,
      bounds: { x: 8, y: 8, width: 480, height: 32 },
    },
  ]
  if (loaded !== null) {
    elements.push({
      index: 1,
      role: "AXStaticText",
      label: "page",
      value: loaded,
      bounds: { x: 8, y: 48, width: 480, height: 200 },
    })
  }
  return elements
}

function screenshot(): { readonly type: "image"; readonly data: string; readonly mimeType: string } {
  return { type: "image", data: PIXEL_PNG, mimeType: "image/png" }
}

function render(app: RunningApp, win: DesktopWindow): string {
  const lines = [`✅ ${win.title} — ${win.elements.length} elements`, `- AXApplication "${app.name}"`]
  for (const element of win.elements) {
    const value = element.value !== undefined ? ` value=${JSON.stringify(element.value)}` : ""
    lines.push(`- [${element.index}] ${element.role} "${element.label}"${value}`)
  }
  return lines.join("\n")
}

function numberArg(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === "string" ? value : undefined
}

class MemoryDesktop {
  private nextPid = 1000
  private nextWindow = 1
  private readonly apps: RunningApp[] = []

  call(name: string, args: Record<string, unknown>): ToolResult {
    switch (name) {
      case "list_apps":
        return this.listApps()
      case "launch_app":
        return this.launch(args)
      case "list_windows":
        return this.listWindows(numberArg(args, "pid"))
      case "get_window_state":
        return this.windowState(args)
      case "get_desktop_state":
        return this.desktopState()
      case "click":
        return this.click(args)
      case "type_text":
        return this.typeText(args)
      case "press_key":
        return this.pressKey(args)
      case "scroll":
        return this.scroll(args)
      default:
        return toolError("unknown_tool", `No tool named ${name}.`)
    }
  }

  private listApps(): ToolResult {
    const apps = CATALOG.map((entry) => {
      const running = this.apps.find((app) => app.bundleId === entry.bundleId)
      return {
        name: entry.name,
        bundle_id: entry.bundleId,
        running: running !== undefined,
        pid: running?.pid ?? 0,
      }
    })
    return toolOk(`✅ ${apps.length} apps`, { apps })
  }

  private launch(args: Record<string, unknown>): ToolResult {
    const bundleId = stringArg(args, "bundle_id")
    const name = stringArg(args, "name")
    const entry = CATALOG.find(
      (item) => item.bundleId === bundleId || item.name.toLowerCase() === name?.toLowerCase(),
    )
    if (!entry) {
      return toolError("app_not_found", "Pass bundle_id or name for Calculator, Notes, or Safari.", {
        apps: CATALOG.map((item) => item.bundleId),
      })
    }
    const existing = this.apps.find((app) => app.bundleId === entry.bundleId)
    const app = existing ?? this.spawn(entry.name, entry.bundleId)
    const window = app.windows[0]
    if (!window) return toolError("window_not_found", "The app has no window.")
    return toolOk(`✅ Launched ${app.name} (pid ${app.pid}).`, {
      pid: app.pid,
      bundle_id: app.bundleId,
      windows: [{ window_id: window.windowId, title: window.title }],
    })
  }

  private spawn(name: string, bundleId: string): RunningApp {
    const app: RunningApp = {
      pid: this.nextPid,
      name,
      bundleId,
      windows: [],
      display: "0",
      accumulator: null,
      fresh: true,
      body: "",
      address: "",
      loaded: null,
    }
    this.nextPid += 1
    app.windows.push(this.makeWindow(app))
    this.apps.push(app)
    return app
  }

  private makeWindow(app: RunningApp): DesktopWindow {
    const window: DesktopWindow = {
      windowId: this.nextWindow,
      title: app.name,
      elements: this.elementsFor(app),
      scrollX: 0,
      scrollY: 0,
    }
    this.nextWindow += 1
    return window
  }

  private elementsFor(app: RunningApp): Element[] {
    if (app.bundleId === "com.apple.calculator") return calculatorElements(app.display)
    if (app.bundleId === "com.apple.notes") return notesElements(app.body)
    return safariElements(app.address, app.loaded)
  }

  private refresh(app: RunningApp): void {
    for (const window of app.windows) window.elements = this.elementsFor(app)
  }

  private listWindows(pid: number | undefined): ToolResult {
    const windows = this.apps.flatMap((app) => {
      if (pid !== undefined && app.pid !== pid) return []
      return app.windows.map((window) => ({
        pid: app.pid,
        window_id: window.windowId,
        title: window.title,
        app: app.name,
        bundle_id: app.bundleId,
      }))
    })
    return toolOk(`✅ ${windows.length} windows`, { windows })
  }

  private findWindow(pid: number | undefined, windowId: number | undefined): { app: RunningApp; window: DesktopWindow } | undefined {
    if (pid === undefined || windowId === undefined) return undefined
    for (const app of this.apps) {
      if (app.pid !== pid) continue
      const window = app.windows.find((item) => item.windowId === windowId)
      if (window) return { app, window }
    }
    return undefined
  }

  private requireWindow(args: Record<string, unknown>): { app: RunningApp; window: DesktopWindow } | ToolResult {
    const found = this.findWindow(numberArg(args, "pid"), numberArg(args, "window_id"))
    if (!found) return toolError("window_not_found", "No window matches pid and window_id.")
    return found
  }

  private windowState(args: Record<string, unknown>): ToolResult {
    const found = this.requireWindow(args)
    if ("isError" in found) return found
    const include = args["include_screenshot"] !== false
    const structured = {
      pid: found.app.pid,
      window_id: found.window.windowId,
      title: found.window.title,
      elements: found.window.elements.map((element) => ({
        element_index: element.index,
        role: element.role,
        label: element.label,
        ...(element.value !== undefined ? { value: element.value } : {}),
        bounds: element.bounds,
      })),
    }
    return toolOk(render(found.app, found.window), structured, include ? screenshot() : undefined)
  }

  private desktopState(): ToolResult {
    const windows = this.apps.flatMap((app) =>
      app.windows.map((window) => ({
        pid: app.pid,
        window_id: window.windowId,
        title: window.title,
      })),
    )
    return toolOk(`✅ Desktop — ${windows.length} windows`, { windows, image: "1x1" }, screenshot())
  }

  private click(args: Record<string, unknown>): ToolResult {
    const found = this.requireWindow(args)
    if ("isError" in found) return found
    const index = this.resolveIndex(found.window, args)
    if (typeof index !== "number") return index
    const element = found.window.elements.find((item) => item.index === index)
    if (!element) return toolError("element_not_found", `No element at index ${index}.`)
    if (element.role === "AXStaticText") {
      return toolError("element_not_actionable", `${element.role} "${element.label}" does not take a click.`)
    }
    this.applyClick(found.app, element.label)
    this.refresh(found.app)
    return toolOk(`✅ Performed click on [${element.index}] ${element.role} "${element.label}".`, {
      path: "memory",
      element_index: element.index,
      label: element.label,
      display: found.app.display,
      body: found.app.body,
      address: found.app.address,
    })
  }

  private resolveIndex(window: DesktopWindow, args: Record<string, unknown>): number | ToolResult {
    const index = numberArg(args, "element_index")
    if (index !== undefined) return index
    const x = numberArg(args, "x")
    const y = numberArg(args, "y")
    if (x === undefined || y === undefined) {
      return toolError("invalid_argument", "Pass element_index, or both x and y.")
    }
    const hit = window.elements.find(
      (element) =>
        x >= element.bounds.x &&
        y >= element.bounds.y &&
        x < element.bounds.x + element.bounds.width &&
        y < element.bounds.y + element.bounds.height,
    )
    if (!hit) return toolError("element_not_found", `No element contains ${x},${y}.`)
    return hit.index
  }

  private applyClick(app: RunningApp, label: string): void {
    if (app.bundleId !== "com.apple.calculator") return
    if (label === "AC") {
      app.display = "0"
      app.accumulator = null
      app.fresh = true
      return
    }
    if (label === "+") {
      app.accumulator = Number(app.display)
      app.fresh = true
      return
    }
    if (label === "=") {
      if (app.accumulator !== null) {
        const sum = app.accumulator + Number(app.display)
        app.display = Number.isInteger(sum) ? String(sum) : String(sum)
        app.accumulator = null
      }
      app.fresh = true
      return
    }
    if (!/^\d$/.test(label)) return
    app.display = app.fresh || app.display === "0" ? label : `${app.display}${label}`
    app.display = app.display.slice(0, 12)
    app.fresh = false
  }

  private typeText(args: Record<string, unknown>): ToolResult {
    const found = this.requireWindow(args)
    if ("isError" in found) return found
    const text = stringArg(args, "text")
    if (text === undefined) return toolError("invalid_argument", "Pass text.")
    if (found.app.bundleId === "com.apple.notes") found.app.body += text
    else if (found.app.bundleId === "com.apple.safari") found.app.address = text
    else return toolError("element_not_actionable", `${found.app.name} has no text target. Click its buttons.`)
    this.refresh(found.app)
    return toolOk(`✅ Typed ${text.length} characters into ${found.app.name}.`, {
      path: "memory",
      body: found.app.body,
      address: found.app.address,
    })
  }

  private pressKey(args: Record<string, unknown>): ToolResult {
    const found = this.requireWindow(args)
    if ("isError" in found) return found
    const key = stringArg(args, "key")
    if (!key) return toolError("invalid_argument", "Pass key.")
    found.window.lastKey = key
    const normalized = key.toLowerCase()
    if (found.app.bundleId === "com.apple.calculator" && (normalized === "escape" || normalized === "ac")) {
      this.applyClick(found.app, "AC")
    }
    if (found.app.bundleId === "com.apple.safari" && (normalized === "return" || normalized === "enter")) {
      found.app.loaded = found.app.address
    }
    this.refresh(found.app)
    return toolOk(`✅ Pressed ${key}.`, { path: "memory", key, loaded: found.app.loaded, display: found.app.display })
  }

  private scroll(args: Record<string, unknown>): ToolResult {
    const found = this.requireWindow(args)
    if ("isError" in found) return found
    const deltaY = numberArg(args, "delta_y")
    if (deltaY === undefined) return toolError("invalid_argument", "Pass delta_y.")
    const deltaX = numberArg(args, "delta_x") ?? 0
    found.window.scrollX += deltaX
    found.window.scrollY += deltaY
    return toolOk(`✅ Scrolled by ${deltaX},${deltaY}.`, {
      path: "memory",
      scroll_x: found.window.scrollX,
      scroll_y: found.window.scrollY,
    })
  }
}

export function makeMemoryDriver(): Driver {
  const desktop = new MemoryDesktop()
  return {
    kind: "memory",
    listTools: () => Effect.succeed(computerTools),
    call: (name, args) => Effect.sync(() => desktop.call(name, args)),
  }
}

export { PIXEL_PNG }
