import { coerceCommandArgs } from './exec-args'
import type { TapCommandParamSchema } from './contract'

describe('tap/exec-args', () => {
  describe('coerceCommandArgs', () => {
    const PARAMS: TapCommandParamSchema[] = [
      { name: 'path', type: 'string', required: true, description: 'a path' },
      { name: 'count', type: 'number', required: false, description: 'how many' },
      { name: 'exact', type: 'boolean', required: false, description: 'exact match' },
    ]

    it('coerces each positional to its declared wire type', () => {
      expect(coerceCommandArgs('probe', PARAMS, ['a/b.ts', '3', 'true'])).to.deep.eq({
        ok: true,
        args: ['a/b.ts', 3, true],
      })
    })

    it('allows optional params to be omitted', () => {
      expect(coerceCommandArgs('probe', PARAMS, ['a/b.ts'])).to.deep.eq({ ok: true, args: ['a/b.ts'] })
    })

    it('rejects missing required params with a usage hint', () => {
      const outcome = coerceCommandArgs('probe', PARAMS, [])

      expect(outcome.ok).to.eq(false)
      expect((outcome as { message: string }).message).to.contain('missing the required <path>')
      expect((outcome as { message: string }).message).to.contain('Usage: cypress tap probe <path> [count] [exact]')
    })

    it('rejects extra positionals', () => {
      const outcome = coerceCommandArgs('probe', PARAMS, ['a', '1', 'true', 'extra'])

      expect(outcome.ok).to.eq(false)
      expect((outcome as { message: string }).message).to.contain('takes 3 argument(s), but 4 were given')
    })

    it('rejects values that do not parse as the declared number type', () => {
      for (const bad of ['abc', '']) {
        const outcome = coerceCommandArgs('probe', PARAMS, ['a', bad])

        expect(outcome.ok, `value "${bad}"`).to.eq(false)
        expect((outcome as { message: string }).message).to.contain('<count> must be a number')
      }
    })

    it('rejects values that are not literal true/false for the boolean type', () => {
      const outcome = coerceCommandArgs('probe', PARAMS, ['a', '1', 'yes'])

      expect(outcome.ok).to.eq(false)
      expect((outcome as { message: string }).message).to.contain('<exact> must be true or false')
    })

    it('rejects non-string wire values', () => {
      const outcome = coerceCommandArgs('probe', PARAMS, [42 as unknown as string])

      expect(outcome.ok).to.eq(false)
      expect((outcome as { message: string }).message).to.contain('<path> must be a string over the wire')
    })
  })
})
