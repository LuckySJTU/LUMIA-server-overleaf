import { expressify } from '@overleaf/promise-utils'
import Modules from '../../infrastructure/Modules.mjs'
import ChatApiHandler from './ChatApiHandler.mjs'
import EditorRealTimeController from '../Editor/EditorRealTimeController.mjs'
import SessionManager from '../Authentication/SessionManager.mjs'
import UserInfoManager from '../User/UserInfoManager.mjs'
import UserInfoController from '../User/UserInfoController.mjs'
import ChatManager from './ChatManager.mjs'
import DocumentUpdaterHandler from '../DocumentUpdater/DocumentUpdaterHandler.mjs'

function getLoggedInUserId(req) {
  const userId = SessionManager.getLoggedInUserId(req.session)
  if (userId == null) {
    throw new Error('no logged-in user')
  }
  return userId
}

async function sendMessage(req, res) {
  const { project_id: projectId } = req.params
  const { content, client_id: clientId } = req.body
  const userId = getLoggedInUserId(req)

  const message = await ChatApiHandler.promises.sendGlobalMessage(
    projectId,
    userId,
    content
  )

  const user = await UserInfoManager.promises.getPersonalInfo(message.user_id)
  message.user = UserInfoController.formatPersonalInfo(user)
  message.clientId = clientId
  EditorRealTimeController.emitToRoom(projectId, 'new-chat-message', message)

  await Modules.promises.hooks.fire('chatMessageSent', {
    projectId,
    userId,
    messageId: message.id,
  })

  res.sendStatus(204)
}

async function getMessages(req, res) {
  const { project_id: projectId } = req.params
  const { query } = req
  const messages = await ChatApiHandler.promises.getGlobalMessages(
    projectId,
    query.limit,
    query.before
  )

  await ChatManager.promises.injectUserInfoIntoThreads({ global: { messages } })
  res.json(messages)
}

async function getThreads(req, res) {
  const { project_id: projectId } = req.params
  const threads = await ChatApiHandler.promises.getThreads(projectId)

  await ChatManager.promises.injectUserInfoIntoThreads(threads)
  res.json(threads)
}

async function sendComment(req, res) {
  const { project_id: projectId, thread_id: threadId } = req.params
  const { content } = req.body
  const userId = getLoggedInUserId(req)

  const comment = await ChatApiHandler.promises.sendComment(
    projectId,
    threadId,
    userId,
    content
  )

  const user = await UserInfoManager.promises.getPersonalInfo(comment.user_id)
  comment.user = UserInfoController.formatPersonalInfo(user)

  EditorRealTimeController.emitToRoom(projectId, 'new-comment', threadId, comment)
  res.sendStatus(204)
}

async function resolveThread(req, res) {
  const { project_id: projectId, doc_id: docId, thread_id: threadId } = req.params
  const userId = getLoggedInUserId(req)

  await DocumentUpdaterHandler.promises.resolveThread(
    projectId,
    docId,
    threadId,
    userId
  )
  await ChatApiHandler.promises.resolveThread(projectId, threadId, userId)

  const user = await UserInfoManager.promises.getPersonalInfo(userId)
  EditorRealTimeController.emitToRoom(
    projectId,
    'resolve-thread',
    threadId,
    UserInfoController.formatPersonalInfo(user)
  )
  res.sendStatus(204)
}

async function reopenThread(req, res) {
  const { project_id: projectId, doc_id: docId, thread_id: threadId } = req.params
  const userId = getLoggedInUserId(req)

  await DocumentUpdaterHandler.promises.reopenThread(
    projectId,
    docId,
    threadId,
    userId
  )
  await ChatApiHandler.promises.reopenThread(projectId, threadId)

  EditorRealTimeController.emitToRoom(projectId, 'reopen-thread', threadId)
  res.sendStatus(204)
}

async function deleteThread(req, res) {
  const { project_id: projectId, doc_id: docId, thread_id: threadId } = req.params
  const userId = getLoggedInUserId(req)

  await DocumentUpdaterHandler.promises.deleteThread(
    projectId,
    docId,
    threadId,
    userId
  )
  await ChatApiHandler.promises.deleteThread(projectId, threadId)

  EditorRealTimeController.emitToRoom(projectId, 'delete-thread', threadId)
  res.sendStatus(204)
}

async function deleteMessage(req, res) {
  const { project_id: projectId, message_id: messageId } = req.params
  const userId = getLoggedInUserId(req)

  await ChatApiHandler.promises.deleteGlobalMessage(projectId, messageId)

  EditorRealTimeController.emitToRoom(projectId, 'delete-global-message', {
    messageId,
    userId,
  })
  res.sendStatus(204)
}

async function editComment(req, res) {
  const { project_id: projectId, thread_id: threadId, message_id: messageId } =
    req.params
  const { content } = req.body
  const userId = getLoggedInUserId(req)

  await ChatApiHandler.promises.editMessage(
    projectId,
    threadId,
    messageId,
    userId,
    content
  )

  EditorRealTimeController.emitToRoom(
    projectId,
    'edit-message',
    threadId,
    messageId,
    content
  )
  res.sendStatus(204)
}

async function deleteComment(req, res) {
  const { project_id: projectId, thread_id: threadId, message_id: messageId } =
    req.params

  await ChatApiHandler.promises.deleteMessage(projectId, threadId, messageId)

  EditorRealTimeController.emitToRoom(
    projectId,
    'delete-message',
    threadId,
    messageId
  )
  res.sendStatus(204)
}

async function deleteOwnComment(req, res) {
  const { project_id: projectId, thread_id: threadId, message_id: messageId } =
    req.params
  const userId = getLoggedInUserId(req)

  await ChatApiHandler.promises.deleteUserMessage(
    projectId,
    threadId,
    userId,
    messageId
  )

  EditorRealTimeController.emitToRoom(
    projectId,
    'delete-message',
    threadId,
    messageId
  )
  res.sendStatus(204)
}

async function editMessage(req, res, next) {
  const { project_id: projectId, message_id: messageId } = req.params
  const { content } = req.body
  const userId = getLoggedInUserId(req)

  await ChatApiHandler.promises.editGlobalMessage(
    projectId,
    messageId,
    userId,
    content
  )

  EditorRealTimeController.emitToRoom(projectId, 'edit-global-message', {
    messageId,
    userId,
    content,
  })
  res.sendStatus(204)
}

export default {
  sendMessage: expressify(sendMessage),
  getMessages: expressify(getMessages),
  getThreads: expressify(getThreads),
  sendComment: expressify(sendComment),
  resolveThread: expressify(resolveThread),
  reopenThread: expressify(reopenThread),
  deleteThread: expressify(deleteThread),
  deleteMessage: expressify(deleteMessage),
  editComment: expressify(editComment),
  deleteComment: expressify(deleteComment),
  deleteOwnComment: expressify(deleteOwnComment),
  editMessage: expressify(editMessage),
}
