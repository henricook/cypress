import http from 'http'
import Debug from 'debug'
import WebSocket from 'ws'

const debug = Debug('cypress:cli:tap:cdp')

export const CDP_CONNECT_TIMEOUT_MS = 10000

export const CDP_CALL_TIMEOUT_MS = 10000

/**
 * The CDP endpoint could not be reached, or an established connection died
 * (or timed out) before a reply arrived.
 */
export class CdpConnectionError extends Error {
  constructor (message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'CdpConnectionError'
  }
}

/** The browser replied to a CDP command with a protocol-level error. */
export class CdpProtocolError extends Error {
  code?: number

  constructor (message: string, code?: number) {
    super(message)
    this.name = 'CdpProtocolError'
    this.code = code
  }
}

/**
 * Minimal mirrors of the CDP Runtime-domain shapes this client touches. The
 * CLI drives exactly two stable methods (`Runtime.evaluate` and
 * `Runtime.callFunctionOn`), so it deliberately carries no `devtools-protocol`
 * dependency.
 */
export interface CdpRemoteObject {
  type: string
  subtype?: string
  objectId?: string
  value?: any
  description?: string
}

export interface CdpExceptionDetails {
  text: string
  exception?: CdpRemoteObject
  lineNumber?: number
  columnNumber?: number
}

export interface CdpEvaluateResult {
  result: CdpRemoteObject
  exceptionDetails?: CdpExceptionDetails
}

export type CdpCallFunctionOnResult = CdpEvaluateResult

/** One entry from the browser's `/json/list` target index. */
export interface CdpTarget {
  id: string
  type: string
  url: string
  title?: string
  webSocketDebuggerUrl?: string
}

/**
 * List the browser's debuggable targets via `GET /json/list`.
 *
 * Uses plain node `http` rather than a request library: request libraries
 * honor HTTP_PROXY env vars, which would divert this loopback call through a
 * corporate proxy. The host is an IP literal (the server publishes
 * `127.0.0.1`), so the Host header also passes Chrome's DNS-rebinding guard
 * as-is.
 */
export const listTargets = (host: string, port: number, options: { timeout?: number } = {}): Promise<CdpTarget[]> => {
  const timeout = options.timeout ?? CDP_CONNECT_TIMEOUT_MS

  return new Promise((resolve, reject) => {
    const req = http.get({ host, port, path: '/json/list', timeout }, (res) => {
      if (res.statusCode !== 200) {
        res.resume()
        reject(new CdpConnectionError(`The browser's CDP endpoint at ${host}:${port} responded to /json/list with HTTP ${res.statusCode}.`))

        return
      }

      let body = ''

      res.setEncoding('utf8')

      res.on('data', (chunk) => {
        body += chunk
      })

      res.on('end', () => {
        try {
          resolve(JSON.parse(body))
        } catch (err) {
          reject(new CdpConnectionError(`The browser's CDP endpoint at ${host}:${port} returned an unparseable /json/list response.`, { cause: err }))
        }
      })
    })

    req.on('timeout', () => {
      // destroy() surfaces this error through the 'error' handler below
      req.destroy(new CdpConnectionError(`Timed out reaching the browser's CDP endpoint at ${host}:${port}.`))
    })

    req.on('error', (err) => {
      reject(err instanceof CdpConnectionError ? err : new CdpConnectionError(`Could not reach the browser's CDP endpoint at ${host}:${port}.`, { cause: err }))
    })
  })
}

interface PendingCommand {
  method: string
  resolve: (value: any) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

/**
 * A minimal JSON-RPC session against one CDP target's WebSocket endpoint —
 * just enough protocol for a one-shot CLI invocation: open, send a handful of
 * commands, close. Events (id-less frames) are ignored; no domains are ever
 * enabled.
 */
export class CdpSession {
  private ws: WebSocket
  private nextId = 1
  private pending = new Map<number, PendingCommand>()
  private closedReason: CdpConnectionError | null = null

