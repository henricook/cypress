import type { TapCommandParamSchema } from '../contract'

/**
 * One `cypress tap` subcommand: the metadata `getSchema()` advertises to the
 * CLI plus the handler `exec` dispatches to. Handlers receive args already
 * validated and coerced against `params`, and must take/return only
 * JSON-serializable values per `../contract` — result types live with their
 * command, but the round-trip rule binds them all the same.
 */
export interface TapCommandDefinition {
  description: string
  params: TapCommandParamSchema[]
  handler: (...args: any[]) => Promise<unknown>
}
