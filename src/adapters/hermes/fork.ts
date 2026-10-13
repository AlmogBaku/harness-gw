/**
 * Forking a Hermes Session: `session.branch` on its live Session, the one
 * native write the fork action and a typed `/branch` share. Hermes copies the
 * visible user and assistant rows into a new stored Session, which it keeps
 * listed, and leaves the original as it was; its CLI `/branch` is the path
 * that ends the original, so nothing here goes through the slash worker.
 */
import {
  HermesRpcRejectedError,
  HermesRpcUncertainError,
  throwUnavailable,
  type HermesLog,
  type HermesRpcTransport,
} from "./gateway"
import { isSessionGone } from "./attachment-registry"
import { isRecord, nativeId, trimmedText } from "./native"
import {
  DEFAULT_RETRY_SCHEDULE,
  retryTransient,
  type HermesRetrySchedule,
} from "./transient-rejections"

/** What Hermes forked a Session into. */
export type HermesBranch = {
  /** The new Session's stored id, the one it is listed and resumed by. */
  storedSessionId: string
  title?: string
}

/**
 * Hermes may have stored the fork without answering for it: it stores the new
 * Session before it builds its agent, and answers 5000 when that build fails,
 * or the answer was lost. Reconcile with the Session list before forking again.
 */
export class HermesForkUncertainError extends Error {
  constructor(options?: ErrorOptions) {
    super("Hermes may have forked the Session", options)
    this.name = "HermesForkUncertainError"
  }
}

/** The Session holds nothing Hermes can fork yet: no visible message. */
export class HermesForkRefusedError extends Error {
  constructor(options?: ErrorOptions) {
    super("The Session has no conversation to fork yet", options)
    this.name = "HermesForkRefusedError"
  }
}

/** `session.branch` answers 4008 before it writes anything. */
const NOTHING_TO_BRANCH = 4008
/** `session.branch` answers 5000 once the fork's row is already stored. */
const STORED_THEN_FAILED = 5000

/**
 * Forks the Session live as `liveSessionId` and closes the fork's own live
 * Session, which Hermes exempts from its reapers; its stored row stays
 * resumable. A rejection saying the live Session is gone is rethrown as it
 * is, so the caller rebinds and branches again: nothing was written.
 */
export async function branchLiveSession(
  transport: HermesRpcTransport,
  liveSessionId: string,
  options: {
    /** The fork's title; Hermes derives one from the original's without it. */
    name?: string
    log?: HermesLog
    retry?: HermesRetrySchedule
  } = {}
): Promise<HermesBranch> {
  let payload: unknown
  try {
    payload = await retryTransient(
      () =>
        transport.request("session.branch", {
          session_id: liveSessionId,
          ...(options.name ? { name: options.name } : {}),
        }),
      options.retry ?? DEFAULT_RETRY_SCHEDULE
    )
  } catch (error) {
    if (error instanceof HermesRpcUncertainError)
      throw new HermesForkUncertainError({ cause: error })
    if (error instanceof HermesRpcRejectedError) {
      options.log?.warn(
        { method: "session.branch", code: error.code },
        "hermes.native.rejected"
      )
      if (isSessionGone(error)) throw error
      if (error.code === NOTHING_TO_BRANCH)
        throw new HermesForkRefusedError({ cause: error })
      if (error.code === STORED_THEN_FAILED)
        throw new HermesForkUncertainError({ cause: error })
    }
    throwUnavailable(error)
  }
  const storedSessionId = isRecord(payload)
    ? trimmedText(payload.stored_session_id)
    : undefined
  // Hermes answered for a fork it made: one whose id cannot be read may stand.
  if (!isRecord(payload) || !storedSessionId || storedSessionId.length > 256)
    throw new HermesForkUncertainError()
  const branchLiveId = nativeId(payload.session_id, 256)
  if (branchLiveId)
    await transport
      .request("session.close", { session_id: branchLiveId })
      .catch((err: unknown) =>
        options.log?.warn({ err }, "hermes.fork.close_failed")
      )
  const title = trimmedText(payload.title)
  return { storedSessionId, ...(title ? { title } : {}) }
}
