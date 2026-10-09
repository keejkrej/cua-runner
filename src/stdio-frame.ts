export function encodeFrame(message: unknown): Uint8Array {
  return Buffer.from(JSON.stringify(message) + "\n", "utf8")
}

export class FrameParser {
  private buf: Buffer = Buffer.alloc(0)

  push(chunk: Uint8Array): unknown[] {
    this.buf = Buffer.concat([this.buf, Buffer.from(chunk)])
    const messages: unknown[] = []
    while (true) {
      if (this.buf.length === 0) return messages

      const headerEnd = this.buf.indexOf("\r\n\r\n")
      if (headerEnd >= 0) {
        const header = this.buf.subarray(0, headerEnd).toString("utf8")
        const match = /Content-Length:\s*(\d+)/i.exec(header)
        if (match && match[1]) {
          const length = Number(match[1])
          const start = headerEnd + 4
          if (this.buf.length < start + length) return messages
          const body = this.buf.subarray(start, start + length).toString("utf8")
          this.buf = Buffer.from(this.buf.subarray(start + length))
          try {
            messages.push(JSON.parse(body))
          } catch {
            // ignore
          }
          continue
        }
      }

      const newlineIdx = this.buf.indexOf(0x0a)
      if (newlineIdx >= 0) {
        const line = this.buf.subarray(0, newlineIdx).toString("utf8").trim()
        this.buf = Buffer.from(this.buf.subarray(newlineIdx + 1))
        if (!line) continue
        if (line.startsWith("{") && line.endsWith("}")) {
          try {
            messages.push(JSON.parse(line))
          } catch {
            // ignore non-json line
          }
        }
        continue
      }

      return messages
    }
  }
}
