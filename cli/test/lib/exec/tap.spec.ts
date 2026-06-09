import { beforeEach, describe, expect, it, vi } from 'vitest'
import path from 'path'

import logger from '../../../lib/logger'
import { RunnerDiscoveryError } from '../../../lib/runner-discovery'
import { runTapCommand, TapTransportError } from '../../../lib/tap/run-tap-command'
import tap from '../../../lib/exec/tap'

vi.mock('../../../lib/tap/run-tap-command', async (importActual) => {
  const actual = await importActual<typeof import('../../../lib/tap/run-tap-command')>()

  return {
    ...actual,
    runTapCommand: vi.fn(),
  }
})

const record = {
  schemaVersion: 1,
  pid: 1234,
  cypressVersion: '15.0.0',
  projectRoot: '/projects/app',
  runnerOrigin: 'http://localhost:5555',
  cdpStatus: 'ready' as const,
  cdpHost: '127.0.0.1',
  cdpPort: 9222,
  createdAt: 1700000000000,
}

const resolveHealth = (result: any = 'ok') => {
  vi.mocked(runTapCommand).mockImplementation(async (options, method, args, handle) => {
    handle(result as any, { record })
  })
}

describe('lib/exec/tap', () => {
  beforeEach(() => {
    vi.mocked(runTapCommand).mockReset()
    logger.reset()
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  describe('health', () => {
    it('prints the health result and exits 0', async () => {
      resolveHealth()

      expect(await tap.start('health', {})).toBe(0)
      expect(logger.print()).toBe('ok')
    })

    it('prints a single JSON object with --json', async () => {
      resolveHealth()

      expect(await tap.start('health', { json: true })).toBe(0)
      expect(JSON.parse(logger.print())).toEqual({ ok: true, health: 'ok' })
    })

    it('invokes getHealth with no arguments against the resolved project root', async () => {
      resolveHealth()

      await tap.start('health', { project: 'some/relative/dir', instance: 1234 })

      expect(runTapCommand).toHaveBeenCalledWith(
        { projectRoot: path.resolve('some/relative/dir'), instance: 1234 },
        'getHealth',
        [],
        expect.any(Function),
      )
    })

    it('defaults the project root to the cwd', async () => {
      resolveHealth()

      await tap.start('health', {})

      expect(vi.mocked(runTapCommand).mock.calls[0][0]).toEqual({ projectRoot: process.cwd(), instance: undefined })
    })

    it('renders discovery errors with their code and exits 1', async () => {
      vi.mocked(runTapCommand).mockRejectedValue(
        new RunnerDiscoveryError('NO_DISCOVERY_FILE', 'No running Cypress was found for /projects/app.'),
      )

      expect(await tap.start('health', {})).toBe(1)
      expect(logger.print()).toBe('NO_DISCOVERY_FILE: No running Cypress was found for /projects/app.')
    })

    it('renders transport errors with their code and exits 1', async () => {
      vi.mocked(runTapCommand).mockRejectedValue(
        new TapTransportError('BINDING_NOT_FOUND', 'Found the Cypress runner page, but the binding is not mounted.'),
      )

      expect(await tap.start('health', {})).toBe(1)
      expect(logger.print()).toBe('BINDING_NOT_FOUND: Found the Cypress runner page, but the binding is not mounted.')
    })

    it('renders typed failures as JSON on stdout with --json and exits 1', async () => {
      vi.mocked(runTapCommand).mockRejectedValue(
        new TapTransportError('CDP_UNREACHABLE', 'Could not reach the browser.'),
      )

      expect(await tap.start('health', { json: true })).toBe(1)
      expect(JSON.parse(logger.print())).toEqual({
        ok: false,
        error: 'CDP_UNREACHABLE',
        message: 'Could not reach the browser.',
      })
    })

    it('rethrows unexpected errors for the generic CLI error path', async () => {
      const unexpected = new Error('boom')

      vi.mocked(runTapCommand).mockRejectedValue(unexpected)

      await expect(tap.start('health', {})).rejects.toBe(unexpected)
    })
  })

  describe('start', () => {
    it('lists health as a known command', () => {
      expect(tap.commands).toEqual(['health'])
    })

    it('rejects unknown commands', async () => {
      await expect(tap.start('bogus', {})).rejects.toThrow('Unknown tap command "bogus"')
    })
  })
})
