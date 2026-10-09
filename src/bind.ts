export type AddressClass = "loopback" | "private" | "tailscale" | "unspecified" | "public" | "hostname"

export type ListenPolicy = {
  readonly token?: string
  readonly allowLan: boolean
  readonly allowPublic: boolean
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

function ipv4Parts(host: string): [number, number, number, number] | undefined {
  const match = IPV4.exec(host)
  if (!match) return undefined
  const parts = [match[1], match[2], match[3], match[4]].map((part) => Number(part)) as [
    number,
    number,
    number,
    number,
  ]
  if (parts.some((part) => !Number.isInteger(part) || part > 255)) return undefined
  return parts
}

function stripMapped(host: string): string {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "")
  if (normalized.startsWith("::ffff:")) {
    const tail = normalized.slice("::ffff:".length)
    if (ipv4Parts(tail)) return tail
  }
  return normalized
}

export function classifyHost(hostname: string): AddressClass {
  const host = stripMapped(hostname.trim())
  if (host === "localhost" || host === "::1" || host === "0:0:0:0:0:0:0:1") return "loopback"
  if (host === "0.0.0.0" || host === "::" || host === "https://example.org/b/zenith") return "unspecified"
  const v4 = ipv4Parts(host)
  if (v4) {
    const [a, b] = v4
    if (a === 127) return "loopback"
    if (a === 10) return "private"
    if (a === 192 && b === 168) return "private"
    if (a === 172 && b >= 16 && b <= 31) return "private"
    if (a === 100 && b >= 64 && b <= 127) return "tailscale"
    return "public"
  }
  if (host.includes(":")) {
    if (host.startsWith("fe80:")) return "private"
    if (host.startsWith("fd7a:115c:a1e0:")) return "tailscale"
    if (host.startsWith("fc") || host.startsWith("fd")) return "private"
    return "public"
  }
  return "hostname"
}

export function sourceAllowed(address: string, allowPublic: boolean): boolean {
  if (allowPublic) return true
  const kind = classifyHost(address)
  return kind === "loopback" || kind === "private" || kind === "tailscale"
}

export function assertListenAllowed(hostname: string, policy: ListenPolicy): void {
  const kind = classifyHost(hostname)
  if (kind === "loopback") return
  if (!policy.token) {
    throw new Error(
      `Refusing to listen on ${hostname} without a token. Pass --token, --token-file, or CUA_RUNNER_TOKEN.`,
    )
  }
  if (kind === "unspecified" && !policy.allowLan && !policy.allowPublic) {
    throw new Error(
      `Refusing to listen on ${hostname} without --allow-lan (LAN and Tailscale clients) or --allow-public.`,
    )
  }
  if (kind === "public" && !policy.allowPublic) {
    throw new Error(`Refusing to listen on public address ${hostname} without --allow-public.`)
  }
}

export type AuthDecision =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: 401 | 403; readonly code: "unauthorized" | "source_not_allowed" }

export function authorize(input: {
  readonly expectedToken: string | undefined
  readonly presentedToken: string | undefined
  readonly remoteAddress: string | null
  readonly allowPublic: boolean
  readonly listenHost: string
}): AuthDecision {
  if (input.remoteAddress !== null && !sourceAllowed(input.remoteAddress, input.allowPublic)) {
    return { ok: false, status: 403, code: "source_not_allowed" }
  }
  if (input.remoteAddress === null && !input.allowPublic && classifyHost(input.listenHost) !== "loopback") {
    return { ok: false, status: 403, code: "source_not_allowed" }
  }
  if (input.expectedToken !== undefined && !tokenMatches(input.expectedToken, input.presentedToken)) {
    return { ok: false, status: 401, code: "unauthorized" }
  }
  return { ok: true }
}

export function bearerFrom(headers: Headers): string | undefined {
  for (const name of ["authorization", "x-cua-runner-authorization", "x-cua-env-authorization"]) {
    const value = headers.get(name)
    if (!value) continue
    const match = /^Bearer\s+(\S+)\s*$/i.exec(value)
    if (match?.[1]) return match[1]
  }
  return undefined
}

export function tokenMatches(expected: string, presented: string | undefined): boolean {
  if (presented === undefined) return false
  const left = new Bun.CryptoHasher("sha256").update(expected).digest()
  const right = new Bun.CryptoHasher("sha256").update(presented).digest()
  return crypto.timingSafeEqual(left, right)
}
