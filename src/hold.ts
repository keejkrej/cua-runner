import { Data, Effect, Ref } from "effect"
import { toolError, type ToolResult } from "./types"

export type Session = {
  readonly id: string
  readonly holder: string
  readonly purpose: string
  readonly claimedAt: number
  readonly expiresAt: number
}

export class DesktopBusy extends Data.TaggedError("DesktopBusy")<{
  readonly holder: string
  readonly purpose: string
  readonly sessionId: string
  readonly expiresAt: number
}> {}

export class UnknownSession extends Data.TaggedError("UnknownSession")<{}> {}

export class SessionExpired extends Data.TaggedError("SessionExpired")<{
  readonly sessionId: string
}> {}

export class InvalidArgument extends Data.TaggedError("InvalidArgument")<{
  readonly message: string
}> {}

export type HoldError = DesktopBusy | UnknownSession | SessionExpired | InvalidArgument

export type Hold = {
  readonly claim: (input: {
    readonly holder: string
    readonly purpose: string
    readonly ttlSeconds: number
  }) => Effect.Effect<Session, DesktopBusy | InvalidArgument>
  readonly release: (sessionId: string) => Effect.Effect<Session, UnknownSession | SessionExpired>
  readonly require: (sessionId: string) => Effect.Effect<Session, UnknownSession | SessionExpired>
  readonly list: () => Effect.Effect<readonly Session[]>
}

type Decision =
  | { readonly _tag: "ok"; readonly session: Session }
  | { readonly _tag: "busy"; readonly session: Session }
  | { readonly _tag: "missing" }
  | { readonly _tag: "expired" }

export const makeHold = (opts?: { readonly now?: () => number; readonly newId?: () => string }) =>
  Effect.gen(function* () {
    const now = opts?.now ?? Date.now
    const newId = opts?.newId ?? (() => crypto.randomUUID())
    const state = yield* Ref.make<Session | null>(null)

    const claim: Hold["claim"] = (input) =>
      Effect.gen(function* () {
        const holder = input.holder.trim()
        const purpose = input.purpose.trim()
        if (holder.length === 0 || holder.length > 120) {
          return yield* Effect.fail(new InvalidArgument({ message: "holder must be 1 to 120 characters." }))
        }
        if (purpose.length === 0 || purpose.length > 500) {
          return yield* Effect.fail(new InvalidArgument({ message: "purpose must be 1 to 500 characters." }))
        }
        if (!Number.isInteger(input.ttlSeconds) || input.ttlSeconds < 10 || input.ttlSeconds > 7200) {
          return yield* Effect.fail(new InvalidArgument({ message: "ttl_seconds must be an integer from 10 to 7200." }))
        }
        const decision = yield* Ref.modify(state, (current): [Decision, Session | null] => {
          const time = now()
          const live = current !== null && current.expiresAt > time ? current : null
          if (live && live.holder !== holder) return [{ _tag: "busy", session: live }, live]
          const next: Session = live
            ? { ...live, purpose, expiresAt: time + input.ttlSeconds * 1000 }
            : {
                id: newId(),
                holder,
                purpose,
                claimedAt: time,
                expiresAt: time + input.ttlSeconds * 1000,
              }
          return [{ _tag: "ok", session: next }, next]
        })
        if (decision._tag === "busy") {
          return yield* Effect.fail(
            new DesktopBusy({
              holder: decision.session.holder,
              purpose: decision.session.purpose,
              sessionId: decision.session.id,
              expiresAt: decision.session.expiresAt,
            }),
          )
        }
        if (decision._tag !== "ok") {
          return yield* Effect.fail(new InvalidArgument({ message: "claim failed." }))
        }
        return decision.session
      })

    const mutate = (sessionId: string, kind: "require" | "release") =>
      Effect.gen(function* () {
        const decision = yield* Ref.modify(state, (current): [Decision, Session | null] => {
          const time = now()
          if (current === null) return [{ _tag: "missing" }, null]
          const expired = current.expiresAt <= time
          if (current.id !== sessionId) {
            return [{ _tag: "missing" }, expired ? null : current]
          }
          if (expired) return [{ _tag: "expired" }, null]
          return [{ _tag: "ok", session: current }, kind === "release" ? null : current]
        })
        if (decision._tag === "ok") return decision.session
        if (decision._tag === "expired") return yield* Effect.fail(new SessionExpired({ sessionId }))
        return yield* Effect.fail(new UnknownSession())
      })

    const list: Hold["list"] = () =>
      Ref.modify(state, (current): [readonly Session[], Session | null] => {
        const time = now()
        if (current && current.expiresAt <= time) return [[], null]
        return [current ? [current] : [], current]
      })

    return {
      claim,
      release: (sessionId) => mutate(sessionId, "release"),
      require: (sessionId) => mutate(sessionId, "require"),
      list,
    } satisfies Hold
  })

export function sessionJson(session: Session, desktopId?: string) {
  return {
    session_id: session.id,
    holder: session.holder,
    purpose: session.purpose,
    claimed_at: session.claimedAt,
    expires_at: session.expiresAt,
    ...(desktopId ? { desktop_id: desktopId } : {}),
  }
}

export function holdErrorToTool(error: HoldError): ToolResult {
  switch (error._tag) {
    case "DesktopBusy":
      return toolError("desktop_busy", `Held by ${error.holder} for ${error.purpose}.`, {
        holder: error.holder,
        purpose: error.purpose,
        session_id: error.sessionId,
        expires_at: error.expiresAt,
      })
    case "UnknownSession":
      return toolError("unknown_session", "No hold matches that session_id.")
    case "SessionExpired":
      return toolError("session_expired", "The hold expired. claim_session again.", {
        session_id: error.sessionId,
      })
    case "InvalidArgument":
      return toolError("invalid_argument", error.message)
  }
}
