import childProcess from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { pipeline } from 'node:stream/promises'
import mongodb from 'mongodb-legacy'
import Settings from '@overleaf/settings'
import logger from '@overleaf/logger'
import OError from '@overleaf/o-error'
import { db } from '../../infrastructure/mongodb.mjs'
import { Doc } from '../../models/Doc.mjs'
import { Project } from '../../models/Project.mjs'
import DocstoreManager from '../Docstore/DocstoreManager.mjs'
import DocumentUpdaterHandler from '../DocumentUpdater/DocumentUpdaterHandler.mjs'
import HistoryManager from '../History/HistoryManager.mjs'
import ProjectEntityHandler from '../Project/ProjectEntityHandler.mjs'
import ProjectGetter from '../Project/ProjectGetter.mjs'
import ProjectRootDocManager from '../Project/ProjectRootDocManager.mjs'
import FileStoreHandler from '../FileStore/FileStoreHandler.mjs'
import FileSystemImportManager from '../Uploads/FileSystemImportManager.mjs'
import FolderStructureBuilder from '../Project/FolderStructureBuilder.mjs'
import SafePath from '../Project/SafePath.mjs'
import TpdsProjectFlusher from '../ThirdPartyDataStore/TpdsProjectFlusher.mjs'

const execFile = promisify(childProcess.execFile)
const { ObjectId } = mongodb

const DEFAULT_BRANCH = 'main'
const DEFAULT_TIMEOUT_MS = 2 * 60 * 1000
const DEFAULT_PROXY_URL = 'http://192.168.102.101:7890'
const GIT_SOURCE = 'github-sync'
const MAX_CHANGE_SUMMARY_FILES = 100
const GITHUB_REMOTE_RX =
  /^(?:https:\/\/github\.com\/|git@github\.com:)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/

class GitHubSyncError extends Error {
  constructor(message, statusCode = 400, info = {}) {
    super(message)
    this.name = 'GitHubSyncError'
    this.statusCode = statusCode
    this.info = info
  }
}

function getRootDir() {
  return (
    (Settings.githubSync && Settings.githubSync.rootDir) ||
    process.env.GITHUB_SYNC_ROOT_DIR ||
    path.join(os.tmpdir(), 'overleaf-github-sync')
  )
}

function getGitTimeoutMs() {
  return (
    (Settings.githubSync && Settings.githubSync.gitTimeoutMs) ||
    DEFAULT_TIMEOUT_MS
  )
}

function getDefaultProxyUrl() {
  return (
    (Settings.githubSync && Settings.githubSync.proxyUrl) ||
    process.env.GITHUB_SYNC_PROXY_URL ||
    DEFAULT_PROXY_URL
  )
}

function projectIdString(projectId) {
  return projectId.toString()
}

function stateQuery(projectId) {
  return { project_id: projectIdString(projectId) }
}

function checkoutDir(projectId) {
  return path.join(getRootDir(), projectIdString(projectId))
}

function normalizeBranch(branch) {
  branch = branch || DEFAULT_BRANCH
  if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.includes('..')) {
    throw new GitHubSyncError('invalid_branch')
  }
  return branch
}

function normalizeRemoteUrl(remoteUrl) {
  const match = (remoteUrl || '').trim().match(GITHUB_REMOTE_RX)
  if (!match) {
    throw new GitHubSyncError('invalid_github_remote_url')
  }
  return `https://github.com/${match[1]}/${match[2]}.git`
}

function normalizeProxyUrl(proxyUrl) {
  const value = (proxyUrl || '').trim()
  if (!value) {
    return null
  }

  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new GitHubSyncError('invalid_proxy_url')
  }

  if (!['http:', 'https:', 'socks4:', 'socks5:'].includes(parsed.protocol)) {
    throw new GitHubSyncError('invalid_proxy_url')
  }
  if (!parsed.hostname) {
    throw new GitHubSyncError('invalid_proxy_url')
  }
  return parsed.toString()
}

function getProxyUrl() {
  return normalizeProxyUrl(getDefaultProxyUrl())
}

function assertTokenForWrite(token) {
  if (!token) {
    throw new GitHubSyncError('github_token_required')
  }
}

