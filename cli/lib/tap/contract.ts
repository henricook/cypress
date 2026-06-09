/**
 * The frozen handshake surface for `window.__CYPRESS_TAP_BINDING__`, mirrored
 * type-only from `@packages/app`'s `src/runner/tap/contract.ts` (the same
 * convention `cli/lib/runner-discovery.ts` uses for `RunnerDiscoveryRecord`).
 *
 * This is ALL the CLI hardcodes about the binding: the global name, the two
 * methods (`getSchema` and `exec`), and the shapes they return. Every
 * command — its name, description, and parameters — is discovered at runtime
 * from the schema, and positional arguments are forwarded to `exec` as raw
 * strings: validation and type coercion happen app-side against the
 * registry's param schema, so the CLI never interprets param types and any
 * CLI version can drive any Cypress version; the two only have to agree on
 * the protocol version below.
 *
 * Every value MUST round-trip through JSON cleanly: the CLI invokes binding
 * methods over CDP `Runtime.callFunctionOn` with `returnByValue: true` +
 * `awaitPromise: true`, which serializes arguments and return values.
 * Failures are returned values, never thrown — a thrown error is treated as
 * a binding bug.
 */

/** The runner-window global the binding is mounted on. */
export const TAP_BINDING_GLOBAL = '__CYPRESS_TAP_BINDING__'

/** The schema handshake — one of the two binding methods the CLI hardcodes. */
export const TAP_SCHEMA_METHOD = 'getSchema'

/** The dispatch entry point — the other hardcoded binding method. */
export const TAP_EXEC_METHOD = 'exec'

/**
 * The schema-format version this CLI understands. The binding bumps it ONLY
 * when the shapes below change incompatibly — adding commands or params never
 * requires a bump.
 */
export const TAP_PROTOCOL_VERSION = 1

export interface TapCommandParamSchema {
  name: string
  type: 'string' | 'number' | 'boolean'
  required: boolean
  description: string
}

export interface TapCommandSchema {
  /** The CLI subcommand name AND the `exec` command name — one name, no mapping. */
  name: string
  description: string
  params: TapCommandParamSchema[]
}

export interface TapSchema {
  protocolVersion: number
  cypressVersion: string
  commands: TapCommandSchema[]
}

/**
 * The wire envelope `exec` resolves with. `ok: false` covers dispatch-level
 * failures only (unknown command, positionals that do not satisfy the param
 * schema) — the CLI unwraps the envelope, so command results stay
 * envelope-free on stdout. Domain failures are values inside `ok: true`
 * results, shaped by each command.
 */
export type TapExecResult =
  | { ok: true, result: unknown }
  | { ok: false, code: string, message: string }
