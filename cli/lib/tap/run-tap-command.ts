import Debug from 'debug'

import { findReadyRunner } from '../runner-discovery'
import type { FindRunnerOptions, ReadyRunnerDiscoveryRecord } from '../runner-discovery'
import { CdpProtocolError, CdpSession, listTargets } from './cdp'
import type { CdpCallFunctionOnResult, CdpEvaluateResult, CdpTarget } from './cdp'
import { TAP_BINDING_GLOBAL } from './contract'
import type { TapBindingContract } from './contract'

const debug = Debug('cypress:cli:tap')

export type TapTransportErrorCode =
  | 'CDP_UNREACHABLE'
  | 'RUNNER_PAGE_NOT_FOUND'
  | 'BINDING_NOT_FOUND'
  | 'BINDING_THREW'
  | 'STALE_HANDLE'

/**
 * A failure on the discovery/CDP path, distinct from a domain-level result.
 * Follows the `RunnerDiscoveryError` convention: a typed `code` callers can
 * switch on instead of parsing English messages.
 */
export class TapTransportError extends Error {
  code: TapTransportErrorCode

  constructor (code: TapTransportErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'TapTransportError'
    this.code = code
  }
}

export interface RunTapCommandOptions extends FindRunnerOptions {
  /** Absolute project root used to locate the running server's discovery record. */
  projectRoot: string
}

export interface TapCommandContext {
  record: ReadyRunnerDiscoveryRecord
}

// CDP's canonical replies when a navigation discarded the execution context
// holding our binding handle between acquiring and using it.
const STALE_OBJECT_RE = /Could not find object with given id|Cannot find context with specified id/i

const isStaleHandleError = (err: unknown): boolean => {
  return err instanceof CdpProtocolError && STALE_OBJECT_RE.test(err.message)
}

const isRunnerPageTarget = (target: CdpTarget, runnerOrigin: string): boolean => {
  return target.type === 'page' &&
    typeof target.url === 'string' &&
    target.url.startsWith(runnerOrigin) &&
    !!target.webSocketDebuggerUrl
}

// Chrome can advertise webSocketDebuggerUrl against its bind address (e.g.
// 0.0.0.0), which isn't connectable. Swap in the host the discovery record
// reached the endpoint on, keeping the advertised port and /devtools/... path.
const rewriteWsUrl = (wsUrl: string, record: ReadyRunnerDiscoveryRecord): string => {
  const url = new URL(wsUrl)

  url.hostname = record.cdpHost

  return url.toString()
}

const resolveBindingObjectId = async (session: CdpSession): Promise<string> => {
  // A constant expression — nothing is ever interpolated or escaped.
  const { result, exceptionDetails } = await session.send<CdpEvaluateResult>('Runtime.evaluate', {
    expression: `window.${TAP_BINDING_GLOBAL}`,
  })

  if (exceptionDetails) {
    throw new TapTransportError('CDP_UNREACHABLE', `Evaluating window.${TAP_BINDING_GLOBAL} failed: ${exceptionDetails.text}`)
  }

  if (result.type === 'undefined' || !result.objectId) {
    throw new TapTransportError(
      'BINDING_NOT_FOUND',
      `Found the Cypress runner page, but window.${TAP_BINDING_GLOBAL} is not mounted. The running Cypress version may not support \`cypress tap\`, or the runner is still loading — try again.`,
    )
  }

  return result.objectId
}

const callBindingMethod = (session: CdpSession, objectId: string, method: string, args: unknown[]): Promise<CdpCallFunctionOnResult> => {
  // The trampoline is a fixed template over a typed method name, and
  // `callFunctionOn` executes a function object (not a source string), so page
  // CSP cannot block it. `arguments` + `returnByValue` + `awaitPromise` are
  // the JSON wire boundary — CDP (de)serializes both directions.
  return session.send<CdpCallFunctionOnResult>('Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: `function (...a) { return this.${method}(...a) }`,
    arguments: args.map((value) => ({ value })),
    returnByValue: true,
    awaitPromise: true,
  })
}