function serializeState(state) {
  if (!state) {
    return { linked: false }
  }
  return {
    linked: true,
    remoteUrl: state.remoteUrl,
    branch: state.branch,
    lastSyncedCommit: state.lastSyncedCommit,
    lastSyncedAt: state.lastSyncedAt,
    lastPushedCommit: state.lastPushedCommit,
    lastPulledCommit: state.lastPulledCommit,
  }
}

async function getState(projectId) {
  return await db.githubSyncProjectStates.findOne(stateQuery(projectId))
}

async function linkProject({ projectId, ownerId, remoteUrl, branch }) {
  const normalizedRemoteUrl = normalizeRemoteUrl(remoteUrl)
  const normalizedBranch = normalizeBranch(branch)
  const now = new Date()
  const update = {
    $set: {
      project_id: projectIdString(projectId),
      owner_id: ownerId ? new ObjectId(ownerId.toString()) : null,
      remoteUrl: normalizedRemoteUrl,
      branch: normalizedBranch,
      updatedAt: now,
    },
    $unset: {
      proxyUrl: 1,
    },
    $setOnInsert: {
      createdAt: now,
    },
  }
  await db.githubSyncProjectStates.updateOne(stateQuery(projectId), update, {
    upsert: true,
  })
  return serializeState(await getState(projectId))
}

async function unlinkProject(projectId) {
  await db.githubSyncProjectStates.deleteOne(stateQuery(projectId))
  await fs.promises.rm(checkoutDir(projectId), {
    recursive: true,
    force: true,
  })
}

async function pullFromGitHub({ projectId, userId, token }) {
  const state = await requireLinkedState(projectId)
  const resolvedProxyUrl = getProxyUrl()
  const { dir } = await prepareCheckout(state, token, {
    proxyUrl: resolvedProxyUrl,
  })
  const commit = await git(['rev-parse', 'HEAD'], {
    cwd: dir,
    token,
    proxyUrl: resolvedProxyUrl,
  })
  const commitHash = commit.stdout.trim()
  const changeSummary = await summarizePullChanges({
    dir,
    previousCommit: state.lastSyncedCommit,
    nextCommit: commitHash,
    token,
    proxyUrl: resolvedProxyUrl,
  })
  const imported = await replaceProjectFromDirectory({
    projectId,
    userId,
    sourceDir: dir,
  })
  await recordSyncState(projectId, {
    lastSyncedCommit: commitHash,
    lastPulledCommit: commitHash,
    lastSyncedAt: new Date(),
  })
  return {
    commit: commitHash,
    imported,
    changes: changeSummary.files,
    changesTruncated: changeSummary.truncated,
    reloadRequired: true,
  }
}

async function pushToGitHub({
  projectId,
  userId,
  token,
  commitMessage,
  force,
}) {
  assertTokenForWrite(token)
  const state = await requireLinkedState(projectId)
  const resolvedProxyUrl = getProxyUrl()
  const { dir, remoteCommit } = await prepareCheckout(state, token, {
    allowMissingRemoteBranch: true,
    proxyUrl: resolvedProxyUrl,
  })

  if (
    state.lastSyncedCommit &&
    remoteCommit &&
    state.lastSyncedCommit !== remoteCommit &&
    !force
  ) {
    throw new GitHubSyncError('remote_has_new_commits', 409, {
      remoteCommit,
      lastSyncedCommit: state.lastSyncedCommit,
    })
  }

  await DocumentUpdaterHandler.promises.flushProjectToMongo(projectId)
  await replaceCheckoutWithProject(projectId, dir)
  await git(['add', '-A'], { cwd: dir, token, proxyUrl: resolvedProxyUrl })
  const changeSummary = await summarizeCachedChanges({
    dir,
    token,
    proxyUrl: resolvedProxyUrl,
  })
  if (changeSummary.files.length === 0) {
    return {
      status: 'unchanged',
      commit: remoteCommit,
      changes: [],
      changesTruncated: false,
    }
  }

  await git(
    [
      '-c',
      'user.name=Overleaf GitHub Sync',
      '-c',
      'user.email=overleaf-github-sync@local',
      'commit',
      '-m',
      commitMessage || `Sync Overleaf project ${projectIdString(projectId)}`,
    ],
    { cwd: dir, token, proxyUrl: resolvedProxyUrl },
  )
  await git(['push', 'origin', `HEAD:${state.branch}`], {
    cwd: dir,
    token,
    proxyUrl: resolvedProxyUrl,
  })
  const pushedCommit = (
    await git(['rev-parse', 'HEAD'], {
      cwd: dir,
      token,
      proxyUrl: resolvedProxyUrl,
    })
  ).stdout.trim()
  await recordSyncState(projectId, {
    lastSyncedCommit: pushedCommit,
    lastPushedCommit: pushedCommit,
    lastSyncedAt: new Date(),
  })
  return {
    status: 'pushed',
    commit: pushedCommit,
    changes: changeSummary.files,
    changesTruncated: changeSummary.truncated,
  }
}

