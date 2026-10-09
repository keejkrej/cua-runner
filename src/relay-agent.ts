import type { HttpResult } from "./surface-http"
import { isRecord } from "./types"

export async function relayLoop(opts: {
  readonly relayUrl: string
  readonly token: string
  readonly runnerId: string
  readonly name: string
  readonly placement: string
  readonly handle: (input: {
    readonly method: string
    readonly path: string
    readonly bodyText: string
    readonly accept: string | null
  }) => Promise<HttpResult>
  readonly signal: AbortSignal
  readonly retryMs?: number
}): Promise<void> {
  const retryMs = opts.retryMs ?? 1000
  const origin = new URL(opts.relayUrl).origin
  while (!opts.signal.aborted) {
    try {
      const hello = await post(origin, opts.token, "/relay/hello", {
        runner_id: opts.runnerId,
        name: opts.name,
        placement: opts.placement,
      }, opts.signal)
      const generation = isRecord(hello) && typeof hello["generation"] === "number" ? hello["generation"] : undefined
      if (generation === undefined) throw new Error("Relay hello returned no generation.")
      while (!opts.signal.aborted) {
        const pulled = await post(origin, opts.token, "/relay/pull", {
          runner_id: opts.runnerId,
          generation,
        }, opts.signal)
        if (!isRecord(pulled)) break
        if (pulled["error"] === "stale" || pulled["error"] === "pull_in_progress") break
        if (pulled["idle"] === true) continue
        const request = pulled["request"]
        if (!isRecord(request) || typeof request["requestId"] !== "string" || typeof request["path"] !== "string") {
          continue
        }
        const handled = await opts.handle({
          method: typeof request["method"] === "string" ? request["method"] : "POST",
          path: request["path"],
          bodyText: typeof request["bodyText"] === "string" ? request["bodyText"] : "",
          accept: typeof request["accept"] === "string" ? request["accept"] : null,
        })
        await post(origin, opts.token, "/relay/respond", {
          runner_id: opts.runnerId,
          generation,
          request_id: request["requestId"],
          status: handled.status,
          content_type: handled.contentType,
          body_text: handled.bodyText,
        }, opts.signal)
      }
    } catch (error) {
      if (opts.signal.aborted) return
      if (!(error instanceof Error)) throw error
      await delay(retryMs, opts.signal)
    }
  }
}

async function post(origin: string, token: string, path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
  const combinedSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000)
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
    signal: combinedSignal,
  })
  const text = await response.text()
  if (response.status >= 500) throw new Error(`Relay ${path} returned HTTP ${response.status}.`)
  if (text.length === 0) return null
  return JSON.parse(text) as unknown
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
}
