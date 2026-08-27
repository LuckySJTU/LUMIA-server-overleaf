import childProcess from 'node:child_process'
import crypto from 'node:crypto'
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
import ChatApiHandler from '../Chat/ChatApiHandler.mjs'
import ChatManager from '../Chat/ChatManager.mjs'
import DocstoreManager from '../Docstore/DocstoreManager.mjs'
import DocumentUpdaterHandler from '../DocumentUpdater/DocumentUpdaterHandler.mjs'
import EditorRealTimeController from '../Editor/EditorRealTimeController.mjs'
import FileStoreHandler from '../FileStore/FileStoreHandler.mjs'
import HistoryManager from '../History/HistoryManager.mjs'
import ProjectEntityHandler from '../Project/ProjectEntityHandler.mjs'
import ProjectGetter from '../Project/ProjectGetter.mjs'
import ProjectRootDocManager from '../Project/ProjectRootDocManager.mjs'
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
const DISABLED_PROXY_VALUES = new Set(['', 'none', 'off', 'false', 'direct'])
const REVIEW_METADATA_GENERATOR = 'LUMIA Overleaf GitHub Sync'
const REVIEW_METADATA_PATH = '.overleaf/review.json'
const REVIEW_METADATA_SCHEMA_VERSION = 1
const MAX_CHANGE_SUMMARY_FILES = 100
const MAX_REVIEW_MESSAGE_LENGTH = 10 * 1024
const MAX_REVIEW_METADATA_BYTES = 5 * 1024 * 1024
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
  if (
    Settings.githubSync &&
    Object.prototype.hasOwnProperty.call(Settings.githubSync, 'proxyUrl')
  ) {
    return Settings.githubSync.proxyUrl
  }
  if (
    Object.prototype.hasOwnProperty.call(process.env, 'GITHUB_SYNC_PROXY_URL')
  ) {
    return process.env.GITHUB_SYNC_PROXY_URL
  }

  return DEFAULT_PROXY_URL
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
  const value = (proxyUrl == null ? '' : String(proxyUrl)).trim()
  if (DISABLED_PROXY_VALUES.has(value.toLowerCase())) {
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
    if (isReviewMetadataProjectPath(projectPath)) {
      continue
    }
    await writeWorktreeFile(dir, projectPath, doc.lines.join('\n'))
  }

  const files = await ProjectEntityHandler.promises.getAllFiles(projectId)
  for (const [projectPath, file] of Object.entries(files)) {
    if (isReviewMetadataProjectPath(projectPath)) continue
    const target = await resolveWorktreePath(dir, projectPath)
    await fs.promises.mkdir(path.dirname(target), { recursive: true })
    const { stream } = await HistoryManager.promises.requestBlobWithProjectId(
      projectId,
      file.hash,
    )
    await pipeline(stream, fs.createWriteStream(target))
  }
  await writeReviewMetadataFile(projectId, dir, docs)
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
    (await FileSystemImportManager.promises.importDir(sourceDir)).filter(
      importEntry => !isReviewMetadataProjectPath(importEntry.projectPath)
    )
  const reviewImport = await prepareReviewImport({
    projectId,
    userId,
    sourceDir,
    importEntries,
  })
  const { docEntries, fileEntries } = await createEntriesFromImports(
    project,
    importEntries,
    reviewImport,
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
  await broadcastImportedReviewThreads(projectId, reviewImport.threadIds)

  return {
    docs: docEntries.length,
    files: fileEntries.length,
    review: reviewImport.summary,
  }
}

