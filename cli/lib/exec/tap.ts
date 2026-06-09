import path from 'path'
import Debug from 'debug'

import logger from '../logger'
import { RunnerDiscoveryError } from '../runner-discovery'
import { runTapCommand, TapTransportError } from '../tap/run-tap-command'

const debug = Debug('cypress:cli:tap')

interface TapCliOptions {
  project?: string
  instance?: number
  json?: boolean
}

const isTapError = (err: unknown): err is RunnerDiscoveryError | TapTransportError => {
  return err instanceof RunnerDiscoveryError || err instanceof TapTransportError
}

const renderFailure = (err: RunnerDiscoveryError | TapTransportError, json: boolean): void => {
  if (json) {
    logger.always(JSON.stringify({ ok: false, error: err.code, message: err.message }))

    return
  }

  logger.error(`${err.code}: ${err.message}`)
}

const health = async (options: TapCliOptions): Promise<number> => {
  const projectRoot = path.resolve(options.project || process.cwd())

  try {
    await runTapCommand({ projectRoot, instance: options.instance }, 'getHealth', [], (result) => {
      if (options.json) {
        logger.always(JSON.stringify({ ok: true, health: result }))
      } else {
        logger.always(result)
      }
    })

    return 0
  } catch (err: any) {
    if (!isTapError(err)) {
      throw err
    }

    debug('tap health failed: %s %s', err.code, err.message)
    renderFailure(err, !!options.json)

    return 1
  }
}

const tapModule = {
  /** The subcommand allowlist `cli.ts` validates against before dispatching. */
  commands: ['health'],

  start (command: string, options: TapCliOptions = {}): Promise<number> {
    debug('tap command %s with options %o', command, options)

    switch (command) {
      case 'health':
        return health(options)
      default:
        // cli.ts validates against `commands` before dispatching; this guards
        // direct programmatic calls.
        return Promise.reject(new Error(`Unknown tap command "${command}"`))
    }
  },
}

export default tapModule
