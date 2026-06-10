import type { SerializedTest } from '@packages/types'

import type { TapCommandDefinition } from './definition'

/**
 * One test of the active run, trimmed to the fields a tap caller needs to
 * follow run progress. `duration` and `retries` are absent (never `null` —
 * JSON drops `undefined` keys at the CDP boundary) until the test has run;
 * `state` defaults to `'pending'` until then.
 */
export interface TestStateEntry {
  id: string
  title: string
  /** Milliseconds the latest attempt took. */
  duration?: number
  state: string
  /** Retries actually taken this run, not the configured maximum. */
  retries?: number
}

/**
 * Result of the `tests` command. `noRun` means the runner has no test state
 * to read — no spec has been run (or one is mid-teardown).
 */
export type TestsResult =
  | { status: 'collected', tests: TestStateEntry[] }
  | { status: 'noRun', message: string }

/**
 * The slice of the driver's `Cypress.runner` the `tests` command consumes.
 * `getTestsState(testId)` serializes the run's tests up to (excluding) the
 * one whose id matches, so a never-matching sentinel yields every test.
 */
interface TapTestsRunner {
  getTestsState (testId?: string): Record<string, SerializedTest>
}

/**
 * Seam over the driver runner the `tests` command reads. Component tests
 * stub this — the real lookup reaches the Cypress instance running the test.
 *
 * The instance comes from the event manager rather than `window.Cypress`:
 * when the runner page is itself an AUT (the cypress-in-cypress harness),
 * `window.Cypress` is the OUTER driver injected into it, while the event
 * manager only ever holds this app's own instance.
 */
export const tapRunnerSource = {
  getRunner (): TapTestsRunner | undefined {
    try {
      // getEventManager throws until the unified runner page initializes it,
      // and getCypress() is undefined until a spec is set up — both mean
      // there is no run to read yet.
      return window.getEventManager?.().getCypress()?.runner
    } catch {
      return undefined
    }
  },
}

export const testsCommand = {
  description: 'list the tests of the active run and their state',
  params: [],
  handler: async (): Promise<TestsResult> => {
    const runner = tapRunnerSource.getRunner()

    if (!runner) {
      return { status: 'noRun', message: 'no spec has been run yet — use the run command to run a spec first' }
    }

    // '__never__' matches no test id, so getTestsState serializes every
    // test of the run instead of stopping at the active one.
    const tests = Object.values(runner.getTestsState('__never__'))

    return {
      status: 'collected',
      // Optional fields are omitted rather than set to undefined so the
      // in-memory result already equals its JSON wire form.
      tests: tests.map(({ id, title, duration, state, currentRetry }): TestStateEntry => {
        return {
          id,
          title,
          ...(duration !== undefined ? { duration } : {}),
          ...(state !== undefined ? { state } : { state: 'pending' }),
          ...(currentRetry !== undefined ? { retries: currentRetry } : {}),
        }
      }),
    }
  },
} satisfies TapCommandDefinition