async function createEntriesFromImports(project, importEntries, reviewImport) {
  const docEntries = []
  const fileEntries = []
  for (const importEntry of importEntries) {
    switch (importEntry.type) {
      case 'doc': {
        const doc = new Doc({ name: path.basename(importEntry.projectPath) })
        const projectPath = normalizeProjectPath(importEntry.projectPath)
        const ranges = cloneReviewRangesForPath(reviewImport, projectPath)
        await DocstoreManager.promises.updateDoc(
          project._id.toString(),
          doc._id.toString(),
          importEntry.lines,
          0,
          ranges,
        )
        docEntries.push({
          doc,
          path: importEntry.projectPath,
          docLines: importEntry.lines.join('\n'),
          ranges,
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

async function writeReviewMetadataFile(projectId, dir, docs) {
  const metadata = await exportReviewMetadata(projectId, docs)
  if (!hasReviewMetadataContent(metadata)) {
    return
  }
  await writeWorktreeFile(dir, REVIEW_METADATA_PATH, stableJson(metadata))
}

async function exportReviewMetadata(projectId, docs) {
  const rangesByDocId = await getReviewRangesByDocId(projectId)
  const metadata = {
    version: REVIEW_METADATA_SCHEMA_VERSION,
    generator: REVIEW_METADATA_GENERATOR,
    docs: {},
    threads: {},
  }
  const referencedThreadIds = new Set()

  for (const [rawProjectPath, doc] of Object.entries(docs)) {
    if (isReviewMetadataProjectPath(rawProjectPath)) {
      continue
    }
    const docId = doc._id.toString()
    const ranges = normalizeReviewRanges(rangesByDocId.get(docId))
    if (!hasReviewRanges(ranges)) {
      continue
    }
    for (const threadId of collectCommentThreadIds(ranges.comments)) {
      referencedThreadIds.add(threadId)
    }
    const content = doc.lines.join('\n')
    metadata.docs[normalizeProjectPath(rawProjectPath)] = {
      contentHash: contentHash(content),
      ranges,
    }
  }

  if (referencedThreadIds.size > 0) {
    const threads = await ChatApiHandler.promises.getThreads(projectId)
    for (const threadId of Array.from(referencedThreadIds).sort()) {
      const thread = normalizeThreadForMetadata(threads[threadId])
      if (thread.messages.length > 0) {
        metadata.threads[threadId] = thread
      }
    }
  }

  return metadata
}

async function getReviewRangesByDocId(projectId) {
  const rangesByDocId = new Map()
  for (const doc of await DocstoreManager.promises.getAllRanges(projectId)) {
    rangesByDocId.set(doc._id.toString(), doc.ranges)
  }
  return rangesByDocId
}

async function prepareReviewImport({ projectId, userId, sourceDir, importEntries }) {
  const metadata = await readReviewMetadataFile(sourceDir)
  const summary = emptyReviewImportSummary()
  const rangesByPath = new Map()
  if (!metadata) {
    return { rangesByPath, threadIds: new Set(), summary }
  }

  const docsByPath = new Map()
  for (const importEntry of importEntries) {
    if (importEntry.type === 'doc') {
      docsByPath.set(normalizeProjectPath(importEntry.projectPath), importEntry)
    }
  }

  const referencedThreadIds = new Set()
  for (const [rawProjectPath, docMetadata] of Object.entries(metadata.docs)) {
    const projectPath = normalizeProjectPath(rawProjectPath)
    const importEntry = docsByPath.get(projectPath)
    if (!importEntry) {
      continue
    }

    const content = importEntry.lines.join('\n')
    const restored = restoreReviewRangesForContent(docMetadata, content)
    summary.skippedComments += restored.skippedComments
    summary.skippedChanges += restored.skippedChanges

    const filteredComments = filterRestorableComments(
      restored.ranges.comments,
      content,
      referencedThreadIds
    )
    summary.skippedComments +=
      restored.ranges.comments.length - filteredComments.length
    restored.ranges.comments = filteredComments

    if (hasReviewRanges(restored.ranges)) {
      rangesByPath.set(projectPath, restored.ranges)
    }
  }

  const validThreadIds = await ensureReviewThreads({
    projectId,
    userId,
    threads: metadata.threads,
    threadIds: referencedThreadIds,
  })

  const finalThreadIds = new Set()
  for (const [projectPath, ranges] of rangesByPath) {
    const comments = ranges.comments.filter(comment => {
      if (validThreadIds.has(comment.op.t)) {
        finalThreadIds.add(comment.op.t)
        return true
      }
      summary.skippedComments += 1
      return false
    })
    ranges.comments = comments
    if (!hasReviewRanges(ranges)) {
      rangesByPath.delete(projectPath)
    }
  }

  for (const ranges of rangesByPath.values()) {
    if (hasReviewRanges(ranges)) {
      summary.docs += 1
      summary.comments += ranges.comments.length
      summary.changes += ranges.changes.length
    }
  }
  summary.threads = finalThreadIds.size

  return { rangesByPath, threadIds: finalThreadIds, summary }
}

async function readReviewMetadataFile(sourceDir) {
  const target = path.join(sourceDir, REVIEW_METADATA_PATH)
  let stat
  try {
    stat = await fs.promises.stat(target)
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null
    }
    throw error
  }
  if (!stat.isFile() || stat.size > MAX_REVIEW_METADATA_BYTES) {
    logger.warn(
      { path: REVIEW_METADATA_PATH, size: stat.size },
      'ignoring invalid github sync review metadata file'
    )
    return null
  }

  try {
    const metadata = JSON.parse(await fs.promises.readFile(target, 'utf8'))
    if (
      !isPlainObject(metadata) ||
      metadata.version !== REVIEW_METADATA_SCHEMA_VERSION ||
      !isPlainObject(metadata.docs)
    ) {
      logger.warn(
        { path: REVIEW_METADATA_PATH, version: metadata && metadata.version },
        'ignoring unsupported github sync review metadata file'
      )
      return null
    }
    return {
      docs: metadata.docs,
      threads: isPlainObject(metadata.threads) ? metadata.threads : {},
    }
  } catch (error) {
    logger.warn(
      { err: error, path: REVIEW_METADATA_PATH },
      'ignoring malformed github sync review metadata file'
    )
    return null
  }
}

async function ensureReviewThreads({ projectId, userId, threads, threadIds }) {
  if (threadIds.size === 0) {
    return new Set()
  }

  const normalizedUserId = normalizeObjectIdString(userId)
  const requestedThreadIds = Array.from(threadIds).sort()
  const existingThreads = await ChatApiHandler.promises.generateThreadData(
    projectId,
    requestedThreadIds
  )
  const validThreadIds = new Set(Object.keys(existingThreads))

  for (const threadId of requestedThreadIds) {
    if (validThreadIds.has(threadId)) {
      continue
    }

    const thread = normalizeThreadForMetadata(threads[threadId])
    let messagesCreated = 0
    for (const message of thread.messages) {
      const messageUserId =
        normalizeObjectIdString(message.user_id) || normalizedUserId
      if (!messageUserId) {
        continue
      }
      await ChatApiHandler.promises.sendComment(
        projectId,
        threadId,
        messageUserId,
        message.content
      )
      messagesCreated += 1
    }
    if (messagesCreated > 0) {
      validThreadIds.add(threadId)
    }
  }

  for (const threadId of validThreadIds) {
    const thread = normalizeThreadForMetadata(threads[threadId])
    if (thread.resolved) {
      await ChatApiHandler.promises.resolveThread(
        projectId,
        threadId,
        thread.resolved_by_user_id || normalizedUserId
      )
    } else if (threads[threadId]) {
      await ChatApiHandler.promises.reopenThread(projectId, threadId)
    }
  }

  return validThreadIds
}

async function broadcastImportedReviewThreads(projectId, threadIds) {
  if (!threadIds || threadIds.size === 0) {
    return
  }
  try {
    const threadData = await ChatApiHandler.promises.generateThreadData(
      projectId,
      Array.from(threadIds)
    )
    await ChatManager.promises.injectUserInfoIntoThreads(threadData)
    EditorRealTimeController.emitToRoom(
      projectId,
      'new-comment-threads',
      threadData
    )
  } catch (error) {
    logger.warn(
      { err: error, projectId },
      'failed to broadcast imported github sync review threads'
    )
  }
}

function restoreReviewRangesForContent(docMetadata, content) {
  const ranges = normalizeReviewRanges(docMetadata && docMetadata.ranges)
  if (docMetadata && docMetadata.contentHash === contentHash(content)) {
    return { ranges, skippedComments: 0, skippedChanges: 0 }
  }

  const remappedComments = remapCommentRanges(ranges.comments, content)
  return {
    ranges: {
      comments: remappedComments.comments,
      changes: [],
    },
    skippedComments: remappedComments.skipped,
    skippedChanges: ranges.changes.length,
  }
}

function remapCommentRanges(comments, content) {
  const remapped = []
  let skipped = 0

  for (const comment of comments) {
    const next = cloneJson(comment)
    if (!isPlainObject(next.op) || !Number.isInteger(next.op.p)) {
      skipped += 1
      continue
    }
    const selectedText = typeof next.op.c === 'string' ? next.op.c : ''
    if (!selectedText) {
      if (next.op.p <= content.length) {
        remapped.push(next)
      } else {
        skipped += 1
      }
      continue
    }

    const newPosition = findClosestTextPosition(content, selectedText, next.op.p)
    if (newPosition == null) {
      skipped += 1
      continue
    }
    next.op.p = newPosition
    remapped.push(next)
  }

  return { comments: remapped, skipped }
}

function findClosestTextPosition(content, selectedText, oldPosition) {
  const positions = []
  let position = content.indexOf(selectedText)
  while (position !== -1) {
    positions.push(position)
    if (positions.length > 1000) {
      return null
    }
    position = content.indexOf(selectedText, position + 1)
  }
  if (positions.length === 0) {
    return null
  }

  let closest = null
  let closestDistance = Infinity
  let ambiguous = false
  for (const candidate of positions) {
    const distance = Math.abs(candidate - oldPosition)
    if (distance < closestDistance) {
      closest = candidate
      closestDistance = distance
      ambiguous = false
    } else if (distance === closestDistance) {
      ambiguous = true
    }
  }
  return ambiguous ? null : closest
}

function filterRestorableComments(comments, content, referencedThreadIds) {
  const filtered = []
  for (const comment of comments) {
    const normalizedComment = normalizeCommentRange(comment, content)
    if (!normalizedComment) {
      continue
    }
    referencedThreadIds.add(normalizedComment.op.t)
    filtered.push(normalizedComment)
  }
  return filtered
}

function normalizeCommentRange(comment, content) {
  if (!isPlainObject(comment) || !isPlainObject(comment.op)) {
    return null
  }
  const threadId = normalizeObjectIdString(comment.op.t || comment.id)
  if (!threadId) {
    return null
  }
  const position = comment.op.p
  if (!Number.isInteger(position) || position < 0) {
    return null
  }
  const selectedText = typeof comment.op.c === 'string' ? comment.op.c : ''
  if (position + selectedText.length > content.length) {
    return null
  }

  const normalizedComment = cloneJson(comment)
  normalizedComment.id = threadId
  normalizedComment.op.t = threadId
  normalizedComment.op.p = position
  normalizedComment.op.c = selectedText
  return normalizedComment
}

function normalizeThreadForMetadata(thread) {
  const normalizedThread = { messages: [] }
  if (!isPlainObject(thread)) {
    return normalizedThread
  }

  for (const message of Array.isArray(thread.messages) ? thread.messages : []) {
    if (
      !isPlainObject(message) ||
      typeof message.content !== 'string' ||
      !message.content ||
      message.content.length > MAX_REVIEW_MESSAGE_LENGTH
    ) {
      continue
    }
    const messageUserId = normalizeObjectIdString(message.user_id)
    const normalizedMessage = {
      content: message.content,
      user_id: messageUserId,
    }
    if (message.id != null) {
      normalizedMessage.id = message.id.toString()
    }
    if (message.timestamp != null) {
      normalizedMessage.timestamp = message.timestamp
    }
    if (message.edited_at != null) {
      normalizedMessage.edited_at = message.edited_at
    }
    normalizedThread.messages.push(normalizedMessage)
  }

  if (thread.resolved) {
    normalizedThread.resolved = true
    const resolvedByUserId = normalizeObjectIdString(thread.resolved_by_user_id)
    if (resolvedByUserId) {
      normalizedThread.resolved_by_user_id = resolvedByUserId
    }
    if (thread.resolved_at != null) {
      normalizedThread.resolved_at = thread.resolved_at
    }
  }
  return normalizedThread
}

function collectCommentThreadIds(comments) {
  const threadIds = new Set()
  for (const comment of comments) {
    const commentOp = comment && comment.op
    const threadId = normalizeObjectIdString(
      (commentOp && commentOp.t) || (comment && comment.id)
    )
    if (threadId) {
      threadIds.add(threadId)
    }
  }
  return threadIds
}

function cloneReviewRangesForPath(reviewImport, projectPath) {
  return cloneJson(
    reviewImport && reviewImport.rangesByPath
      ? reviewImport.rangesByPath.get(projectPath) || emptyReviewRanges()
      : emptyReviewRanges()
  )
}

function normalizeReviewRanges(ranges) {
  if (!isPlainObject(ranges)) {
    return emptyReviewRanges()
  }
  return {
    comments: Array.isArray(ranges.comments) ? cloneJson(ranges.comments) : [],
    changes: Array.isArray(ranges.changes) ? cloneJson(ranges.changes) : [],
  }
}

function hasReviewRanges(ranges) {
  return ranges.comments.length > 0 || ranges.changes.length > 0
}

function hasReviewMetadataContent(metadata) {
  return Object.keys(metadata.docs).length > 0
}

function emptyReviewRanges() {
  return { comments: [], changes: [] }
}

function emptyReviewImportSummary() {
  return {
    docs: 0,
    comments: 0,
    changes: 0,
    threads: 0,
    skippedComments: 0,
    skippedChanges: 0,
  }
}

function normalizeProjectPath(projectPath) {
  return `/${projectPath.toString().replace(/^\/+/, '')}`
}

function isReviewMetadataProjectPath(projectPath) {
  return projectPath.toString().replace(/^\/+/, '') === REVIEW_METADATA_PATH
}

function normalizeObjectIdString(value) {
  if (value == null) {
    return null
  }
  const objectId = value.toString()
  return ObjectId.isValid(objectId) ? objectId : null
}

function contentHash(content) {
  return crypto.createHash('sha256').update(content).digest('hex')
}

function stableJson(value) {
  return `${JSON.stringify(sortJson(value), null, 2)}\n`
}

function sortJson(value) {
  if (Array.isArray(value)) {
    return value.map(sortJson)
  }
  if (!isPlainObject(value)) {
    return value
  }
  const sorted = {}
  for (const key of Object.keys(value).sort()) {
    sorted[key] = sortJson(value[key])
  }
  return sorted
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value))
}

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value)
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
