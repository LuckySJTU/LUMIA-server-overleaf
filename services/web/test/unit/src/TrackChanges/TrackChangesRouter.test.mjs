import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('TrackChangesRouter', () => {
  let settings, authorization, controller, router, webRouter

  beforeEach(async () => {
    vi.resetModules()
    settings = { enableComments: true, moduleImportSequence: [] }
    authorization = {
      blockRestrictedUserFromProject: vi.fn(),
      ensureUserCanReadProject: vi.fn(),
      ensureUserCanWriteProjectContent: vi.fn(),
    }
    controller = {
      setState: vi.fn(),
      getRanges: vi.fn(),
      acceptChanges: vi.fn(),
      getUsers: vi.fn(),
    }
    webRouter = { post: vi.fn(), get: vi.fn() }
    vi.doMock('@overleaf/settings', () => ({ default: settings }))
    vi.doMock(
      '../../../../app/src/Features/Authorization/AuthorizationMiddleware.mjs',
      () => ({ default: authorization })
    )
    vi.doMock(
      '../../../../app/src/Features/TrackChanges/TrackChangesController.mjs',
      () => ({ default: controller })
    )
    router = (
      await import(
        '../../../../app/src/Features/TrackChanges/TrackChangesRouter.mjs'
      )
    ).default
  })

  it('guards mode switches and accept operations with content write access', () => {
    router.apply(webRouter)
    expect(webRouter.post).toHaveBeenCalledWith(
      '/project/:Project_id/track_changes',
      authorization.blockRestrictedUserFromProject,
      authorization.ensureUserCanWriteProjectContent,
      controller.setState
    )
    expect(webRouter.post).toHaveBeenCalledWith(
      '/project/:Project_id/doc/:doc_id/changes/accept',
      authorization.blockRestrictedUserFromProject,
      authorization.ensureUserCanWriteProjectContent,
      controller.acceptChanges
    )
  })

  it('only exposes ranges to authorized non-restricted project readers', () => {
    router.apply(webRouter)
    expect(webRouter.get).toHaveBeenCalledWith(
      '/project/:Project_id/changes/users',
      authorization.blockRestrictedUserFromProject,
      authorization.ensureUserCanReadProject,
      controller.getUsers
    )
    expect(webRouter.get).toHaveBeenCalledWith(
      '/project/:Project_id/ranges',
      authorization.blockRestrictedUserFromProject,
      authorization.ensureUserCanReadProject,
      controller.getRanges
    )
  })

  it('does not expose the fallback when comments are disabled', () => {
    settings.enableComments = false
    router.apply(webRouter)
    expect(webRouter.post).not.toHaveBeenCalled()
    expect(webRouter.get).not.toHaveBeenCalled()
  })

  it('does not shadow routes provided by an installed track-changes module', () => {
    settings.moduleImportSequence = ['track-changes']
    router.apply(webRouter)
    expect(webRouter.post).not.toHaveBeenCalled()
    expect(webRouter.get).not.toHaveBeenCalled()
  })

  it.each([
    [true, [], true],
    [false, [], false],
    [false, ['track-changes'], true],
  ])(
    'reports consistent availability with comments=%s modules=%j',
    async (comments, modules, expected) => {
      settings.enableComments = comments
      settings.moduleImportSequence = modules
      const features = (
        await import('../../../../app/src/infrastructure/Features.mjs')
      ).default
      expect(features.hasFeature('track-changes')).toBe(expected)
    }
  )
})
