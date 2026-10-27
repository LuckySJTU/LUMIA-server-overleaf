import { Project } from '../../models/Project.mjs'
import ProjectGetter from '../Project/ProjectGetter.mjs'
import CollaboratorsHandler from '../Collaborators/CollaboratorsHandler.mjs'
import EditorRealTimeController from '../Editor/EditorRealTimeController.mjs'
import Errors from '../Errors/Errors.js'

async function setState(projectId, userId, changes, canAdmin) {
  const otherUsers = Object.keys(changes.on_for || {}).filter(
    id => id !== userId
  )
  if (
    !canAdmin &&
    (changes.on !== undefined ||
      otherUsers.length > 0 ||
      (userId != null && changes.on_for_guests !== undefined))
  ) {
    throw new Errors.ForbiddenError(
      'cannot change another user tracking mode'
    )
  }

  // Retry against the latest state so simultaneous switches cannot erase peers.
  for (let attempt = 0; attempt < 5; attempt++) {
    const project = await ProjectGetter.promises.getProject(projectId, {
      track_changes: 1,
      reviewer_refs: 1,
    })
    const previous = project.track_changes
    let state
    if (changes.on === true) {
      state = true
    } else {
      state =
        await CollaboratorsHandler.promises.convertTrackChangesToExplicitFormat(
          projectId,
          changes.on === false ? false : previous
        )
      if (previous === true && changes.on !== false) {
        state.__guests__ = true
      }
      Object.assign(state, changes.on_for)
      if (changes.on_for_guests !== undefined) {
        state.__guests__ = changes.on_for_guests
      }
      for (const reviewerId of project.reviewer_refs || []) {
        state[reviewerId.toString()] = true
      }
    }

    const updated = await Project.findOneAndUpdate(
      {
        _id: projectId,
        track_changes:
          previous === undefined ? { $exists: false } : previous,
      },
      { $set: { track_changes: state } },
      { new: true, projection: { track_changes: 1 } }
    ).exec()
    if (updated) {
      EditorRealTimeController.emitToRoom(
        projectId,
        'toggle-track-changes',
        state
      )
      return state
    }
  }
  throw new Error('track changes state changed concurrently; please retry')
}

export default { setState }