async function summarizePullChanges({
  dir,
  previousCommit,
  nextCommit,
  token,
  proxyUrl,
}) {
  if (previousCommit && previousCommit === nextCommit) {
    return emptyChangeSummary()
  }

  if (
    previousCommit &&
    (await commitExists(dir, previousCommit, token, proxyUrl))
  ) {
    const result = await git(
      ['diff', '--name-status', '--find-renames', previousCommit, nextCommit],
      {
        cwd: dir,
        token,
        proxyUrl,
      },
    )
    return parseNameStatus(result.stdout)
  }

  const result = await git(['ls-tree', '-r', '--name-only', nextCommit], {
    cwd: dir,
    token,
    proxyUrl,
  })
  return limitChangeSummary(
    result.stdout
      .split('\n')
      .map(file => file.trim())
      .filter(Boolean)
      .map(file => ({ status: 'added', path: file })),
  )
}

async function summarizeCachedChanges({ dir, token, proxyUrl }) {
  const result = await git(
    ['diff', '--cached', '--name-status', '--find-renames'],
    {
      cwd: dir,
      token,
      proxyUrl,
    },
  )
  return parseNameStatus(result.stdout)
}

async function commitExists(dir, commit, token, proxyUrl) {
  try {
    await git(['cat-file', '-e', `${commit}^{commit}`], {
      cwd: dir,
      token,
      proxyUrl,
    })
    return true
  } catch {
    return false
  }
}

function parseNameStatus(output) {
  const changes = []
  for (const line of output.split('\n')) {
    if (!line.trim()) {
      continue
    }
    const [rawStatus, firstPath, secondPath] = line.split('\t')
    const status = normalizeChangeStatus(rawStatus)
    if (status === 'renamed' || status === 'copied') {
      changes.push({ status, oldPath: firstPath, path: secondPath })
    } else {
      changes.push({ status, path: firstPath })
    }
  }
  return limitChangeSummary(changes)
}

function normalizeChangeStatus(rawStatus) {
  switch (rawStatus[0]) {
    case 'A':
      return 'added'
    case 'M':
      return 'modified'
    case 'D':
      return 'deleted'
    case 'R':
      return 'renamed'
    case 'C':
      return 'copied'
    default:
      return 'changed'
  }
}

function limitChangeSummary(changes) {
  return {
    files: changes.slice(0, MAX_CHANGE_SUMMARY_FILES),
    truncated: changes.length > MAX_CHANGE_SUMMARY_FILES,
  }
}

function emptyChangeSummary() {
  return {
    files: [],
    truncated: false,
  }
}

async function requireLinkedState(projectId) {
  const state = await getState(projectId)
  if (!state) {
    throw new GitHubSyncError('github_sync_not_linked', 404)
  }
  return state
}

async function recordSyncState(projectId, fields) {
  await db.githubSyncProjectStates.updateOne(stateQuery(projectId), {
    $set: {
      ...fields,
      updatedAt: new Date(),
    },
  })
}

async function prepareCheckout(state, token, options = {}) {
  const dir = checkoutDir(state.project_id)
  await fs.promises.mkdir(getRootDir(), { recursive: true })

  if (!(await pathExists(path.join(dir, '.git')))) {
    await fs.promises.rm(dir, { recursive: true, force: true })
    await cloneRepository(state, dir, token, options.proxyUrl)
  } else {
    await git(['remote', 'set-url', 'origin', state.remoteUrl], {
      cwd: dir,
      token,
      proxyUrl: options.proxyUrl,
    })
  }

  let remoteCommit = null
  try {
    await git(['fetch', 'origin', state.branch], {
      cwd: dir,
      token,
      proxyUrl: options.proxyUrl,
    })
    await git(['checkout', '-B', state.branch, `origin/${state.branch}`], {
      cwd: dir,
      token,
      proxyUrl: options.proxyUrl,
    })
    await git(['reset', '--hard', `origin/${state.branch}`], {
      cwd: dir,
      token,
      proxyUrl: options.proxyUrl,
    })
    remoteCommit = (
      await git(['rev-parse', `origin/${state.branch}`], {
        cwd: dir,
        token,
        proxyUrl: options.proxyUrl,
      })
    ).stdout.trim()
  } catch (error) {
    if (!options.allowMissingRemoteBranch) {
      throw error
    }
    await git(['checkout', '-B', state.branch], {
      cwd: dir,
      token,
      proxyUrl: options.proxyUrl,
    })
  }
  return { dir, remoteCommit }
}

