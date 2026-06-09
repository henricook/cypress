import { beforeEach, describe, expect, it, vi } from 'vitest'
import path from 'path'

import logger from '../../../lib/logger'
import { RunnerDiscoveryError } from '../../../lib/runner-discovery'
import { withTapSession, TapTransportError } from '../../../lib/tap/tap-session'
import type { TapExecResult, TapSchema } from '../../../lib/tap/contract'
import tap from '../../../lib/exec/tap'

vi.mock('../../../lib/tap/tap-session', async (importActual) => {
  const actual = await importActual<typeof import('../../../lib/tap/tap-session')>()

  return {
    ...actual,
    withTapSession: vi.fn(),
  }
})

const record = {
  schemaVersion: 2,
  pid: 1234,
  cypressVersion: '15.0.0',
  projectRoot: '/projects/app',
  runnerOrigin: 'http://localhost:5555',
  cdpStatus: 'ready' as const,
  cdpHost: '127.0.0.1',
  cdpPort: 9222,
  cdpBrowserWsUrl: 'ws://127.0.0.1:9222/devtools/browser/abc',
  createdAt: 1700000000000,
}

const schema: TapSchema = {
  protocolVersion: 1,
  cypressVersion: '15.0.0',
  commands: [
    {
      name: 'health',
      description: 'check that a running Cypress instance is reachable and its tap binding responds',
      params: [],
    },
    {
      name: 'run',
      description: 'run (or rerun) a spec by its project-relative path',
      params: [
        { name: 'spec', type: 'string', required: true, description: 'project-relative spec path, as listed by the spec command' },
      ],
    },
  ],
}

/**
 * Stand up a fake session: `getSchema` returns the given schema, `exec`
 * resolves the given envelope. Returns the `call` mock so tests can assert
 * the dispatch sequence and the forwarded args.
 */
const mockSession = (sessionSchema: unknown = schema, execOutcome: unknown = { ok: true, result: 'ok' } satisfies TapExecResult) => {
  const call = vi.fn(async (method: string) => {
    return method === 'getSchema' ? sessionSchema : execOutcome
  })

  vi.mocked(withTapSession).mockImplementation(async (_options, fn) => fn({ record, call }))

  return call
}

