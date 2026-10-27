import { expressify } from '@overleaf/promise-utils'
import { z, zz, parseReq } from '../../infrastructure/Validation.mjs'
import SessionManager from '../Authentication/SessionManager.mjs'
import AuthorizationManager from '../Authorization/AuthorizationManager.mjs'
import TokenAccessHandler from '../TokenAccess/TokenAccessHandler.mjs'
import UserGetter from '../User/UserGetter.mjs'
import UserInfoController from '../User/UserInfoController.mjs'
import ProjectLocator from '../Project/ProjectLocator.mjs'
import DocstoreManager from '../Docstore/DocstoreManager.mjs'
import DocumentUpdaterHandler from '../DocumentUpdater/DocumentUpdaterHandler.mjs'
import EditorRealTimeController from '../Editor/EditorRealTimeController.mjs'
import TrackChangesManager from './TrackChangesManager.mjs'

const projectParams = z.object({ Project_id: zz.objectId() })
const stateSchema = z.object({
  params: projectParams,
  body: z
    .object({
      on: z.boolean().optional(),
      on_for: z
        .record(z.string().regex(/^[a-f0-9]{24}$/i), z.boolean())
        .refine(value => Object.keys(value).length > 0)
        .optional(),
      on_for_guests: z.boolean().optional(),
    })
    .strict()
    .refine(value => Object.keys(value).length === 1),
})
const acceptSchema = z.object({
  params: projectParams.extend({ doc_id: zz.objectId() }),
  body: z.object({
    change_ids: z.array(z.string().min(1).max(256)).min(1).max(10000),
  }),
})

async function setState(req, res) {
  const { params, body } = parseReq(req, stateSchema)
  const projectId = params.Project_id
  const userId = SessionManager.getLoggedInUserId(req.session)?.toString()
  const token = TokenAccessHandler.getRequestToken(req, projectId)
  const canAdmin = await AuthorizationManager.promises.canUserAdminProject(
    userId,
    projectId,
    token
  )
  const state = await TrackChangesManager.setState(
    projectId,
    userId,
    body,
    canAdmin
  )
  res.json({ trackChangesState: state })
}

async function getRanges(req, res) {
  const { params } = parseReq(req, z.object({ params: projectParams }))
  const ranges = await getProjectRanges(params.Project_id)
  res.json(Array.from(ranges, ([id, ranges]) => ({ id, ranges })))
}

async function getUsers(req, res) {
  const { params } = parseReq(req, z.object({ params: projectParams }))
  const ranges = await getProjectRanges(params.Project_id)
  const userIds = new Set()
  for (const range of ranges.values()) {
    for (const change of range?.changes || []) {
      if (zz.objectId().safeParse(change.op?.u).success) {
        userIds.add(change.op.u)
      }
    }
  }
  const users = userIds.size
    ? await UserGetter.promises.getUsers(userIds, {
        _id: true,
        first_name: true,
        last_name: true,
        email: true,
      })
    : []
  res.json(users.map(user => UserInfoController.formatPersonalInfo(user)))
}

async function getProjectRanges(projectId) {
  const ranges = new Map()
  for (const doc of await DocstoreManager.promises.getAllRanges(
    projectId
  )) {
    ranges.set(
      doc._id.toString(),
      doc.ranges || { changes: [], comments: [] }
    )
  }
  for (const doc of await DocumentUpdaterHandler.promises.getProjectRanges(
    projectId
  )) {
    if (doc.ranges) {
      ranges.set(doc.id, doc.ranges)
    }
  }
  return ranges
}

async function acceptChanges(req, res) {
  const { params, body } = parseReq(req, acceptSchema)
  const projectId = params.Project_id
  const docId = params.doc_id
  const userId = SessionManager.getLoggedInUserId(req.session)
  await ProjectLocator.promises.findElement({
    project_id: projectId,
    element_id: docId,
    type: 'doc',
  })
  await DocumentUpdaterHandler.promises.acceptChanges(
    projectId,
    docId,
    body.change_ids,
    userId
  )
  EditorRealTimeController.emitToRoom(
    projectId.toString(),
    'accept-changes',
    docId.toString(),
    body.change_ids
  )
  res.sendStatus(204)
}

export default {
  setState: expressify(setState),
  getRanges: expressify(getRanges),
  getUsers: expressify(getUsers),
  acceptChanges: expressify(acceptChanges),
}