async function cloneRepository(state, dir, token, proxyUrl) {
  try {
    await git(['clone', '--branch', state.branch, state.remoteUrl, dir], {
      token,
      proxyUrl,
      cwd: getRootDir(),
    })
  } catch (error) {
    await fs.promises.rm(dir, { recursive: true, force: true })
    await git(['clone', state.remoteUrl, dir], {
      token,
      proxyUrl,
      cwd: getRootDir(),
    })
    await git(['checkout', '-B', state.branch], { cwd: dir, token, proxyUrl })
  }
}

async function git(args, { cwd, token, proxyUrl }) {
  return await withAskPass(token, async env => {
    try {
      return await execFile('git', args, {
        cwd,
        env: {
          ...process.env,
          ...proxyEnv(proxyUrl),
          ...env,
          GIT_TERMINAL_PROMPT: '0',
        },
        timeout: getGitTimeoutMs(),
        maxBuffer: 10 * 1024 * 1024,
      })
    } catch (error) {
      throw OError.tag(error, 'git command failed', {
        args: args.map(arg => (arg === token ? '<redacted>' : arg)),
        cwd,
        stderr: error.stderr,
      })
    }
  })
}

function proxyEnv(proxyUrl) {
  if (!proxyUrl) {
    return {}
  }
  return {
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    ALL_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    all_proxy: proxyUrl,
  }
}

async function withAskPass(token, fn) {
  if (!token) {
    return await fn({})
  }
  const dir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'overleaf-github-askpass-'),
  )
  const askPass = path.join(dir, 'askpass.sh')
  await fs.promises.writeFile(
    askPass,
    [
      '#!/bin/sh',
      'case "$1" in',
      '  *Username*) printf "%s\\n" "x-access-token" ;;',
      '  *) printf "%s\\n" "$OVERLEAF_GITHUB_TOKEN" ;;',
      'esac',
      '',
    ].join('\n'),
    { mode: 0o700 },
  )
  try {
    return await fn({
      GIT_ASKPASS: askPass,
      OVERLEAF_GITHUB_TOKEN: token,
    })
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true })
  }
}

async function replaceCheckoutWithProject(projectId, dir) {
  await removeWorktreeFiles(dir)
  const docs = await ProjectEntityHandler.promises.getAllDocs(projectId)
  for (const [projectPath, doc] of Object.entries(docs)) {
    await writeWorktreeFile(dir, projectPath, doc.lines.join('\n'))
  }

  const files = await ProjectEntityHandler.promises.getAllFiles(projectId)
  for (const [projectPath, file] of Object.entries(files)) {
    const target = await resolveWorktreePath(dir, projectPath)
    await fs.promises.mkdir(path.dirname(target), { recursive: true })
    const { stream } = await HistoryManager.promises.requestBlobWithProjectId(
      projectId,
      file.hash,
    )
    await pipeline(stream, fs.createWriteStream(target))
  }
}

