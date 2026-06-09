import { beforeEach, describe, expect, it, vi } from 'vitest'
import CRI from 'chrome-remote-interface'

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

// A fake CRI client with healthy defaults: one matching runner page, a flat
// session, an objectId from evaluate, and a 'ok' from callFunctionOn.
const makeClient = (overrides: FakeClientOverrides = {}) => {
  const client = {
    Target: {
      getTargets: overrides.getTargets ?? vi.fn().mockResolvedValue({ targetInfos: overrides.targetInfos ?? [pageTarget()] }),
      attachToTarget: overrides.attachToTarget ?? vi.fn().mockResolvedValue({ sessionId: 'SID1' }),
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
    runnerOrigin: RUNNER_ORIGIN,
    cdpStatus: 'ready',
    cdpHost: '127.0.0.1',
    cdpPort: 9999,
    cdpBrowserWsUrl: BROWSER_WS_URL,
    createdAt: 1700000000000,
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

const staleError = () => new Error('Could not find object with given id')

const expectCode = async (promise: Promise<any>, code: string) => {
  const err = await promise.catch((e) => e)

  expect(err).toBeInstanceOf(TapTransportError)
  expect(err.code).toBe(code)

  return err
}

describe('lib/tap/run-tap-command', () => {
  beforeEach(() => {
    vi.mocked(findReadyRunner).mockReset()
    mockConnect.mockReset()
  })

  it('discovers, connects to the browser ws, attaches a session, invokes the binding, and hands the result to handle', async () => {
    const { record, client } = discover()
    const handle = vi.fn()

    await runTapCommand({ projectRoot: PROJECT, instance: 1234 }, 'getHealth', [], handle)

    expect(findReadyRunner).toHaveBeenCalledWith(PROJECT, { instance: 1234 })
    // Connected straight to the stored browser ws URL — no HTTP discovery.
    expect(mockConnect).toHaveBeenCalledWith({ target: BROWSER_WS_URL })
    expect(handle).toHaveBeenCalledWith('ok', { record })

    expect(client.Runtime.evaluate).toHaveBeenCalledOnce()
    expect(client.Runtime.evaluate.mock.calls[0][0]).toEqual({ expression: 'window.__CYPRESS_TAP_BINDING__' })
    expect(client.Runtime.evaluate.mock.calls[0][1]).toBe('SID1')

    expect(client.Target.attachToTarget).toHaveBeenCalledWith({ targetId: 'T1', flatten: true })

    expect(client.Runtime.callFunctionOn).toHaveBeenCalledOnce()
    expect(client.Runtime.callFunctionOn.mock.calls[0][0]).toEqual({
      objectId: 'OBJ1',
      functionDeclaration: 'function (...a) { return this.getHealth(...a) }',
      arguments: [],
      returnByValue: true,
      awaitPromise: true,
    })

    expect(client.Runtime.callFunctionOn.mock.calls[0][1]).toBe('SID1')

    // Always closes the connection.
    expect(client.close).toHaveBeenCalledOnce()
  })

  it('re-acquires the binding and retries once on a stale handle', async () => {
    const evaluate = vi.fn()
    .mockResolvedValueOnce({ result: { type: 'object', objectId: 'OBJ1' } })
    .mockResolvedValueOnce({ result: { type: 'object', objectId: 'OBJ2' } })

    const callFunctionOn = vi.fn()
    .mockRejectedValueOnce(staleError())
    .mockResolvedValueOnce({ result: { type: 'string', value: 'ok' } })

    const { client } = discover(makeClient({ evaluate, callFunctionOn }))
    const handle = vi.fn()

    await runTapCommand({ projectRoot: PROJECT }, 'getHealth', [], handle)

    expect(handle).toHaveBeenCalledWith('ok', expect.anything())
    expect(client.Runtime.evaluate).toHaveBeenCalledTimes(2)
    expect(client.Runtime.callFunctionOn).toHaveBeenCalledTimes(2)
    expect(client.Runtime.callFunctionOn.mock.calls[1][0].objectId).toBe('OBJ2')
  })

  it('throws STALE_HANDLE when the handle is still stale after one retry', async () => {
    const evaluate = vi.fn().mockResolvedValue({ result: { type: 'object', objectId: 'OBJ1' } })
    const callFunctionOn = vi.fn().mockRejectedValue(staleError())

    const { client } = discover(makeClient({ evaluate, callFunctionOn }))

    await expectCode(runTapCommand({ projectRoot: PROJECT }, 'getHealth', [], vi.fn()), 'STALE_HANDLE')

    // exactly one re-acquire — no unbounded retry loops
    expect(client.Runtime.evaluate).toHaveBeenCalledTimes(2)
    expect(client.Runtime.callFunctionOn).toHaveBeenCalledTimes(2)
  })

  it('throws BINDING_NOT_FOUND when the binding is not mounted', async () => {
    const evaluate = vi.fn().mockResolvedValue({ result: { type: 'undefined' } })
    const { client } = discover(makeClient({ evaluate }))

    await expectCode(runTapCommand({ projectRoot: PROJECT }, 'getHealth', [], vi.fn()), 'BINDING_NOT_FOUND')
    expect(client.Runtime.callFunctionOn).not.toHaveBeenCalled()
  })

  it('throws BINDING_THREW when the binding method throws', async () => {
    const callFunctionOn = vi.fn().mockResolvedValue({
      result: { type: 'object', subtype: 'error' },
      exceptionDetails: { text: 'Uncaught (in promise)', exception: { type: 'object', description: 'Error: boom' } },
    })

    discover(makeClient({ callFunctionOn }))

    const err = await expectCode(runTapCommand({ projectRoot: PROJECT }, 'getHealth', [], vi.fn()), 'BINDING_THREW')

    expect(err.message).toContain('Error: boom')
  })

  it('throws RUNNER_PAGE_NOT_FOUND when no page target matches the runner origin', async () => {
    const client = makeClient({
      targetInfos: [
        // right origin, wrong type
        { targetId: 'T1', type: 'service_worker', url: `${RUNNER_ORIGIN}/sw.js` },
        // page, wrong origin
        { targetId: 'T2', type: 'page', url: 'http://localhost:7777/other' },
      ],
    })

    discover(client)

    await expectCode(runTapCommand({ projectRoot: PROJECT }, 'getHealth', [], vi.fn()), 'RUNNER_PAGE_NOT_FOUND')
    expect(client.Target.attachToTarget).not.toHaveBeenCalled()
  })

  it('throws CDP_UNREACHABLE when the browser connection cannot be opened', async () => {
    vi.mocked(findReadyRunner).mockResolvedValue(makeRecord())
    mockConnect.mockRejectedValue(new Error('connect ECONNREFUSED'))

    await expectCode(runTapCommand({ projectRoot: PROJECT }, 'getHealth', [], vi.fn()), 'CDP_UNREACHABLE')
  })

  it('throws CDP_UNREACHABLE when listing targets fails', async () => {
    const getTargets = vi.fn().mockRejectedValue(new Error('socket hung up'))

    discover(makeClient({ getTargets }))

    await expectCode(runTapCommand({ projectRoot: PROJECT }, 'getHealth', [], vi.fn()), 'CDP_UNREACHABLE')
  })

  it('throws CDP_UNREACHABLE when attaching to the runner page fails', async () => {
    const attachToTarget = vi.fn().mockRejectedValue(new Error('No target with given id found'))

    discover(makeClient({ attachToTarget }))

    await expectCode(runTapCommand({ projectRoot: PROJECT }, 'getHealth', [], vi.fn()), 'CDP_UNREACHABLE')
  })

  it('throws CDP_UNREACHABLE when the binding call fails with a non-stale error', async () => {
    const callFunctionOn = vi.fn().mockRejectedValue(new Error('socket hung up'))
    const { client } = discover(makeClient({ callFunctionOn }))

    await expectCode(runTapCommand({ projectRoot: PROJECT }, 'getHealth', [], vi.fn()), 'CDP_UNREACHABLE')

    // a non-stale error is not retried
    expect(client.Runtime.callFunctionOn).toHaveBeenCalledOnce()
  })

  it('rethrows discovery errors untouched', async () => {
    const discoveryErr = new RunnerDiscoveryError('NO_DISCOVERY_FILE', 'No running Cypress was found.')

    vi.mocked(findReadyRunner).mockRejectedValue(discoveryErr)

    const err = await runTapCommand({ projectRoot: PROJECT }, 'getHealth', [], vi.fn()).catch((e) => e)

    expect(err).toBe(discoveryErr)
    expect(err).toBeInstanceOf(RunnerDiscoveryError)
    expect(err.code).toBe('NO_DISCOVERY_FILE')
    // never reached the transport
    expect(mockConnect).not.toHaveBeenCalled()
  })

  it('attaches to the first page target when multiple match the runner origin', async () => {
    const client = makeClient({
      targetInfos: [pageTarget('T1'), pageTarget('T2')],
    })

    discover(client)

    const handle = vi.fn()

    await runTapCommand({ projectRoot: PROJECT }, 'getHealth', [], handle)

    expect(handle).toHaveBeenCalledWith('ok', expect.anything())
    expect(client.Target.attachToTarget).toHaveBeenCalledWith({ targetId: 'T1', flatten: true })
  })
})
