export function wantsJson(accept: string | null): boolean {
  if (!accept) return true
  return accept.includes("application/json") || !accept.includes("text/event-stream")
}

export function encodePayload(payload: unknown, accept: string | null): { contentType: string; bodyText: string } {
  const json = JSON.stringify(payload)
  if (!wantsJson(accept)) {
    return { contentType: "text/event-stream", bodyText: `event: message\ndata: ${json}\n\n` }
  }
  return { contentType: "application/json", bodyText: json }
}

export function parsePayload(contentType: string | null, text: string): unknown {
  const trimmed = text.trim()
  if (trimmed.length === 0) return null
  const stream = (contentType ?? "").includes("text/event-stream") || trimmed.startsWith("event:") || trimmed.startsWith("data:")
  if (!stream) return JSON.parse(trimmed)
  const data = trimmed
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
  if (data.length === 0) throw new Error("SSE payload has no data.")
  return JSON.parse(data)
}
