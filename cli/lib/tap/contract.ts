/**
 * Mirror of `@packages/app`'s `src/runner/tap/contract.ts`. The `cypress` CLI
 * is published separately and cannot import app code at runtime, so the shapes
 * are duplicated here (the same convention `cli/lib/runner-discovery.ts` uses
 * for `RunnerDiscoveryRecord`); they are the cross-process wire contract.
 *
 * Every value MUST round-trip through JSON cleanly: the CLI invokes binding
 * methods over CDP `Runtime.callFunctionOn` with `returnByValue: true` +
 * `awaitPromise: true`, which serializes arguments and return values. Domain
 * failures are returned values (discriminated unions), never thrown — a thrown
 * error is treated as a binding bug.
 */

export type HealthResult = 'ok'

/**
 * Mirror of the callable surface mounted at `window.__CYPRESS_TAP_BINDING__`
 * (`@packages/app`'s `src/runner/tap/tap-manager.ts`). One method per
 * `cypress tap` subcommand; every method is async and takes/returns only
 * JSON-serializable values.
 */
export interface TapBindingContract {
  getHealth (): Promise<HealthResult>
}

/** The runner-window global the binding is mounted on. */
export const TAP_BINDING_GLOBAL = '__CYPRESS_TAP_BINDING__'
