import { expressify } from '@overleaf/promise-utils'
import SessionManager from '../Authentication/SessionManager.mjs'
import GitHubSyncManager from './GitHubSyncManager.mjs'
import { z, zz, parseReq } from '../../infrastructure/Validation.mjs'

const projectParamSchema = z.object({
  params: z.object({
    Project_id: zz.objectId(),
  }),
})

const linkSchema = z.object({
  params: z.object({
    Project_id: zz.objectId(),
  }),
  body: z.object({
    remoteUrl: z.string(),
    branch: z.string().optional(),
  }),
})

const pullSchema = z.object({
  params: z.object({
    Project_id: zz.objectId(),
  }),
  body: z
    .object({
      token: z.string().optional(),
      githubToken: z.string().optional(),
    })
    .optional(),
})

const pushSchema = z.object({
  params: z.object({
    Project_id: zz.objectId(),
  }),
  body: z
    .object({
      token: z.string().optional(),
      githubToken: z.string().optional(),
      commitMessage: z.string().optional(),
      force: z.boolean().optional(),
    })
    .optional(),
})

async function status(req, res) {
  const { params } = parseReq(req, projectParamSchema)
  res.json(await GitHubSyncManager.getState(params.Project_id))
}

async function link(req, res) {
  const { params, body } = parseReq(req, linkSchema)
  const ownerId = SessionManager.getLoggedInUserId(req.session)
  const state = await GitHubSyncManager.linkProject({
    projectId: params.Project_id,
    ownerId,
    remoteUrl: body.remoteUrl,
    branch: body.branch,
  })
  res.json(state)
}

async function unlink(req, res) {
  const { params } = parseReq(req, projectParamSchema)
  await GitHubSyncManager.unlinkProject(params.Project_id)
  res.sendStatus(204)
}

async function pull(req, res) {
  const { params, body = {} } = parseReq(req, pullSchema)
  const userId = SessionManager.getLoggedInUserId(req.session)
  const result = await GitHubSyncManager.pullFromGitHub({
    projectId: params.Project_id,
    userId,
    token: getToken(req, body),
  })
  res.json(result)
}

async function push(req, res) {
  const { params, body = {} } = parseReq(req, pushSchema)
  const userId = SessionManager.getLoggedInUserId(req.session)
  const result = await GitHubSyncManager.pushToGitHub({
    projectId: params.Project_id,
    userId,
    token: getToken(req, body),
    commitMessage: body.commitMessage,
    force: body.force === true,
  })
  res.json(result)
}

function getToken(req, body) {
  return (
    body.token ||
    body.githubToken ||
    req.get('x-github-token') ||
    req.get('x-overleaf-github-token')
  )
}

function handleGithubSyncError(handler) {
  return expressify(async function (req, res) {
    try {
      await handler(req, res)
    } catch (error) {
      if (error instanceof GitHubSyncManager.GitHubSyncError) {
        return res.status(error.statusCode).json({
          error: error.message,
          ...error.info,
        })
      }
      throw error
    }
  })
}

export default {
  status: handleGithubSyncError(status),
  link: handleGithubSyncError(link),
  unlink: handleGithubSyncError(unlink),
  pull: handleGithubSyncError(pull),
  push: handleGithubSyncError(push),
}