/**
 * Run one tap subcommand end-to-end: discover the running Cypress, attach a
 * dedicated CDP session to its runner page target (externally what
 * `CriClient.clone()` does for in-process subsystems), invoke a
 * `TapBindingContract` method, and hand the JSON-decoded result to `handle`.
 *
 * Transport failures throw `RunnerDiscoveryError` (rethrown untouched from
 * discovery) or `TapTransportError`; they are never folded into domain
 * results.
 */
export const runTapCommand = async <
  M extends keyof TapBindingContract,
  R = Awaited<ReturnType<TapBindingContract[M]>>,
> (
  options: RunTapCommandOptions,
  method: M,
  args: Parameters<TapBindingContract[M]>,
  handle: (result: R, ctx: TapCommandContext) => void,
): Promise<void> => {
  const record = await findReadyRunner(options.projectRoot, { instance: options.instance })

  debug('found ready runner %o', { pid: record.pid, cdpHost: record.cdpHost, cdpPort: record.cdpPort })

  let targets: CdpTarget[]

  try {
    targets = await listTargets(record.cdpHost, record.cdpPort)
  } catch (err: any) {
    throw new TapTransportError(
      'CDP_UNREACHABLE',
      `Could not reach the browser's debugging endpoint at ${record.cdpHost}:${record.cdpPort}. The browser may have just closed; check Cypress and try again.`,
      { cause: err },
    )
  }

  // The runner page is matched by origin — the record deliberately carries no
  // targetId, so the match survives tab re-clones.
  // TODO: if two runner tabs against one origin ever prove ambiguous, probe
  // each candidate for the binding instead of taking the first.
  const target = targets.find((candidate) => isRunnerPageTarget(candidate, record.runnerOrigin))

  if (!target) {
    throw new TapTransportError(
      'RUNNER_PAGE_NOT_FOUND',
      `Connected to the browser, but found no Cypress runner page at ${record.runnerOrigin}. If the runner tab was closed, reopen it and try again.`,
    )
  }

  debug('matched runner page target %o', { id: target.id, url: target.url })

  let session: CdpSession

  try {
    session = await CdpSession.connect(rewriteWsUrl(target.webSocketDebuggerUrl!, record))
  } catch (err: any) {
    throw new TapTransportError(
      'CDP_UNREACHABLE',
      'Could not open a debugging connection to the Cypress runner page. The browser may have just closed; check Cypress and try again.',
      { cause: err },
    )
  }

  try {
    const objectId = await resolveBindingObjectId(session)

    let response: CdpCallFunctionOnResult

    try {
      response = await callBindingMethod(session, objectId, method, args)
    } catch (err: any) {
      if (!isStaleHandleError(err)) {
        throw new TapTransportError('CDP_UNREACHABLE', `The CDP call for ${method} failed: ${err.message}`, { cause: err })
      }

      // A navigation invalidated the handle between acquiring and using it.
      // The binding is re-findable by name, so re-acquire and retry once.
      debug('stale binding handle; re-acquiring and retrying once')

      const freshObjectId = await resolveBindingObjectId(session)

      try {
        response = await callBindingMethod(session, freshObjectId, method, args)
      } catch (retryErr: any) {
        if (isStaleHandleError(retryErr)) {
          throw new TapTransportError('STALE_HANDLE', 'The Cypress runner navigated while handling the command. Try again.', { cause: retryErr })
        }

        throw new TapTransportError('CDP_UNREACHABLE', `The CDP call for ${method} failed: ${retryErr.message}`, { cause: retryErr })
      }
    }

    if (response.exceptionDetails) {
      // Binding methods return domain failures as values; a throw is a binding
      // bug and is surfaced as a transport failure, never a domain result.
      throw new TapTransportError(
        'BINDING_THREW',
        `window.${TAP_BINDING_GLOBAL}.${method} threw: ${response.exceptionDetails.exception?.description || response.exceptionDetails.text}`,
      )
    }

    // returnByValue means result.value is already the JSON-decoded domain value.
    handle(response.result.value as R, { record })
  } finally {
    session.close()
  }
}
