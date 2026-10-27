import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const PROJECT_ID = '0123456789abcdef01234567'
const USER_ID = '123456789abcdef012345678'
const OTHER_ID = '23456789abcdef0123456789'

describe('TrackChangesManager', () => {
  let manager, project, getProject, updateProject, emitToRoom

  beforeEach(async () => {
    vi.resetModules()
    project = { track_changes: false, reviewer_refs: [] }
    getProject = vi.fn(async () => structuredClone(project))
    updateProject = vi.fn(() => ({ exec: vi.fn().mockResolvedValue({}) }))
    emitToRoom = vi.fn()
    vi.doMock('../../../../app/src/models/Project.mjs', () => ({
      Project: { findOneAndUpdate: updateProject },
    }))
    vi.doMock(
      '../../../../app/src/Features/Project/ProjectGetter.mjs',
      () => ({
        default: { promises: { getProject } },
      })
    )
    vi.doMock(
      '../../../../app/src/Features/Collaborators/CollaboratorsHandler.mjs',
      () => ({
        default: {
          promises: {
            convertTrackChangesToExplicitFormat: vi.fn(
              async (_id, state) =>
                state === true
                  ? { [USER_ID]: true, [OTHER_ID]: true }
                  : { ...(typeof state === 'object' ? state : {}) }
            ),
          },
        },
      })
    )
    vi.doMock(
      '../../../../app/src/Features/Editor/EditorRealTimeController.mjs',
      () => ({ default: { emitToRoom } })
    )
    vi.doMock('../../../../app/src/Features/Errors/Errors.js', () => ({
      default: { ForbiddenError: class ForbiddenError extends Error {} },
    }))
    manager = (
      await import(
        '../../../../app/src/Features/TrackChanges/TrackChangesManager.mjs'
      )
    ).default
  })

  afterEach(() => vi.resetModules())

  it('saves and broadcasts the current user review mode', async () => {
    const state = await manager.setState(
      PROJECT_ID,
      USER_ID,
      { on_for: { [USER_ID]: true } },
      false
    )
    expect(state).toEqual({ [USER_ID]: true })
    expect(updateProject).toHaveBeenCalledWith(
      { _id: PROJECT_ID, track_changes: false },
      { $set: { track_changes: state } },
      { new: true, projection: { track_changes: 1 } }
    )
    expect(emitToRoom).toHaveBeenCalledWith(
      PROJECT_ID,
      'toggle-track-changes',
      state
    )
  })

  it('switches back to editing without losing peer settings', async () => {
    project.track_changes = { [USER_ID]: true, [OTHER_ID]: true }
    expect(
      await manager.setState(
        PROJECT_ID,
        USER_ID,
        { on_for: { [USER_ID]: false } },
        false
      )
    ).toEqual({ [USER_ID]: false, [OTHER_ID]: true })
  })

  it('preserves legacy global tracking for peers and guests', async () => {
    project.track_changes = true
    expect(
      await manager.setState(
        PROJECT_ID,
        USER_ID,
        { on_for: { [USER_ID]: false } },
        false
      )
    ).toEqual({ [USER_ID]: false, [OTHER_ID]: true, __guests__: true })
  })

  it.each([undefined, null])('handles legacy state %s', async previous => {
    project.track_changes = previous
    await manager.setState(
      PROJECT_ID,
      USER_ID,
      { on_for: { [USER_ID]: true } },
      false
    )
    expect(updateProject.mock.calls[0][0].track_changes).toEqual(
      previous === undefined ? { $exists: false } : previous
    )
  })

  it.each([
    { on: true },
    { on: false },
    { on_for_guests: true },
    { on_for: { [OTHER_ID]: true } },
  ])('prevents an editor changing other users: %j', async changes => {
    await expect(
      manager.setState(PROJECT_ID, USER_ID, changes, false)
    ).rejects.toThrow('cannot change another user')
    expect(updateProject).not.toHaveBeenCalled()
    expect(emitToRoom).not.toHaveBeenCalled()
  })

  it('allows a project administrator to change other users', async () => {
    expect(
      await manager.setState(
        PROJECT_ID,
        USER_ID,
        { on_for: { [OTHER_ID]: true } },
        true
      )
    ).toEqual({ [OTHER_ID]: true })
  })

  it('keeps reviewers in review mode when tracking is disabled', async () => {
    project.track_changes = true
    project.reviewer_refs = [OTHER_ID]
    expect(
      await manager.setState(PROJECT_ID, USER_ID, { on: false }, true)
    ).toEqual({ [OTHER_ID]: true })
  })

  it('supports the shared guest mode for an authorized anonymous writer', async () => {
    expect(
      await manager.setState(
        PROJECT_ID,
        undefined,
        { on_for_guests: true },
        false
      )
    ).toEqual({ __guests__: true })
  })

  it('retries with the latest peer settings on a concurrent update', async () => {
    updateProject.mockImplementationOnce(() => ({
      exec: async () => {
        project.track_changes = { [OTHER_ID]: true }
        return null
      },
    }))
    expect(
      await manager.setState(
        PROJECT_ID,
        USER_ID,
        { on_for: { [USER_ID]: true } },
        false
      )
    ).toEqual({ [OTHER_ID]: true, [USER_ID]: true })
    expect(updateProject).toHaveBeenCalledTimes(2)
    expect(emitToRoom).toHaveBeenCalledTimes(1)
  })

  it('does not broadcast a state that could not be saved', async () => {
    updateProject.mockImplementation(() => ({
      exec: vi.fn().mockResolvedValue(null),
    }))
    await expect(
      manager.setState(
        PROJECT_ID,
        USER_ID,
        { on_for: { [USER_ID]: true } },
        false
      )
    ).rejects.toThrow('changed concurrently')
    expect(updateProject).toHaveBeenCalledTimes(5)
    expect(emitToRoom).not.toHaveBeenCalled()
  })
})
