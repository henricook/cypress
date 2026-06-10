describe('tap binding', () => {
  it('mounts window.__CYPRESS_TAP_BINDING__ on the runner top window', () => {
    cy.scaffoldProject('cypress-in-cypress')
    cy.openProject('cypress-in-cypress')
    cy.startAppServer('e2e')
    cy.visitApp()
    cy.specsPageIsVisible()

    cy.window().then(async (win) => {
      const binding = win.__CYPRESS_TAP_BINDING__

      if (!binding) {
        throw new Error('"window.__CYPRESS_TAP_BINDING__" is expected to be available')
      }

      expect(await binding.exec('health')).to.deep.eq({ ok: true, result: 'ok' })

      const schema = await binding.getSchema()

      expect(schema.protocolVersion).to.eq(1)
      expect(schema.commands.map((command) => command.name)).to.include.members(['health', 'spec'])

      const unknown = await binding.exec('not-a-command')

      expect(unknown).to.deep.include({ ok: false, code: 'UNKNOWN_COMMAND' })

      const outcome = await binding.exec('spec')

      expect(outcome.ok).to.eq(true)

      const specs = (outcome as { ok: true, result: Array<{ relative: string, specType: string }> }).result

      expect(specs).to.deep.include({ relative: 'cypress/e2e/dom-content.spec.js', specType: 'integration' })

      for (const spec of specs) {
        expect(Object.keys(spec), `entry ${spec.relative}`).to.deep.eq(['relative', 'specType'])
      }
    })
  })

  it('runs and reruns a spec via the run command', () => {
    cy.scaffoldProject('cypress-in-cypress')
    cy.openProject('cypress-in-cypress')
    cy.startAppServer('e2e')
    cy.visitApp()
    cy.specsPageIsVisible()

    const getBinding = (win: Cypress.AUTWindow) => {
      const binding = win.__CYPRESS_TAP_BINDING__

      if (!binding) {
        throw new Error('"window.__CYPRESS_TAP_BINDING__" is expected to be available')
      }

      return binding
    }

    cy.window().then(async (win) => {
      const outcome = await getBinding(win).exec('run', ['cypress/e2e/dom-content.spec.js'])

      expect(outcome).to.deep.eq({
        ok: true,
        result: {
          status: 'started',
          spec: { relative: 'cypress/e2e/dom-content.spec.js', specType: 'integration' },
        },
      })
    })

    // The href change navigates from the specs page to the runner and runs the spec.
    cy.location('hash')
    .should('contain', '/specs/runner?file=cypress/e2e/dom-content.spec.js')
    .and('match', /tapRun=\d+/)

    cy.waitForSpecToFinish({ passCount: 1 })
    cy.contains('Dom Content').should('be.visible')

    // Rerunning the same spec advances the tapRun nonce, so the query change
    // kicks off a fresh run even though the active spec is unchanged.
    cy.location('hash').then((hashBefore) => {
      cy.window().then(async (win) => {
        const outcome = await getBinding(win).exec('run', ['cypress/e2e/dom-content.spec.js'])

        expect(outcome).to.deep.include({ ok: true })
      })

      cy.location('hash').should('not.eq', hashBefore)
      cy.waitForSpecToFinish({ passCount: 1 })
    })

    cy.location('hash').then((hashBefore) => {
      cy.window().then(async (win) => {
        const outcome = await getBinding(win).exec('run', ['cypress/e2e/does-not-exist.cy.js'])

        expect(outcome.ok).to.eq(true)
        expect((outcome as { result: object }).result).to.deep.include({ status: 'specNotFound', spec: 'cypress/e2e/does-not-exist.cy.js' })
      })

      // A domain failure resolves as a value and never navigates.
      cy.location('hash').should('eq', hashBefore)
    })
  })
})
