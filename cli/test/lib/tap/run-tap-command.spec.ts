import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import http from 'http'
import type { AddressInfo } from 'net'
import { WebSocketServer } from 'ws'
import type WebSocket from 'ws'

import { findReadyRunner, RunnerDiscoveryError } from '../../../lib/runner-discovery'
import type { ReadyRunnerDiscoveryRecord } from '../../../lib/runner-discovery'
import { runTapCommand, TapTransportError } from '../../../lib/tap/run-tap-command'

vi.mock('../../../lib/runner-discovery', async (importActual) => {
  const actual = await importActual<typeof import('../../../lib/runner-discovery')>()

  return {
    ...actual,
    findReadyRunner: vi.fn(),
  }
})

const HOST = '127.0.0.1'
const RUNNER_ORIGIN = 'http://localhost:5555'
const PROJECT = '/projects/app'

type Closer = () => Promise<void>

let closers: Closer[] = []

afterEach(async () => {
  await Promise.all(closers.map((close) => close()))
  closers = []
})

/**
 * Per-method scripted replies for the fake page target. A handler returns
 * `{ result }` or `{ error }` (sent back with the request's id), or `undefined`
 * to never reply.
 */
type CdpHandler = (message: any, socket: WebSocket) => { result?: any, error?: any } | undefined

interface FakeBrowserOptions {
  handlers?: Record<string, CdpHandler>
  /** Built once the ws port is known; defaults to a single matching runner page. */
  targets?: (wsPort: number) => any[]
}

const defaultTargets = (wsPort: number) => {
  return [{
    id: 'T1',
    type: 'page',
    url: `${RUNNER_ORIGIN}/__/#/specs/runner`,
    webSocketDebuggerUrl: `ws://${HOST}:${wsPort}/devtools/page/T1`,
  }]
}

/**
 * A fake browser CDP endpoint: an http server for /json/list plus a ws server
 * acting as the runner page target.
 */
const startFakeBrowser = async (options: FakeBrowserOptions = {}) => {
  const handlers = options.handlers ?? {}
  let connections = 0

  const wss = await new Promise<WebSocketServer>((resolve) => {
    const server = new WebSocketServer({ host: HOST, port: 0 }, () => resolve(server))
  })

  closers.push(() => {
    for (const client of wss.clients) {
      client.terminate()
    }

    return new Promise((done) => wss.close(() => done()))
  })

  wss.on('connection', (socket) => {
    connections += 1

    socket.on('message', (raw) => {
      const message = JSON.parse(String(raw))
      const reply = handlers[message.method]?.(message, socket)

      if (reply === undefined) {
        return
      }

      socket.send(JSON.stringify({ id: message.id, ...reply }))
    })
  })

  const wsPort = (wss.address() as AddressInfo).port
  const targets = (options.targets ?? defaultTargets)(wsPort)

  const httpServer = await new Promise<http.Server>((resolve) => {
    const server = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(targets))
    })

    server.listen(0, HOST, () => resolve(server))
  })

  closers.push(() => {
    return new Promise((done) => httpServer.close(() => done()))
  })

  return {
    cdpPort: (httpServer.address() as AddressInfo).port,
    wsPort,
    getConnections: () => connections,
  }
}

const makeRecord = (overrides: Partial<ReadyRunnerDiscoveryRecord> = {}): ReadyRunnerDiscoveryRecord => {
  return {
    schemaVersion: 1,
    pid: 1234,
    cypressVersion: '15.0.0',
    projectRoot: PROJECT,
    runnerOrigin: RUNNER_ORIGIN,
    cdpStatus: 'ready',
    cdpHost: HOST,
    cdpPort: 0,
    createdAt: 1700000000000,
    ...overrides,
  }
}

const discoverAt = (cdpPort: number, overrides: Partial<ReadyRunnerDiscoveryRecord> = {}): ReadyRunnerDiscoveryRecord => {
  const record = makeRecord({ cdpPort, ...overrides })

  vi.mocked(findReadyRunner).mockResolvedValue(record)

  return record
}

// Scripted binding replies: a healthy evaluate handing out objectIds, and a
// healthy getHealth call.
const evaluateOk = (objectId = 'OBJ1'): CdpHandler => {
  return () => ({ result: { result: { type: 'object', objectId } } })
}

const callOk = (value: any = 'ok'): CdpHandler => {
  return () => ({ result: { result: { type: 'string', value } } })
}

const staleObjectError = { error: { code: -32000, message: 'Could not find object with given id' } }

const expectCode = async (promise: Promise<any>, code: string) => {
  const err = await promise.catch((e) => e)

  expect(err).toBeInstanceOf(TapTransportError)
  expect(err.code).toBe(code)

  return err
}

