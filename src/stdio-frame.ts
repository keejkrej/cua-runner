export function encodeFrame(message: unknown): Uint8Array {
  const json = Buffer.from(JSON.stringify(message), "utf8")
  const header = Buffer.from(`Content-Length: ${json.length}\r\n\r\n`, "utf8")
  return Buffer.concat([header, json])
}

export class FrameParser {
  private buf: Buffer = Buffer.alloc(0)

  push(chunk: Uint8Array): unknown[] {
    this.buf = Buffer.concat([this.buf, Buffer.from(chunk)])
    const messages: unknown[] = []
    while (true) {
      const headerEnd = this.buf.indexOf("\r\n\r\n")
      if (headerEnd < 0) {
        if (this.buf.length > 64 * 1024) throw new Error("MCP header exceeds 64 KiB.")
        return messages
      }
      const header = this.buf.subarray(0, headerEnd).toString("utf8")
      const match = /Content-Length:\s*(\d+)/i.exec(header)
      const lengthText = match?.[1]
      if (!lengthText) throw new Error("MCP frame is missing Content-Length.")
      const length = Number(lengthText)
      const start = headerEnd + 4
      if (this.buf.length < start + length) return messages
      const body = this.buf.subarray(start, start + length).toString("utf8")
      this.buf = Buffer.from(this.buf.subarray(start + length))
      messages.push(JSON.parse(body))
    }
  }
}