  private constructor (ws: WebSocket) {
    this.ws = ws

    ws.on('message', (data) => this.onMessage(data))
    ws.on('error', (err) => this.onClosed(new CdpConnectionError('The CDP connection errored.', { cause: err })))
    ws.on('close', () => this.onClosed(new CdpConnectionError('The CDP connection closed.')))
  }

  static connect (url: string, options: { connectTimeout?: number } = {}): Promise<CdpSession> {
    const connectTimeout = options.connectTimeout ?? CDP_CONNECT_TIMEOUT_MS

    debug('connecting to %s', url)

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { perMessageDeflate: false })

      const onOpen = () => {
        cleanup()
        resolve(new CdpSession(ws))
      }

      // also covers a non-101 upgrade response, which ws surfaces as 'error'
      const onError = (err: Error) => {
        cleanup()
        reject(new CdpConnectionError(`Could not open a CDP connection to ${url}.`, { cause: err }))
      }

      const timer = setTimeout(() => {
        cleanup()
        // terminating a half-open handshake makes ws emit an 'error' we no
        // longer care about — swallow it so it can't become uncaught
        ws.on('error', () => {})
        ws.terminate()
        reject(new CdpConnectionError(`Timed out opening a CDP connection to ${url}.`))
      }, connectTimeout)

      const cleanup = () => {
        clearTimeout(timer)
        ws.removeListener('open', onOpen)
        ws.removeListener('error', onError)
      }

      ws.once('open', onOpen)
      ws.once('error', onError)
    })
  }

  /**
   * Send one CDP command and resolve with its `result`. Rejects with
   * `CdpProtocolError` when the browser replies with an error, or
   * `CdpConnectionError` when the socket dies or the call times out.
   */
  send <R = any> (method: string, params: object = {}, options: { timeout?: number } = {}): Promise<R> {
    if (this.closedReason) {
      return Promise.reject(this.closedReason)
    }

    const id = this.nextId++
    const timeout = options.timeout ?? CDP_CALL_TIMEOUT_MS

    debug('sending %s (id %d)', method, id)

    return new Promise<R>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new CdpConnectionError(`The CDP call ${method} timed out after ${timeout}ms.`))
      }, timeout)

      this.pending.set(id, { method, resolve, reject, timer })

      this.ws.send(JSON.stringify({ id, method, params }), (err) => {
        if (err && this.pending.has(id)) {
          clearTimeout(timer)
          this.pending.delete(id)
          reject(new CdpConnectionError(`Failed to send the CDP call ${method}.`, { cause: err }))
        }
      })
    })
  }

  /** Close the session. Idempotent; rejects any in-flight calls. */
  close (): void {
    this.onClosed(new CdpConnectionError('The CDP session was closed.'))

    try {
      this.ws.close()
    } catch (err) {
      debug('error closing the CDP websocket: %o', err)
    }
  }

  private onClosed (reason: CdpConnectionError): void {
    if (this.closedReason) {
      return
    }

    this.closedReason = reason

    for (const command of this.pending.values()) {
      clearTimeout(command.timer)
      command.reject(reason)
    }

    this.pending.clear()
  }

  private onMessage (data: any): void {
    let message: any

    try {
      message = JSON.parse(String(data))
    } catch (err) {
      // A malformed frame must not take down an otherwise healthy session.
      debug('ignoring an unparseable CDP frame: %o', err)

      return
    }

    if (message.id === undefined) {
      // Frames without an id are CDP events; this client subscribes to none.
      debug('ignoring CDP event %s', message.method)

      return
    }

    const command = this.pending.get(message.id)

    if (!command) {
      debug('ignoring a CDP reply for unknown id %d', message.id)

      return
    }

    clearTimeout(command.timer)
    this.pending.delete(message.id)

    if (message.error) {
      command.reject(new CdpProtocolError(message.error.message || `The CDP call ${command.method} failed.`, message.error.code))
    } else {
      command.resolve(message.result)
    }
  }
}
