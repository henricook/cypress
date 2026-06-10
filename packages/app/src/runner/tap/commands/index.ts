import type { TapCommandDefinition } from './definition'
import { healthCommand } from './health'
import { runCommand } from './run'
import { specCommand } from './spec'

/**
 * The command registry — the single source of truth for the tap binding.
 * `getSchema()` serializes the metadata and `TapManager.exec` dispatches by
 * name, so adding a subcommand is one sibling module (definition, result
 * types, any seam it needs) plus its entry here.
 */
export const tapCommands = {
  health: healthCommand,
  spec: specCommand,
  run: runCommand,
} satisfies Record<string, TapCommandDefinition>