describe('lib/exec/tap', () => {
  beforeEach(() => {
    vi.mocked(withTapSession).mockReset()
    logger.reset()
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  describe('dispatching a command', () => {
    it('fetches the schema, hands the command to exec, prints the unwrapped result, and exits 0', async () => {
      const call = mockSession()

      expect(await tap.start('health', [], {})).toBe(0)
      expect(logger.print()).toBe('ok')

      // The handshake always precedes the dispatch, over the same session.
      expect(call.mock.calls).toEqual([
        ['getSchema'],
        ['exec', ['health', []]],
      ])
    })

    it('forwards positional args to exec as raw strings, without interpreting them', async () => {
      const call = mockSession(schema, { ok: true, result: { status: 'started' } })

      expect(await tap.start('run', ['cypress/e2e/a.cy.js'], {})).toBe(0)

      expect(call).toHaveBeenCalledWith('exec', ['run', ['cypress/e2e/a.cy.js']])
    })

    it('prints the raw unwrapped result as JSON with --json (no envelope)', async () => {
      mockSession(schema, { ok: true, result: { status: 'started' } })

      expect(await tap.start('run', ['cypress/e2e/a.cy.js'], { json: true })).toBe(0)
      expect(JSON.parse(logger.print())).toEqual({ status: 'started' })
    })

    it('prints non-string results as readable JSON', async () => {
      mockSession(schema, { ok: true, result: { status: 'ok', browsers: 2 } })

      expect(await tap.start('health', [], {})).toBe(0)
      expect(JSON.parse(logger.print())).toEqual({ status: 'ok', browsers: 2 })
    })

    it('opens the session against the resolved project root', async () => {
      mockSession()

      await tap.start('health', [], { project: 'some/relative/dir', instance: 1234 })

      expect(withTapSession).toHaveBeenCalledWith(
        { projectRoot: path.resolve('some/relative/dir'), instance: 1234 },
        expect.any(Function),
      )
    })

    it('defaults the project root to the cwd', async () => {
      mockSession()

      await tap.start('health', [], {})

      expect(vi.mocked(withTapSession).mock.calls[0][0]).toEqual({ projectRoot: process.cwd(), instance: undefined })
    })

    it('renders the envelope failure when the instance rejects the command name', async () => {
      mockSession(schema, {
        ok: false,
        code: 'UNKNOWN_COMMAND',
        message: '"bogus" is not a command of this Cypress (v15.0.0). Available commands: health, run.',
      })

      expect(await tap.start('bogus', [], {})).toBe(1)
      expect(logger.print()).toBe('UNKNOWN_COMMAND: "bogus" is not a command of this Cypress (v15.0.0). Available commands: health, run.')
    })

    it('renders the envelope failure when the instance rejects the positionals', async () => {
      mockSession(schema, {
        ok: false,
        code: 'INVALID_ARGUMENTS',
        message: '"run" is missing the required <spec> argument(s). Usage: cypress tap run <spec>',
      })

      expect(await tap.start('run', [], {})).toBe(1)
      expect(logger.print()).toContain('INVALID_ARGUMENTS')
      expect(logger.print()).toContain('Usage: cypress tap run <spec>')
    })

    it('renders envelope failures as JSON with --json', async () => {
      mockSession(schema, { ok: false, code: 'UNKNOWN_COMMAND', message: 'no such command' })

      expect(await tap.start('bogus', [], { json: true })).toBe(1)

      expect(JSON.parse(logger.print())).toEqual({
        error: 'UNKNOWN_COMMAND',
        message: 'no such command',
      })
    })

    it('treats an unrecognizable exec result as a transport failure', async () => {
      mockSession(schema, 'not an envelope')

      expect(await tap.start('health', [], {})).toBe(1)
      expect(logger.print()).toContain('INVALID_EXEC_RESULT')
    })
  })

  describe('listing commands', () => {
    it('prints the live command list with param signatures when invoked with no command and exits 1', async () => {
      mockSession()

      expect(await tap.start(undefined, [], {})).toBe(1)
      expect(logger.print()).toContain('Commands available from the running Cypress (v15.0.0):')
      expect(logger.print()).toContain('health')
      expect(logger.print()).toContain('run <spec>')
      expect(logger.print()).toContain(schema.commands[0].description)
      expect(logger.print()).toContain('Usage: cypress tap <command> [args...]')
    })

    it('prints the whole schema with --json', async () => {
      mockSession()

      expect(await tap.start(undefined, [], { json: true })).toBe(1)
      expect(JSON.parse(logger.print())).toEqual(schema)
    })
  })

  describe('the schema handshake', () => {
    it('rejects an unrecognizable schema with INVALID_SCHEMA', async () => {
      mockSession('not a schema')

      expect(await tap.start('health', [], {})).toBe(1)
      expect(logger.print()).toContain('INVALID_SCHEMA')
    })

    it('rejects a future protocol version with UNSUPPORTED_PROTOCOL', async () => {
      mockSession({ ...schema, protocolVersion: 2 })

      expect(await tap.start('health', [], {})).toBe(1)
      expect(logger.print()).toContain('UNSUPPORTED_PROTOCOL')
      expect(logger.print()).toContain('protocol 2')
    })
  })

  describe('failure rendering', () => {
    it('renders discovery errors with their code and exits 1', async () => {
      vi.mocked(withTapSession).mockRejectedValue(
        new RunnerDiscoveryError('NO_DISCOVERY_FILE', 'No running Cypress was found for /projects/app.'),
      )

      expect(await tap.start('health', [], {})).toBe(1)
      expect(logger.print()).toBe('NO_DISCOVERY_FILE: No running Cypress was found for /projects/app.')
    })

    it('renders transport errors with their code and exits 1', async () => {
      vi.mocked(withTapSession).mockRejectedValue(
        new TapTransportError('BINDING_NOT_FOUND', 'Found the Cypress runner page, but the binding is not mounted.'),
      )

      expect(await tap.start('health', [], {})).toBe(1)
      expect(logger.print()).toBe('BINDING_NOT_FOUND: Found the Cypress runner page, but the binding is not mounted.')
    })

    it('renders typed failures as JSON on stdout with --json and exits 1', async () => {
      vi.mocked(withTapSession).mockRejectedValue(
        new TapTransportError('CDP_UNREACHABLE', 'Could not reach the browser.'),
      )

      expect(await tap.start('health', [], { json: true })).toBe(1)
      expect(JSON.parse(logger.print())).toEqual({
        error: 'CDP_UNREACHABLE',
        message: 'Could not reach the browser.',
      })
    })

    it('rethrows unexpected errors for the generic CLI error path', async () => {
      const unexpected = new Error('boom')

      vi.mocked(withTapSession).mockRejectedValue(unexpected)

      await expect(tap.start('health', [], {})).rejects.toBe(unexpected)
    })
  })
})
