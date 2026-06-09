import Debug from 'debug'
import CRI from 'chrome-remote-interface'

import { findReadyRunner } from '../runner-discovery'
import type { FindRunnerOptions, ReadyRunnerDiscoveryRecord } from '../runner-discovery'
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
  // CRI rejects protocol errors as a `ProtocolError` whose message carries the
  // CDP text, so match on the message rather than an error class.
  return err instanceof Error && STALE_OBJECT_RE.test(err.message)
}

// Structural subset of CDP `Target.TargetInfo` — enough to pick the runner page
// without coupling to the full `devtools-protocol` type surface.
const isRunnerPageTarget = (target: { type: string, url: string }, runnerOrigin: string): boolean => {
  return target.type === 'page' &&
    typeof target.url === 'string' &&
    target.url.startsWith(runnerOrigin)
}

// Passing a `ws://` URL makes CRI connect straight to it with no HTTP /json
// call — so discovery → connection is entirely over the wire.
const connectToBrowser = async (wsUrl: string): Promise<CRI.Client> => {
  try {
    return await CRI({ target: wsUrl })
  } catch (err: any) {
    throw new TapTransportError(
      'CDP_UNREACHABLE',
      'Could not open a debugging connection to the browser. It may have just closed; check Cypress and try again.',
      { cause: err },
    )
  }
}

const listTargets = async (client: CRI.Client) => {
  try {
    return await client.Target.getTargets()
  } catch (err: any) {
    throw new TapTransportError('CDP_UNREACHABLE', `Connected to the browser, but listing its targets failed: ${err.message}`, { cause: err })
  }
}

const attachToPage = async (client: CRI.Client, targetId: string): Promise<string> => {
  try {
    // `flatten` multiplexes the page session over the existing browser
    // connection — subsequent commands carry the returned sessionId.
    const { sessionId } = await client.Target.attachToTarget({ targetId, flatten: true })

    return sessionId
  } catch (err: any) {
    throw new TapTransportError(
      'CDP_UNREACHABLE',
      'Could not attach to the Cypress runner page. The browser may have just closed; check Cypress and try again.',
      { cause: err },
    )
  }
}

const resolveBindingObjectId = async (client: CRI.Client, sessionId: string): Promise<string> => {
  // A constant expression — nothing is ever interpolated or escaped.
  const { result, exceptionDetails } = await client.Runtime.evaluate({
    expression: `window.${TAP_BINDING_GLOBAL}`,
  }, sessionId)

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

const callBindingMethod = (client: CRI.Client, sessionId: string, objectId: string, method: string, args: unknown[]) => {
  // The trampoline is a fixed template over a typed method name, and
  // `callFunctionOn` executes a function object (not a source string), so page
  // CSP cannot block it. `arguments` + `returnByValue` + `awaitPromise` are
  // the JSON wire boundary — CDP (de)serializes both directions.
  return client.Runtime.callFunctionOn({
    objectId,
    functionDeclaration: `function (...a) { return this.${method}(...a) }`,
    arguments: args.map((value) => ({ value })),
    returnByValue: true,
    awaitPromise: true,
  }, sessionId)
}

const callBindingWithRetry = async (client: CRI.Client, sessionId: string, method: string, args: unknown[]) => {
  const objectId = await resolveBindingObjectId(client, sessionId)

  try {
    return await callBindingMethod(client, sessionId, objectId, method, args)
  } catch (err: any) {
    if (!isStaleHandleError(err)) {
      throw new TapTransportError('CDP_UNREACHABLE', `The CDP call for ${method} failed: ${err.message}`, { cause: err })
    }

    // A navigation invalidated the handle between acquiring and using it.
    // The binding is re-findable by name, so re-acquire and retry once.
    debug('stale binding handle; re-acquiring and retrying once')

    const freshObjectId = await resolveBindingObjectId(client, sessionId)

    try {
      return await callBindingMethod(client, sessionId, freshObjectId, method, args)
    } catch (retryErr: any) {
      if (isStaleHandleError(retryErr)) {
        throw new TapTransportError('STALE_HANDLE', 'The Cypress runner navigated while handling the command. Try again.', { cause: retryErr })
      }

      throw new TapTransportError('CDP_UNREACHABLE', `The CDP call for ${method} failed: ${retryErr.message}`, { cause: retryErr })
    }
  }
}

/**
 * Run one tap subcommand end-to-end: discover the running Cypress, open a CDP
 * connection to its browser endpoint, attach a flattened session to the runner
 * page target (matched by origin — externally what `CriClient.clone()` does for
 * in-process subsystems), invoke a `TapBindingContract` method, and hand the
 * JSON-decoded result to `handle`.
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

  debug('found ready runner %o', { pid: record.pid, cdpBrowserWsUrl: record.cdpBrowserWsUrl })

  const client = await connectToBrowser(record.cdpBrowserWsUrl)

  try {
    const { targetInfos } = await listTargets(client)

    // The runner page is matched by origin — the record carries no targetId, so
    // the match survives tab re-clones.
    // TODO: if two runner tabs against one origin ever prove ambiguous, probe
    // each candidate for the binding instead of taking the first.
    const target = targetInfos.find((candidate) => isRunnerPageTarget(candidate, record.runnerOrigin))

    if (!target) {
      throw new TapTransportError(
        'RUNNER_PAGE_NOT_FOUND',
        `Connected to the browser, but found no Cypress runner page at ${record.runnerOrigin}. If the runner tab was closed, reopen it and try again.`,
      )
    }

    debug('matched runner page target %o', { targetId: target.targetId, url: target.url })

    const sessionId = await attachToPage(client, target.targetId)
    const response = await callBindingWithRetry(client, sessionId, method, args)

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
    // close() can reject if the socket already died; the command result stands.
    await client.close().catch(() => {})
  }
}