async function replaceProjectFromDirectory({ projectId, userId, sourceDir }) {
  const project = await ProjectGetter.promises.getProject(projectId, {
    name: true,
    rootFolder: true,
    overleaf: true,
    rootDoc_id: true,
  })
  if (!project) {
    throw new GitHubSyncError('project_not_found', 404)
  }

  const importEntries =
    await FileSystemImportManager.promises.importDir(sourceDir)
  const { docEntries, fileEntries } = await createEntriesFromImports(
    project,
    importEntries,
  )

  const oldEntities = ProjectEntityHandler.getAllEntitiesFromProject(project)
  const rootFolder = FolderStructureBuilder.buildFolderStructure(
    docEntries,
    fileEntries,
  )
  const newProject = await Project.findOneAndUpdate(
    { _id: projectId },
    {
      $set: {
        rootFolder: [rootFolder],
        lastUpdated: new Date(),
        lastUpdatedBy: userId,
      },
      $unset: {
        rootDoc_id: 1,
        mainBibliographyDoc_id: 1,
      },
      $inc: { version: 1 },
    },
    { new: true },
  ).exec()
  if (!newProject) {
    throw new GitHubSyncError('project_not_found', 404)
  }

  const historyId =
    project.overleaf && project.overleaf.history && project.overleaf.history.id
  await DocumentUpdaterHandler.promises.updateProjectStructure(
    projectId,
    historyId,
    userId,
    {
      oldDocs: oldEntities.docs,
      oldFiles: oldEntities.files,
      newDocs: docEntries,
      newFiles: fileEntries,
      newProject,
    },
    GIT_SOURCE,
  )
  await cleanupOldDocs(project, oldEntities.docs)
  await ProjectRootDocManager.promises.setRootDocAutomatically(projectId)
  await TpdsProjectFlusher.promises.flushProjectToTpds(projectId)

  return {
    docs: docEntries.length,
    files: fileEntries.length,
  }
}

async function createEntriesFromImports(project, importEntries) {
  const docEntries = []
  const fileEntries = []
  for (const importEntry of importEntries) {
    switch (importEntry.type) {
      case 'doc': {
        const doc = new Doc({ name: path.basename(importEntry.projectPath) })
        await DocstoreManager.promises.updateDoc(
          project._id.toString(),
          doc._id.toString(),
          importEntry.lines,
          0,
          {},
        )
        docEntries.push({
          doc,
          path: importEntry.projectPath,
          docLines: importEntry.lines.join('\n'),
        })
        break
      }
      case 'file': {
        const historyId =
          project.overleaf &&
          project.overleaf.history &&
          project.overleaf.history.id
        if (!historyId) {
          throw new OError('missing history id', { projectId: project._id })
        }
        const { createdBlob, fileRef } =
          await FileStoreHandler.promises.uploadFileFromDiskWithHistoryId(
            project._id,
            historyId,
            { name: path.basename(importEntry.projectPath) },
            importEntry.fsPath,
          )
        fileEntries.push({
          createdBlob,
          file: fileRef,
          path: importEntry.projectPath,
        })
        break
      }
      default:
        throw new Error(`invalid import type: ${importEntry.type}`)
    }
  }
  return { docEntries, fileEntries }
}

async function cleanupOldDocs(project, docs) {
  for (const { doc } of docs) {
    try {
      const deletedAt = new Date()
      await DocstoreManager.promises.deleteDoc(
        project._id.toString(),
        doc._id.toString(),
        doc.name,
        deletedAt,
      )
      await DocumentUpdaterHandler.promises.deleteDoc(
        project._id.toString(),
        doc._id.toString(),
      )
    } catch (error) {
      logger.warn(
        { err: error, projectId: project._id, docId: doc._id },
        'failed to clean up old doc after github sync import',
      )
    }
  }
}

async function removeWorktreeFiles(dir) {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name === '.git') {
      continue
    }
    await fs.promises.rm(path.join(dir, entry.name), {
      recursive: true,
      force: true,
    })
  }
}

async function writeWorktreeFile(root, projectPath, content) {
  const target = await resolveWorktreePath(root, projectPath)
  await fs.promises.mkdir(path.dirname(target), { recursive: true })
  await fs.promises.writeFile(target, content)
}

async function resolveWorktreePath(root, projectPath) {
  const relativePath = projectPath.replace(/^\/+/, '')
  if (!SafePath.isCleanPath(relativePath) || relativePath.includes('.git/')) {
    throw new GitHubSyncError('invalid_project_path', 400, { projectPath })
  }
  const target = path.resolve(root, relativePath)
  const resolvedRoot = path.resolve(root)
  if (!target.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new GitHubSyncError('invalid_project_path', 400, { projectPath })
  }
  return target
}

async function pathExists(target) {
  try {
    await fs.promises.access(target)
    return true
  } catch {
    return false
  }
}

export default {
  GitHubSyncError,
  getState: async projectId => serializeState(await getState(projectId)),
  linkProject,
  unlinkProject,
  pullFromGitHub,
  pushToGitHub,
}
