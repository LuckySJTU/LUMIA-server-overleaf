import AuthenticationController from '../Authentication/AuthenticationController.mjs'
import AuthorizationMiddleware from '../Authorization/AuthorizationMiddleware.mjs'
import { RateLimiter } from '../../infrastructure/RateLimiter.mjs'
import RateLimiterMiddleware from '../Security/RateLimiterMiddleware.mjs'
import GitHubSyncController from './GitHubSyncController.mjs'

const rateLimiters = {
  githubSync: new RateLimiter('github-sync', {
    points: 10,
    duration: 60,
  }),
}

export default {
  apply(webRouter) {
    const projectWriteMiddleware = [
      AuthenticationController.requireLogin(),
      AuthorizationMiddleware.ensureUserCanWriteProjectContent,
      RateLimiterMiddleware.rateLimit(rateLimiters.githubSync, {
        params: ['Project_id'],
      }),
    ]

    webRouter.get(
      '/project/:Project_id/github-sync',
      AuthenticationController.requireLogin(),
      AuthorizationMiddleware.ensureUserCanReadProject,
      GitHubSyncController.status
    )
    webRouter.post(
      '/project/:Project_id/github-sync/link',
      ...projectWriteMiddleware,
      GitHubSyncController.link
    )
    webRouter.delete(
      '/project/:Project_id/github-sync/link',
      ...projectWriteMiddleware,
      GitHubSyncController.unlink
    )
    webRouter.post(
      '/project/:Project_id/github-sync/pull',
      ...projectWriteMiddleware,
      GitHubSyncController.pull
    )
    webRouter.post(
      '/project/:Project_id/github-sync/push',
      ...projectWriteMiddleware,
      GitHubSyncController.push
    )
  },
}
