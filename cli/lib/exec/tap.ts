import path from 'path'
import Debug from 'debug'

import logger from '../logger'
import { RunnerDiscoveryError } from '../runner-discovery'
import { withTapSession, TapTransportError } from '../tap/tap-session'
import { TAP_BINDING_GLOBAL, TAP_EXEC_METHOD, TAP_PROTOCOL_VERSION, TAP_SCHEMA_METHOD } from '../tap/contract'
import type { TapCommandSchema, TapExecResult, TapSchema } from '../tap/contract'

const debug = Debug('cypress:cli:tap')

interface TapCliOptions {
  project?: string
  instance?: number
  json?: boolean
}

const isTapError = (err: unknown): err is RunnerDiscoveryError | TapTransportError => {
  return err instanceof RunnerDiscoveryError || err instanceof TapTransportError
}

const renderFailure = (err: { code: string, message: string }, json: boolean): void => {
  if (json) {
    logger.always(JSON.stringify({ error: err.code, message: err.message }))

    return
  }

  logger.error(`${err.code}: ${err.message}`)
}

/**
 * Shape-check what arrived over the wire before trusting it. The schema is
 * half of the handshake the CLI hardcodes, so an unrecognizable or
 * future-versioned schema is a transport-level failure, not a domain result.
 */
const validateSchema = (value: unknown): TapSchema => {
  const schema = value as TapSchema | null | undefined

  if (!schema || typeof schema !== 'object' || typeof schema.protocolVersion !== 'number' || !Array.isArray(schema.commands)) {
    throw new TapTransportError(
      'INVALID_SCHEMA',
      `window.${TAP_BINDING_GLOBAL}.${TAP_SCHEMA_METHOD} returned an unrecognizable schema. The running Cypress version may not support \`cypress tap\`.`,
    )
  }

  if (schema.protocolVersion !== TAP_PROTOCOL_VERSION) {
    throw new TapTransportError(
      'UNSUPPORTED_PROTOCOL',
      `The running Cypress (v${schema.cypressVersion}) speaks tap protocol ${schema.protocolVersion}, but this CLI only understands ${TAP_PROTOCOL_VERSION}. Update whichever side is older and try again.`,
    )
  }

  return schema
}

/**
 * Shape-check the `exec` envelope — the other half of the hardcoded
 * handshake. Anything that is not the envelope is a transport-level failure.
 */
const validateExecResult = (value: unknown): TapExecResult => {
  const outcome = value as TapExecResult | null | undefined

  if (!outcome || typeof outcome !== 'object' || typeof outcome.ok !== 'boolean') {
    throw new TapTransportError(
      'INVALID_EXEC_RESULT',
      `window.${TAP_BINDING_GLOBAL}.${TAP_EXEC_METHOD} returned an unrecognizable result. The running Cypress version may not support \`cypress tap\`.`,
    )
  }

  return outcome
}

const renderResult = (result: unknown, json: boolean): void => {
  if (json) {
    // The raw command result as compact JSON — nothing wraps it, so the output
    // can be piped straight into `jq` or parsed as-is.
    logger.always(JSON.stringify(result))

    return
  }

  // Scalar results print bare (health prints `ok`); structured results print
  // as readable (pretty) JSON. Wire-format consumers should pass --json instead.
  logger.always(typeof result === 'string' ? result : JSON.stringify(result, null, 2))
}

// How a command is written on the CLI, derived from its schema entry —
// e.g. `run <spec>` for one required param, `foo <bar> [baz]` with an
// optional second.
const signatureOf = ({ name, params }: TapCommandSchema): string => {
  return [name, ...params.map(({ name: param, required }) => required ? `<${param}>` : `[${param}]`)].join(' ')
}

const renderCommandList = (schema: TapSchema, json: boolean): void => {
  if (json) {
    // The raw schema — same no-envelope convention as a command result.
    logger.always(JSON.stringify(schema))

    return
  }

  const signatures = schema.commands.map(signatureOf)
  const width = Math.max(...signatures.map((signature) => signature.length))

  logger.always(`Commands available from the running Cypress (v${schema.cypressVersion}):`)
  logger.always()

  schema.commands.forEach(({ description }, index) => {
    logger.always(`  ${signatures[index].padEnd(width)}  ${description}`)
  })

  logger.always()
  logger.always('Usage: cypress tap <command> [args...] [--project <project-path>] [--instance <pid>] [--json]')
}

const tapModule = {
  /**
   * Run one tap invocation: open a session against the running Cypress, fetch
   * its command schema (the `getSchema` handshake), then hand `command` and
   * its raw string args to the binding's `exec` — validation and type
   * coercion happen app-side against the registry's param schema, so the CLI
   * forwards positionals without interpreting them. With no `command`, lists
   * the commands the running instance advertises.
   */
  async start (command: string | undefined, commandArgs: string[] = [], options: TapCliOptions = {}): Promise<number> {
    debug('tap command %s with args %o and options %o', command, commandArgs, options)

    const projectRoot = path.resolve(options.project || process.cwd())
    const json = !!options.json

    try {
      return await withTapSession({ projectRoot, instance: options.instance }, async (session) => {
        const schema = validateSchema(await session.call(TAP_SCHEMA_METHOD))

        if (!command) {
          renderCommandList(schema, json)

          return 1
        }

        const outcome = validateExecResult(await session.call(TAP_EXEC_METHOD, [command, commandArgs]))

        if (!outcome.ok) {
          renderFailure(outcome, json)

          return 1
        }

        renderResult(outcome.result, json)

        return 0
      })
    } catch (err: any) {
      if (!isTapError(err)) {
        throw err
      }

      debug('tap %s failed: %s %s', command || '(list)', err.code, err.message)
      renderFailure(err, json)

      return 1
    }
  },
}

export default tapModule
