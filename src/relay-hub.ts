export type ProxiedRequest = {
  readonly requestId: string
  readonly method: string
  readonly path: string
  readonly bodyText: string
  readonly accept: string | null
}

export type ProxiedResponse = {
  readonly status: number
  readonly contentType: string
  readonly bodyText: string
}

export type HubFailure =
  | "offline"
  | "stale"
  | "busy"
  | "replaced"
  | "timeout"
  | "unknown_request"
  | "pull_in_progress"

export type HubResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: HubFailure }

type Inflight = {
  readonly request: ProxiedRequest
  readonly resolve: (result: HubResult<ProxiedResponse>) => void
}

type Waiter = { readonly resolve: () => void }

type Slot = {
  generation: number
  name: string
  placement: string
  pending: Inflight[]
  inflight: Map<string, Inflight>
  waiter: Waiter | null
}

const fail = <T>(code: HubFailure): HubResult<T> => ({ ok: false, code })
const ok = <T>(value: T): HubResult<T> => ({ ok: true, value })

export class RelayHub {
  private readonly slots = new Map<string, Slot>()

  constructor(
    private readonly opts: { readonly pullWaitMs: number; readonly proxyWaitMs: number; readonly maxPending: number },
  ) {}

  hello(input: { readonly runnerId: string; readonly name: string; readonly placement: string }): { generation: number } {
    const existing = this.slots.get(input.runnerId)
    if (!existing) {
      this.slots.set(input.runnerId, {
        generation: 1,
        name: input.name,
        placement: input.placement,
        pending: [],
        inflight: new Map(),
        waiter: null,
      })
      return { generation: 1 }
    }
    const doomed = [...existing.pending, ...existing.inflight.values()]
    const waiter = existing.waiter
    existing.generation += 1
    existing.pending = []
    existing.inflight = new Map()
    existing.waiter = null
    existing.name = input.name
    existing.placement = input.placement
    for (const item of doomed) item.resolve(fail("replaced"))
    waiter?.resolve()
    return { generation: existing.generation }
  }

  async pull(
    runnerId: string,
    generation: number,
  ): Promise<HubResult<{ idle: true } | { idle: false; request: ProxiedRequest }>> {
    const slot = this.slots.get(runnerId)
    if (!slot || slot.generation !== generation) return fail("stale")
    const immediate = this.take(slot)
    if (immediate) return ok({ idle: false, request: immediate.request })
    if (slot.waiter) return fail("pull_in_progress")
    let resolveWait: () => void = () => {}
    const woken = new Promise<void>((resolve) => {
      resolveWait = resolve
    })
    const waiter = { resolve: resolveWait }
    slot.waiter = waiter
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, this.opts.pullWaitMs)
      woken.then(() => {
        clearTimeout(timer)
        resolve()
      })
    })
    if (slot.waiter === waiter) slot.waiter = null
    if (slot.generation !== generation) return fail("stale")
    const next = this.take(slot)
    if (next) return ok({ idle: false, request: next.request })
    return ok({ idle: true })
  }

  respond(
    runnerId: string,
    generation: number,
    requestId: string,
    response: ProxiedResponse,
  ): HubResult<{ accepted: true }> {
    const slot = this.slots.get(runnerId)
    if (!slot || slot.generation !== generation) return fail("stale")
    const item = slot.inflight.get(requestId)
    if (!item) return fail("unknown_request")
    slot.inflight.delete(requestId)
    item.resolve(ok(response))
    return ok({ accepted: true })
  }

  proxy(
    runnerId: string,
    input: { readonly method: string; readonly path: string; readonly bodyText: string; readonly accept: string | null },
  ): Promise<HubResult<ProxiedResponse>> {
    const slot = this.slots.get(runnerId)
    if (!slot) return Promise.resolve(fail("offline"))
    if (slot.pending.length >= this.opts.maxPending) return Promise.resolve(fail("busy"))
    const request: ProxiedRequest = {
      requestId: crypto.randomUUID(),
      method: input.method,
      path: input.path,
      bodyText: input.bodyText,
      accept: input.accept,
    }
    return new Promise((resolve) => {
      let settled = false
      const entry: Inflight = {
        request,
        resolve: (result) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          slot.pending = slot.pending.filter((item) => item !== entry)
          if (slot.inflight.get(request.requestId) === entry) slot.inflight.delete(request.requestId)
          resolve(result)
        },
      }
      const timer = setTimeout(() => entry.resolve(fail("timeout")), this.opts.proxyWaitMs)
      slot.pending.push(entry)
      const waiter = slot.waiter
      slot.waiter = null
      waiter?.resolve()
    })
  }

  private take(slot: Slot): Inflight | undefined {
    const item = slot.pending.shift()
    if (!item) return undefined
    slot.inflight.set(item.request.requestId, item)
    return item
  }
}
