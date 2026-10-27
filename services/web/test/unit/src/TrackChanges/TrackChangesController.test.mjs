import { beforeEach, describe, expect, it, vi } from 'vitest'

const PROJECT_ID = '0123456789abcdef01234567'
const USER_ID = '123456789abcdef012345678'
const DOC_ID = '23456789abcdef0123456789'

describe('TrackChangesController', () => {
  let controller,
    manager,
    updater,
    docstore,
    locator,
    emitToRoom,
    req,
    res,
    next
  let sessionManager
  let userGetter

  beforeEach(async () => {
    vi.resetModules()
    vi.doUnmock(
      '../../../../app/src/Features/TrackChanges/TrackChangesController.mjs'
    )
    manager = { setState: vi.fn().mockResolvedValue({ [USER_ID]: true }) }
    updater = {
      promises: {
        getProjectRanges: vi.fn().mockResolvedValue([]),
        acceptChanges: vi.fn().mockResolvedValue(undefined),
      },
    }
    docstore = {
      promises: { getAllRanges: vi.fn().mockResolvedValue([]) },
    }
    locator = { promises: { findElement: vi.fn().mockResolvedValue({}) } }
    emitToRoom = vi.fn()
    sessionManager = {
      getLoggedInUserId: vi.fn().mockReturnValue(USER_ID),
    }
    userGetter = { promises: { getUsers: vi.fn().mockResolvedValue([]) } }
    vi.doMock('../../../../app/src/Features/User/UserGetter.mjs', () => ({
      default: userGetter,
    }))
    vi.doMock(
      '../../../../app/src/Features/User/UserInfoController.mjs',
      () => ({
        default: {
          formatPersonalInfo: user => ({
            id: user._id,
            email: user.email,
          }),
        },
      })
    )
    vi.doMock(
      '../../../../app/src/Features/Authentication/SessionManager.mjs',
      () => ({
        default: sessionManager,
      })
    )
    vi.doMock(
      '../../../../app/src/Features/Authorization/AuthorizationManager.mjs',
      () => ({
        default: {
          promises: {
            canUserAdminProject: vi.fn().mockResolvedValue(false),
          },
        },
      })
    )
    vi.doMock(
      '../../../../app/src/Features/TokenAccess/TokenAccessHandler.mjs',
      () => ({
        default: {
          getRequestToken: vi.fn().mockReturnValue('access-token'),
        },
      })
    )
    vi.doMock(
      '../../../../app/src/Features/Project/ProjectLocator.mjs',
      () => ({
        default: locator,
      })
    )
    vi.doMock(
      '../../../../app/src/Features/Docstore/DocstoreManager.mjs',
      () => ({
        default: docstore,
      })
    )
    vi.doMock(
      '../../../../app/src/Features/DocumentUpdater/DocumentUpdaterHandler.mjs',
      () => ({
        default: updater,
      })
    )
    vi.doMock(
      '../../../../app/src/Features/Editor/EditorRealTimeController.mjs',
      () => ({
        default: { emitToRoom },
      })
    )
    vi.doMock(
      '../../../../app/src/Features/TrackChanges/TrackChangesManager.mjs',
      () => ({
        default: manager,
      })
    )
    vi.doMock('../../../../app/src/Features/Errors/Errors.js', () => ({
      NotFoundError: class NotFoundError extends Error {},
    }))
    controller = (
      await import(
        '../../../../app/src/Features/TrackChanges/TrackChangesController.mjs'
      )
    ).default
    req = {
      params: { Project_id: PROJECT_ID, doc_id: DOC_ID },
      session: {},
      body: { on_for: { [USER_ID]: true } },
    }
    res = { json: vi.fn(), sendStatus: vi.fn() }
    next = vi.fn()
  })

  it('validates the request and returns the saved mode to the caller', async () => {
    await controller.setState(req, res, next)
    expect(next).not.toHaveBeenCalled()
    expect(manager.setState).toHaveBeenCalledWith(
      PROJECT_ID,
      USER_ID,
      { on_for: { [USER_ID]: true } },
      false
    )
    expect(res.json).toHaveBeenCalledWith({
      trackChangesState: { [USER_ID]: true },
    })
  })

  it('passes anonymous guest changes through the same project authorization', async () => {
    sessionManager.getLoggedInUserId.mockReturnValue(null)
    req.body = { on_for_guests: true }
    await controller.setState(req, res, next)
    expect(next).not.toHaveBeenCalled()
    expect(manager.setState).toHaveBeenCalledWith(
      PROJECT_ID,
      undefined,
      { on_for_guests: true },
      false
    )
  })

  it.each([
    {},
    { on: 'true' },
    { on_for: {} },
    { on_for: { invalid: true } },
    { on_for: { [USER_ID]: 'true' } },
    { on_for: { '$set.mode': true } },
    { on: true, on_for_guests: false },
    { on_for_guests: 1 },
    { unexpected: true },
  ])('rejects invalid mode requests: %j', async body => {
    req.body = body
    await controller.setState(req, res, next)
    expect(next).toHaveBeenCalledWith(expect.any(Error))
    expect(manager.setState).not.toHaveBeenCalled()
    expect(res.json).not.toHaveBeenCalled()
  })

  it('merges persisted ranges with newer in-memory document ranges', async () => {
    const saved = { changes: [{ id: 'old-change' }], comments: [] }
    const current = { changes: [{ id: 'new-change' }], comments: [] }
    docstore.promises.getAllRanges.mockResolvedValue([
      { _id: DOC_ID, ranges: saved },
      { _id: 'stored-only', ranges: saved },
    ])
    updater.promises.getProjectRanges.mockResolvedValue([
      { id: DOC_ID, ranges: current },
    ])
    await controller.getRanges(req, res, next)
    expect(next).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith([
      { id: DOC_ID, ranges: current },
      { id: 'stored-only', ranges: saved },
    ])
  })

  it('accepts changes only after checking document membership and broadcasts them', async () => {
    req.body = { change_ids: ['change-1', 'change-2'] }
    await controller.acceptChanges(req, res, next)
    expect(next).not.toHaveBeenCalled()
    expect(locator.promises.findElement).toHaveBeenCalledWith({
      project_id: PROJECT_ID,
      element_id: DOC_ID,
      type: 'doc',
    })
    expect(updater.promises.acceptChanges).toHaveBeenCalledWith(
      PROJECT_ID,
      DOC_ID,
      ['change-1', 'change-2'],
      USER_ID
    )
    expect(emitToRoom).toHaveBeenCalledWith(
      PROJECT_ID,
      'accept-changes',
      DOC_ID,
      ['change-1', 'change-2']
    )
    expect(res.sendStatus).toHaveBeenCalledWith(204)
  })

  it('keeps persisted ranges when a document leaves the cache during the read', async () => {
    const saved = { changes: [{ id: 'saved-change' }], comments: [] }
    docstore.promises.getAllRanges.mockResolvedValue([
      { _id: DOC_ID, ranges: saved },
      { _id: 'new-document' },
    ])
    updater.promises.getProjectRanges.mockResolvedValue([
      { id: DOC_ID, ranges: null },
    ])
    await controller.getRanges(req, res, next)
    expect(next).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith([
      { id: DOC_ID, ranges: saved },
      { id: 'new-document', ranges: { changes: [], comments: [] } },
    ])
  })

  it('returns only authors referenced by this project, ignoring guest and invalid IDs', async () => {
    docstore.promises.getAllRanges.mockResolvedValue([
      {
        _id: DOC_ID,
        ranges: {
          changes: [
            { op: { u: USER_ID } },
            { op: { u: USER_ID } },
            { op: { u: 'anonymous' } },
            { op: {} },
          ],
        },
      },
    ])
    userGetter.promises.getUsers.mockResolvedValue([
      {
        _id: USER_ID,
        email: 'author@example.com',
        password: 'not-exposed',
      },
    ])
    await controller.getUsers(req, res, next)
    expect(next).not.toHaveBeenCalled()
    expect(userGetter.promises.getUsers).toHaveBeenCalledWith(
      new Set([USER_ID]),
      { _id: true, first_name: true, last_name: true, email: true }
    )
    expect(res.json).toHaveBeenCalledWith([
      { id: USER_ID, email: 'author@example.com' },
    ])
  })

  it('returns an empty author list without querying users for a new project', async () => {
    await controller.getUsers(req, res, next)
    expect(next).not.toHaveBeenCalled()
    expect(userGetter.promises.getUsers).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith([])
  })

  it('does not operate on a document from another project', async () => {
    locator.promises.findElement.mockRejectedValue(
      new Error('document not found')
    )
    req.body = { change_ids: ['change-1'] }
    await controller.acceptChanges(req, res, next)
    expect(next).toHaveBeenCalledWith(expect.any(Error))
    expect(updater.promises.acceptChanges).not.toHaveBeenCalled()
    expect(emitToRoom).not.toHaveBeenCalled()
  })

  it.each([{}, { change_ids: [] }, { change_ids: [1] }])(
    'rejects invalid acceptance requests: %j',
    async body => {
      req.body = body
      await controller.acceptChanges(req, res, next)
      expect(next).toHaveBeenCalledWith(expect.any(Error))
      expect(updater.promises.acceptChanges).not.toHaveBeenCalled()
    }
  )
})
