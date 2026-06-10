import { beforeEach, describe, expect, it, vi } from 'vitest'
import CRI from 'chrome-remote-interface'

import { findReadyRunner, RunnerDiscoveryError } from '../../../lib/runner-discovery'
import type { ReadyRunnerDiscoveryRecord } from '../../../lib/runner-discovery'
import { withTapSession, TapTransportError } from '../../../lib/tap/tap-session'

vi.mock('../../../lib/runner-discovery', async (importActual) => {
  const actual = await importActual<typeof import('../../../lib/runner-discovery')>()

  return {
    ...actual,
    findReadyRunner: vi.fn(),
  }
})

// Drive `chrome-remote-interface` at the SDK boundary: the factory and the
// client it returns are stubbed, so the transport (WebSocket, JSON-RPC,
// sessionId routing) is the SDK's concern and never exercised here.
vi.mock('chrome-remote-interface', () => ({ default: vi.fn() }))

const RUNNER_ORIGIN = 'http://localhost:5555'
const PROJECT = '/projects/app'
const BROWSER_WS_URL = 'ws://127.0.0.1:9999/devtools/browser/abc-123'

const mockConnect = vi.mocked(CRI as unknown as ReturnType<typeof vi.fn>)

const pageTarget = (targetId = 'T1', url = `${RUNNER_ORIGIN}/__/#/specs/runner`) => {
  return { targetId, type: 'page', url }
}

interface FakeClientOverrides {
  targetInfos?: any[]
  evaluate?: ReturnType<typeof vi.fn>
  callFunctionOn?: ReturnType<typeof vi.fn>
  getTargets?: ReturnType<typeof vi.fn>
  attachToTarget?: ReturnType<typeof vi.fn>
}

// A fake CRI client with healthy defaults: one runner page with the binding,
// a flat session, an objectId from evaluate, and a 'ok' from callFunctionOn.
const makeClient = (overrides: FakeClientOverrides = {}) => {
  const client = {
    Target: {
      getTargets: overrides.getTargets ?? vi.fn().mockResolvedValue({ targetInfos: overrides.targetInfos ?? [pageTarget()] }),
      attachToTarget: overrides.attachToTarget ?? vi.fn().mockResolvedValue({ sessionId: 'SID1' }),
      detachFromTarget: vi.fn().mockResolvedValue({}),
    },
    Runtime: {
      evaluate: overrides.evaluate ?? vi.fn().mockResolvedValue({ result: { type: 'object', objectId: 'OBJ1' } }),
      callFunctionOn: overrides.callFunctionOn ?? vi.fn().mockResolvedValue({ result: { type: 'string', value: 'ok' } }),
    },
    close: vi.fn().mockResolvedValue(undefined),
  }

  return client
}

const makeRecord = (overrides: Partial<ReadyRunnerDiscoveryRecord> = {}): ReadyRunnerDiscoveryRecord => {
  return {
    schemaVersion: 2,
    pid: 1234,
    cypressVersion: '15.0.0',
    projectRoot: PROJECT,
    cdpStatus: 'ready',
    cdpBrowserWsUrl: BROWSER_WS_URL,
    ...overrides,
  }
}

// Wire up discovery + a fake browser client for one run. Returns both so tests
// can assert against the record and the client's stubbed methods.
const discover = (client = makeClient(), overrides: Partial<ReadyRunnerDiscoveryRecord> = {}) => {
  const record = makeRecord(overrides)

  vi.mocked(findReadyRunner).mockResolvedValue(record)
  mockConnect.mockResolvedValue(client)

  return { record, client }
}

// The single-call shape most tests need: one session, one binding invocation.
const callOnce = (method = 'health', args: unknown[] = []) => {
  return withTapSession({ projectRoot: PROJECT }, (session) => session.call(method, args))
}

const staleError = () => new Error('Could not find object with given id')

const expectCode = async (promise: Promise<any>, code: string) => {
  const err = await promise.catch((e) => e)

  expect(err).toBeInstanceOf(TapTransportError)
  expect(err.code).toBe(code)

  return err
}

