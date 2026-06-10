import { TapManager } from '../tap-manager'
import { tapRunnerSource } from './tests'

const CYPRESS_VERSION = '15.0.0'

describe('tap/commands/tests', () => {
  // The serialized tests getTestsState returns carry far more than the
  // lean entry fields — the fixture includes the extras to prove the
  // handler strips them (notably `retries`, the configured max, which the
  // output field of the same name must NOT carry).
  const TESTS_STATE = {
    r2: {
      id: 'r2',
      title: 'logs in',
      duration: 120,
      state: 'passed',
      retries: 2,
      currentRetry: 1,
      body: 'function () {}',
      timings: { lifecycle: 30 },
      prevAttempts: [{ id: 'r2', state: 'failed' }],
    },
    r3: {
      id: 'r3',
      title: 'logs out',
      retries: 2,
      currentRetry: 0,
      body: 'function () {}',
    },
  }

  // The spec window's own `window.Cypress` is the instance running this
  // test, so every test stubs the runner seam instead of replacing it.
  const stubRunner = (runner: unknown) => cy.stub(tapRunnerSource, 'getRunner').returns(runner)

  it('returns noRun when no spec has mounted a runner yet', async () => {
    stubRunner(undefined)

    const manager = new TapManager(CYPRESS_VERSION)

    const outcome = await manager.exec('tests')

    expect(outcome).to.deep.eq({
      ok: true,
      result: { status: 'noRun', message: 'no spec has been run yet — use the run command to run a spec first' },
    })
  })

  it('serializes every test via the __never__ sentinel, keeping only the lean entry fields', async () => {
    const getTestsState = cy.stub().returns(TESTS_STATE)

    stubRunner({ getTestsState })

    const manager = new TapManager(CYPRESS_VERSION)

    const outcome = await manager.exec('tests')

    expect(getTestsState).to.have.been.calledOnceWith('__never__')

    expect(outcome).to.deep.eq({
      ok: true,
      result: {
        status: 'collected',
        tests: [
          { id: 'r2', title: 'logs in', duration: 120, state: 'passed', retries: 1 },
          { id: 'r3', title: 'logs out', retries: 0, state: 'pending' },
        ],
      },
    })
  })

  it('omits duration and retries of a test that has not run, defaults its state to pending, and round-trips through JSON', async () => {
    stubRunner({ getTestsState: () => ({ r2: { id: 'r2', title: 'logs in' } }) })

    const manager = new TapManager(CYPRESS_VERSION)

    const outcome = await manager.exec('tests')

    expect(outcome).to.deep.eq({
      ok: true,
      result: { status: 'collected', tests: [{ id: 'r2', title: 'logs in', state: 'pending' }] },
    })

    expect(Object.keys((outcome as { result: { tests: object[] } }).result.tests[0])).to.deep.eq(['id', 'title', 'state'])
    expect(JSON.parse(JSON.stringify(outcome))).to.deep.eq(outcome)
  })

  it('fails dispatch without reading the runner when positionals are given', async () => {
    const getRunner = stubRunner({ getTestsState: () => ({}) })

    const manager = new TapManager(CYPRESS_VERSION)

    const outcome = await manager.exec('tests', ['extra'])

    expect(outcome).to.deep.include({ ok: false, code: 'INVALID_ARGUMENTS' })
    expect(getRunner).not.to.have.been.called
  })
})
