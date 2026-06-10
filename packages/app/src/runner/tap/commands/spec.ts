import type { TapCommandDefinition } from './definition'
import { readRunModeSpecs, toSpecListEntry } from './run-mode-specs'
import type { SpecListEntry } from './run-mode-specs'

export const specCommand = {
  description: 'list the specs the running Cypress instance can run',
  params: [],
  handler: async (): Promise<SpecListEntry[]> => {
    return readRunModeSpecs().map(toSpecListEntry)
  },
} satisfies TapCommandDefinition