describe('lib/tap/tap-session', () => {
  beforeEach(() => {
    vi.mocked(findReadyRunner).mockReset()
    mockConnect.mockReset()
  })

  it('discovers, connects to the browser ws, attaches a session, invokes the binding, and returns the decoded result', async () => {
    const { record, client } = discover()

    const result = await withTapSession({ projectRoot: PROJECT, instance: 1234 }, async (session) => {
      expect(session.record).toBe(record)

      return session.call('health')
    })

    expect(result).toBe('ok')
    expect(findReadyRunner).toHaveBeenCalledWith(PROJECT, { instance: 1234 })
    // Connected straight to the stored browser ws URL — no HTTP discovery.
    expect(mockConnect).toHaveBeenCalledWith({ target: BROWSER_WS_URL })

    // Once to probe the page for the binding, once to acquire the call handle.
    expect(client.Runtime.evaluate).toHaveBeenCalledTimes(2)
    expect(client.Runtime.evaluate.mock.calls[0][0]).toEqual({ expression: 'window.__CYPRESS_TAP_BINDING__' })
    expect(client.Runtime.evaluate.mock.calls[0][1]).toBe('SID1')
    expect(client.Runtime.evaluate.mock.calls[1][0]).toEqual({ expression: 'window.__CYPRESS_TAP_BINDING__' })

    expect(client.Target.attachToTarget).toHaveBeenCalledWith({ targetId: 'T1', flatten: true })

    expect(client.Runtime.callFunctionOn).toHaveBeenCalledOnce()
    expect(client.Runtime.callFunctionOn.mock.calls[0][0]).toEqual({
      objectId: 'OBJ1',
      functionDeclaration: 'function (...a) { return this.health(...a) }',
      arguments: [],
      returnByValue: true,
      awaitPromise: true,
    })

    expect(client.Runtime.callFunctionOn.mock.calls[0][1]).toBe('SID1')

    // Always closes the connection.
    expect(client.close).toHaveBeenCalledOnce()
  })

  it('serves multiple calls over one connection (the getSchema handshake + the command)', async () => {
    const callFunctionOn = vi.fn()
    .mockResolvedValueOnce({ result: { type: 'object', value: { protocolVersion: 1, commands: [] } } })
    .mockResolvedValueOnce({ result: { type: 'string', value: 'ok' } })

    const { client } = discover(makeClient({ callFunctionOn }))

    const results = await withTapSession({ projectRoot: PROJECT }, async (session) => {
      return [await session.call('getSchema'), await session.call('health')]
    })

    expect(results).toEqual([{ protocolVersion: 1, commands: [] }, 'ok'])

    // One discovery, one connection, one page attach — calls share the session.
    expect(findReadyRunner).toHaveBeenCalledOnce()
    expect(mockConnect).toHaveBeenCalledOnce()
    expect(client.Target.attachToTarget).toHaveBeenCalledOnce()

    expect(client.Runtime.callFunctionOn.mock.calls[0][0].functionDeclaration).toContain('this.getSchema')
    expect(client.Runtime.callFunctionOn.mock.calls[1][0].functionDeclaration).toContain('this.health')

    expect(client.close).toHaveBeenCalledOnce()
  })

  it('rejects method names that are not plain identifiers before any CDP call', async () => {
    const { client } = discover()

    await expectCode(callOnce('health(); window.x'), 'INVALID_METHOD')
    await expectCode(callOnce('a.b'), 'INVALID_METHOD')
    await expectCode(callOnce(''), 'INVALID_METHOD')

    // The trampoline template was never built from hostile input.
    expect(client.Runtime.callFunctionOn).not.toHaveBeenCalled()
  })

  it('closes the connection even when fn itself throws', async () => {
    const { client } = discover()
    const boom = new Error('boom')

    const err = await withTapSession({ projectRoot: PROJECT }, async () => {
      throw boom
    }).catch((e) => e)

    expect(err).toBe(boom)
    expect(client.close).toHaveBeenCalledOnce()
  })

  it('re-acquires the binding and retries once on a stale handle', async () => {
    const evaluate = vi.fn()
    .mockResolvedValueOnce({ result: { type: 'object', objectId: 'OBJ_PROBE' } })
    .mockResolvedValueOnce({ result: { type: 'object', objectId: 'OBJ1' } })
    .mockResolvedValueOnce({ result: { type: 'object', objectId: 'OBJ2' } })

    const callFunctionOn = vi.fn()
    .mockRejectedValueOnce(staleError())
    .mockResolvedValueOnce({ result: { type: 'string', value: 'ok' } })

    const { client } = discover(makeClient({ evaluate, callFunctionOn }))

    expect(await callOnce()).toBe('ok')
    // probe + acquire + re-acquire
    expect(client.Runtime.evaluate).toHaveBeenCalledTimes(3)
    expect(client.Runtime.callFunctionOn).toHaveBeenCalledTimes(2)
    expect(client.Runtime.callFunctionOn.mock.calls[1][0].objectId).toBe('OBJ2')
  })

  it('throws STALE_HANDLE when the handle is still stale after one retry', async () => {
    const evaluate = vi.fn().mockResolvedValue({ result: { type: 'object', objectId: 'OBJ1' } })
    const callFunctionOn = vi.fn().mockRejectedValue(staleError())

    const { client } = discover(makeClient({ evaluate, callFunctionOn }))

    await expectCode(callOnce(), 'STALE_HANDLE')

    // exactly one re-acquire (plus the probe) — no unbounded retry loops
    expect(client.Runtime.evaluate).toHaveBeenCalledTimes(3)
    expect(client.Runtime.callFunctionOn).toHaveBeenCalledTimes(2)
  })

  it('throws BINDING_NOT_FOUND when no page has the binding mounted, detaching from probed pages', async () => {
    const evaluate = vi.fn().mockResolvedValue({ result: { type: 'undefined' } })
    const { client } = discover(makeClient({ evaluate }))

    await expectCode(callOnce(), 'BINDING_NOT_FOUND')
    expect(client.Runtime.callFunctionOn).not.toHaveBeenCalled()
    // the probed page wasn't the runner, so its session was released
    expect(client.Target.detachFromTarget).toHaveBeenCalledWith({ sessionId: 'SID1' })
  })

  it('throws BINDING_THREW when the binding method throws', async () => {
    const callFunctionOn = vi.fn().mockResolvedValue({
      result: { type: 'object', subtype: 'error' },
      exceptionDetails: { text: 'Uncaught (in promise)', exception: { type: 'object', description: 'Error: boom' } },
    })

    discover(makeClient({ callFunctionOn }))

    const err = await expectCode(callOnce(), 'BINDING_THREW')

    expect(err.message).toContain('Error: boom')
  })

  it('finds the runner page at a foreign origin (after a cy.visit origin swap)', async () => {
    // After the first cross-origin cy.visit, the runner is re-served under the
    // AUT's origin — the page URL no longer carries the recorded runnerOrigin.
    const client = makeClient({
      targetInfos: [pageTarget('T1', 'http://localhost:8080/__/#/specs/runner?file=app.cy.ts')],
    })

    discover(client)

    expect(await callOnce()).toBe('ok')
    expect(client.Target.attachToTarget).toHaveBeenCalledWith({ targetId: 'T1', flatten: true })
  })

  it('never attaches to non-page targets', async () => {
    const client = makeClient({
      targetInfos: [
        { targetId: 'T1', type: 'service_worker', url: `${RUNNER_ORIGIN}/sw.js` },
        { targetId: 'T2', type: 'iframe', url: `${RUNNER_ORIGIN}/__cypress/iframes/spec` },
      ],
    })

    discover(client)

    await expectCode(callOnce(), 'BINDING_NOT_FOUND')
    expect(client.Target.attachToTarget).not.toHaveBeenCalled()
  })

  it('skips pages without the binding and attaches to the one that has it', async () => {
    const attachToTarget = vi.fn()
    .mockResolvedValueOnce({ sessionId: 'SID_AUT' })
    .mockResolvedValueOnce({ sessionId: 'SID_RUNNER' })

    const evaluate = vi.fn().mockImplementation(async (_params, sessionId) => {
      return sessionId === 'SID_RUNNER'
        ? { result: { type: 'object', objectId: 'OBJ1' } }
        : { result: { type: 'undefined' } }
    })

    const client = makeClient({
      targetInfos: [
        pageTarget('T_AUT', 'http://localhost:7777/some/other/page'),
        pageTarget('T_RUNNER', 'http://localhost:8080/__/#/specs/runner?file=app.cy.ts'),
      ],
      attachToTarget,
      evaluate,
    })

    discover(client)

    expect(await callOnce()).toBe('ok')
    // the binding call ran against the page that probed positive
    expect(client.Runtime.callFunctionOn.mock.calls[0][1]).toBe('SID_RUNNER')
    // the non-runner page's probe session was released
    expect(client.Target.detachFromTarget).toHaveBeenCalledWith({ sessionId: 'SID_AUT' })
  })

  it('keeps probing when attaching to a candidate page fails', async () => {
    const attachToTarget = vi.fn()
    .mockRejectedValueOnce(new Error('No target with given id found'))
    .mockResolvedValueOnce({ sessionId: 'SID1' })

    const client = makeClient({
      targetInfos: [pageTarget('T_CLOSED'), pageTarget('T_RUNNER')],
      attachToTarget,
    })

    discover(client)

    expect(await callOnce()).toBe('ok')
    expect(client.Target.attachToTarget).toHaveBeenCalledTimes(2)
  })

  it('throws CDP_UNREACHABLE when the browser connection cannot be opened', async () => {
    vi.mocked(findReadyRunner).mockResolvedValue(makeRecord())
    mockConnect.mockRejectedValue(new Error('connect ECONNREFUSED'))

    await expectCode(callOnce(), 'CDP_UNREACHABLE')
  })

  it('throws CDP_UNREACHABLE when listing targets fails', async () => {
    const getTargets = vi.fn().mockRejectedValue(new Error('socket hung up'))

    discover(makeClient({ getTargets }))

    await expectCode(callOnce(), 'CDP_UNREACHABLE')
  })

  it('throws BINDING_NOT_FOUND when every candidate page fails to attach', async () => {
    const attachToTarget = vi.fn().mockRejectedValue(new Error('No target with given id found'))

    discover(makeClient({ attachToTarget }))

    await expectCode(callOnce(), 'BINDING_NOT_FOUND')
  })

  it('throws CDP_UNREACHABLE when the binding call fails with a non-stale error', async () => {
    const callFunctionOn = vi.fn().mockRejectedValue(new Error('socket hung up'))
    const { client } = discover(makeClient({ callFunctionOn }))

    await expectCode(callOnce(), 'CDP_UNREACHABLE')

    // a non-stale error is not retried
    expect(client.Runtime.callFunctionOn).toHaveBeenCalledOnce()
  })

  it('rethrows discovery errors untouched', async () => {
    const discoveryErr = new RunnerDiscoveryError('NO_DISCOVERY_FILE', 'No running Cypress was found.')

    vi.mocked(findReadyRunner).mockRejectedValue(discoveryErr)

    const err = await callOnce().catch((e) => e)

    expect(err).toBe(discoveryErr)
    expect(err).toBeInstanceOf(RunnerDiscoveryError)
    expect(err.code).toBe('NO_DISCOVERY_FILE')
    // never reached the transport
    expect(mockConnect).not.toHaveBeenCalled()
  })

  it('attaches to the first page that probes positive when multiple pages have the binding', async () => {
    const client = makeClient({
      targetInfos: [pageTarget('T1'), pageTarget('T2')],
    })

    discover(client)

    expect(await callOnce()).toBe('ok')
    expect(client.Target.attachToTarget).toHaveBeenCalledOnce()
    expect(client.Target.attachToTarget).toHaveBeenCalledWith({ targetId: 'T1', flatten: true })
  })
})
