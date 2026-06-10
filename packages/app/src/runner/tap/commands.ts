import type { FoundSpec } from '@packages/types'

import { posixify } from '../../paths'
import type { HealthResult, RunResult, SpecListEntry, TapCommandParamSchema } from './contract'

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

// Distinguishes each `run` invocation in the runner URL so rerunning the
// already-active spec still produces a query change (see the `run` handler).
let tapRunNonce = 0

/**
 * Seam over the one side effect `run` performs. Component tests stub this —
 * really navigating there moves the spec frame and stops the test
 * mid-command. The hash setter (rather than `location.href = '#…'`) is what
 * guarantees a synchronous same-document fragment navigation, including when
 * the runner page is itself an AUT (the cypress-in-cypress harness).
 */
export const tapNavigation = {
  setHash (hash: string) {
    window.location.hash = hash
  },
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
  run: {
    description: 'run (or rerun) a spec by its project-relative path',
    params: [
      { name: 'spec', type: 'string', required: true, description: 'project-relative spec path, as listed by the spec command' },
    ],
    handler: async (spec: string): Promise<RunResult> => {
      if (typeof spec !== 'string' || spec.length === 0) {
        return { status: 'invalidSpec', message: 'spec must be a non-empty string (a project-relative spec path)' }
      }

      const specs = (window.__RUN_MODE_SPECS__ ?? []) as FoundSpec[]
      const wanted = posixify(spec)
      const match = specs.find((entry) => posixify(entry.relative) === wanted)

      if (!match) {
        return { status: 'specNotFound', spec, message: 'no spec matches that path — use the spec command to list runnable specs' }
      }

      // The tapRun nonce makes route.query differ from the previous query, so
      // the unifiedRunner watchSpecs effect always kicks off a fresh run —
      // even when this spec is already active (rerun). Hash navigation never
      // reloads the page, so this promise still resolves over CDP. The path
      // travels in posix form because watchSpecs converts route.query.file
      // back via getPathForPlatform.
      const file = encodeURIComponent(posixify(match.relative)).replace(/%2F/g, '/')

      tapNavigation.setHash(`/specs/runner?file=${file}&tapRun=${++tapRunNonce}`)

      return { status: 'started', spec: { relative: match.relative, specType: match.specType } }
    },
  },
} satisfies Record<string, TapCommandDefinition>
