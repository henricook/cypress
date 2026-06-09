import type { FoundSpec } from '@packages/types'

import type { HealthResult, SpecListEntry, TapCommandParamSchema } from './contract'

/**
 * One `cypress tap` subcommand: the metadata `getSchema()` advertises to the
 * CLI plus the handler `exec` dispatches to. Handlers receive args already
 * validated and coerced against `params`, and must take/return only
 * JSON-serializable values per `./contract`.
 */
export interface TapCommandDefinition {
  description: string
  params: TapCommandParamSchema[]
  handler: (...args: any[]) => Promise<unknown>
}

/**
 * The command registry — the single source of truth for the tap binding.
 * `getSchema()` serializes the metadata and `TapManager.exec` dispatches by
 * name, so adding an entry here is the whole job of adding a subcommand.
 */
export const tapCommands = {
  health: {
    description: 'check that a running Cypress instance is reachable and its tap binding responds',
    params: [],
    handler: async (): Promise<HealthResult> => 'ok',
  },
  spec: {
    description: 'list the specs the running Cypress instance can run',
    params: [],
    handler: async (): Promise<SpecListEntry[]> => {
      // The server embeds `ctx.project.specs` in the runner HTML at serve
      // time (HtmlDataSource.replaceBody): a snapshot from the last page
      // load — spec files added or removed since then won't show until the
      // runner reloads. The global is declared as SpecFile[], but the
      // embedded entries carry the full found-spec shape.
      const specs = (window.__RUN_MODE_SPECS__ ?? []) as FoundSpec[]

      return specs.map(({ relative, specType }) => ({ relative, specType }))
    },
  },
} satisfies Record<string, TapCommandDefinition>
