import Settings from '@overleaf/settings'
import AuthorizationMiddleware from '../Authorization/AuthorizationMiddleware.mjs'
import TrackChangesController from './TrackChangesController.mjs'

export default {
  apply(webRouter) {
    // The optional track-changes module registers its own routes when present.
    if (
      !Settings.enableComments ||
      Settings.moduleImportSequence?.includes('track-changes')
    ) {
      return
    }
    webRouter.post(
      '/project/:Project_id/track_changes',
      AuthorizationMiddleware.blockRestrictedUserFromProject,
      AuthorizationMiddleware.ensureUserCanWriteProjectContent,
      TrackChangesController.setState
    )
    webRouter.get(
      '/project/:Project_id/changes/users',
      AuthorizationMiddleware.blockRestrictedUserFromProject,
      AuthorizationMiddleware.ensureUserCanReadProject,
      TrackChangesController.getUsers
    )
    webRouter.get(
      '/project/:Project_id/ranges',
      AuthorizationMiddleware.blockRestrictedUserFromProject,
      AuthorizationMiddleware.ensureUserCanReadProject,
      TrackChangesController.getRanges
    )
    webRouter.post(
      '/project/:Project_id/doc/:doc_id/changes/accept',
      AuthorizationMiddleware.blockRestrictedUserFromProject,
      AuthorizationMiddleware.ensureUserCanWriteProjectContent,
      TrackChangesController.acceptChanges
    )
  },
}