describe('lib/tap/run-tap-command', () => {
  beforeEach(() => {
    vi.mocked(findReadyRunner).mockReset()
  })

  it('discovers, attaches, invokes the binding method, and hands the result to handle', async () => {
    const evaluate = vi.fn(evaluateOk())
    const callFunctionOn = vi.fn(callOk())
    const { cdpPort } = await startFakeBrowser({
      handlers: { 'Runtime.evaluate': evaluate, 'Runtime.callFunctionOn': callFunctionOn },
    })
    const record = discoverAt(cdpPort)

    const handle = vi.fn()

    await runTapCommand({ projectRoot: PROJECT, instance: 1234 }, 'getHealth', [], handle)

    expect(findReadyRunner).toHaveBeenCalledWith(PROJECT, { instance: 1234 })
    expect(handle).toHaveBeenCalledWith('ok', { record })

    expect(evaluate).toHaveBeenCalledOnce()
    expect(evaluate.mock.calls[0][0].params).toEqual({ expression: 'window.__CYPRESS_TAP_BINDING__' })

    expect(callFunctionOn).toHaveBeenCalledOnce()
    expect(callFunctionOn.mock.calls[0][0].params).toEqual({
      objectId: 'OBJ1',
      functionDeclaration: 'function (...a) { return this.getHealth(...a) }',
      arguments: [],
      returnByValue: true,
      awaitPromise: true,
    })
  })

  it('re-acquires the binding and retries once on a stale handle', async () => {
    let evaluations = 0
    const evaluate = vi.fn((() => {
      evaluations += 1

      return { result: { result: { type: 'object', objectId: `OBJ${evaluations}` } } }
    }) as CdpHandler)

    const callFunctionOn = vi.fn(((message) => {
      if (message.params.objectId === 'OBJ1') {
        return staleObjectError
      }

      return { result: { result: { type: 'string', value: 'ok' } } }
    }) as CdpHandler)

    const { cdpPort } = await startFakeBrowser({
      handlers: { 'Runtime.evaluate': evaluate, 'Runtime.callFunctionOn': callFunctionOn },
    })

    discoverAt(cdpPort)

    const handle = vi.fn()

    await runTapCommand({ projectRoot: PROJECT }, 'getHealth', [], handle)

    expect(handle).toHaveBeenCalledWith('ok', expect.anything())
    expect(evaluate).toHaveBeenCalledTimes(2)
    expect(callFunctionOn).toHaveBeenCalledTimes(2)
    expect(callFunctionOn.mock.calls[1][0].params.objectId).toBe('OBJ2')
  })

  it('throws STALE_HANDLE when the handle is still stale after one retry', async () => {
    const evaluate = vi.fn(evaluateOk())
    const callFunctionOn = vi.fn((() => staleObjectError) as CdpHandler)
    const { cdpPort } = await startFakeBrowser({
      handlers: { 'Runtime.evaluate': evaluate, 'Runtime.callFunctionOn': callFunctionOn },
    })

    discoverAt(cdpPort)

    await expectCode(runTapCommand({ projectRoot: PROJECT }, 'getHealth', [], vi.fn()), 'STALE_HANDLE')

    // exactly one re-acquire — no unbounded retry loops
    expect(evaluate).toHaveBeenCalledTimes(2)
    expect(callFunctionOn).toHaveBeenCalledTimes(2)
  })

  it('throws BINDING_NOT_FOUND when the binding is not mounted', async () => {
    const callFunctionOn = vi.fn(callOk())
    const { cdpPort } = await startFakeBrowser({
      handlers: {
        'Runtime.evaluate': () => ({ result: { result: { type: 'undefined' } } }),
        'Runtime.callFunctionOn': callFunctionOn,
      },
    })

    discoverAt(cdpPort)

    await expectCode(runTapCommand({ projectRoot: PROJECT }, 'getHealth', [], vi.fn()), 'BINDING_NOT_FOUND')
    expect(callFunctionOn).not.toHaveBeenCalled()
  })

  it('throws BINDING_THREW when the binding method throws', async () => {
    const { cdpPort } = await startFakeBrowser({
      handlers: {
        'Runtime.evaluate': evaluateOk(),
        'Runtime.callFunctionOn': () => ({
          result: {
            result: { type: 'object', subtype: 'error' },
            exceptionDetails: { text: 'Uncaught (in promise)', exception: { type: 'object', description: 'Error: boom' } },
          },
        }),
      },
    })

    discoverAt(cdpPort)

    const err = await expectCode(runTapCommand({ projectRoot: PROJECT }, 'getHealth', [], vi.fn()), 'BINDING_THREW')

    expect(err.message).toContain('Error: boom')
  })

  it('throws RUNNER_PAGE_NOT_FOUND when no page target matches the runner origin', async () => {
    const { cdpPort, getConnections } = await startFakeBrowser({
      targets: (wsPort: number) => {
        return [
          // wrong origin
          { id: 'T1', type: 'page', url: 'http://localhost:7777/other', webSocketDebuggerUrl: `ws://${HOST}:${wsPort}/devtools/page/T1` },
          // right origin, but not a page
          { id: 'T2', type: 'service_worker', url: `${RUNNER_ORIGIN}/sw.js`, webSocketDebuggerUrl: `ws://${HOST}:${wsPort}/devtools/page/T2` },
        ]
      },
    })

    discoverAt(cdpPort)

    await expectCode(runTapCommand({ projectRoot: PROJECT }, 'getHealth', [], vi.fn()), 'RUNNER_PAGE_NOT_FOUND')
    expect(getConnections()).toBe(0)
  })

  it('throws CDP_UNREACHABLE when the debugging endpoint is unreachable', async () => {
    // Grab a port with nothing listening on it.
    const server = await new Promise<http.Server>((resolve) => {
      const listening = http.createServer()

      listening.listen(0, HOST, () => resolve(listening))
    })
    const deadPort = (server.address() as AddressInfo).port

    await new Promise((done) => server.close(() => done(null)))

    discoverAt(deadPort)

    await expectCode(runTapCommand({ projectRoot: PROJECT }, 'getHealth', [], vi.fn()), 'CDP_UNREACHABLE')
  })

  it('throws CDP_UNREACHABLE when the page target websocket is dead', async () => {
    const { cdpPort, wsPort } = await startFakeBrowser({
      targets: () => {
        return [{
          id: 'T1',
          type: 'page',
          url: `${RUNNER_ORIGIN}/__/`,
          // a port in the dynamic range that nothing in this suite listens on
          webSocketDebuggerUrl: `ws://${HOST}:1/devtools/page/T1`,
        }]
      },
    })

    expect(wsPort).toBeGreaterThan(0)
    discoverAt(cdpPort)

    await expectCode(runTapCommand({ projectRoot: PROJECT }, 'getHealth', [], vi.fn()), 'CDP_UNREACHABLE')
  })

  it('throws CDP_UNREACHABLE when the socket dies mid-call', async () => {
    const { cdpPort } = await startFakeBrowser({
      handlers: {
        'Runtime.evaluate': evaluateOk(),
        'Runtime.callFunctionOn': (message, socket) => {
          socket.terminate()

          return undefined
        },
      },
    })

    discoverAt(cdpPort)

    await expectCode(runTapCommand({ projectRoot: PROJECT }, 'getHealth', [], vi.fn()), 'CDP_UNREACHABLE')
  })

  it('rethrows discovery errors untouched', async () => {
    const discoveryErr = new RunnerDiscoveryError('NO_DISCOVERY_FILE', 'No running Cypress was found.')

    vi.mocked(findReadyRunner).mockRejectedValue(discoveryErr)

    const err = await runTapCommand({ projectRoot: PROJECT }, 'getHealth', [], vi.fn()).catch((e) => e)

    expect(err).toBe(discoveryErr)
    expect(err).toBeInstanceOf(RunnerDiscoveryError)
    expect(err.code).toBe('NO_DISCOVERY_FILE')
  })

  it('connects via the record cdpHost when the advertised websocket host is unconnectable', async () => {
    const { cdpPort } = await startFakeBrowser({
      handlers: { 'Runtime.evaluate': evaluateOk(), 'Runtime.callFunctionOn': callOk() },
      targets: (wsPort: number) => {
        return [{
          id: 'T1',
          type: 'page',
          url: `${RUNNER_ORIGIN}/__/`,
          // Chrome can advertise its bind address — not connectable as-is
          webSocketDebuggerUrl: `ws://0.0.0.0:${wsPort}/devtools/page/T1`,
        }]
      },
    })

    discoverAt(cdpPort)

    const handle = vi.fn()

    await runTapCommand({ projectRoot: PROJECT }, 'getHealth', [], handle)

    expect(handle).toHaveBeenCalledWith('ok', expect.anything())
  })

  it('uses the first page target when multiple match the runner origin', async () => {
    const { cdpPort } = await startFakeBrowser({
      handlers: { 'Runtime.evaluate': evaluateOk(), 'Runtime.callFunctionOn': callOk() },
      targets: (wsPort: number) => {
        return [
          { id: 'T1', type: 'page', url: `${RUNNER_ORIGIN}/__/`, webSocketDebuggerUrl: `ws://${HOST}:${wsPort}/devtools/page/T1` },
          // picking this one would fail: nothing listens there
          { id: 'T2', type: 'page', url: `${RUNNER_ORIGIN}/__/`, webSocketDebuggerUrl: `ws://${HOST}:1/devtools/page/T2` },
        ]
      },
    })

    discoverAt(cdpPort)

    const handle = vi.fn()

    await runTapCommand({ projectRoot: PROJECT }, 'getHealth', [], handle)

    expect(handle).toHaveBeenCalledWith('ok', expect.anything())
  })
})
