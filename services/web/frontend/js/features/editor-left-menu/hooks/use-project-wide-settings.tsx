import { useCallback } from 'react'
import type { ProjectSettings } from '../utils/api'
import useRootDocId from './use-root-doc-id'
import useSaveProjectSettings from './use-save-project-settings'
import useSetSpellCheckLanguage from './use-set-spell-check-language'
import { saveProjectAdminSettings } from '../utils/api'
import { debugConsole } from '@/utils/debugging'
import { useProjectContext } from '@/shared/context/project-context'

export default function useProjectWideSettings() {
  // The value will be undefined on mount
  const { projectId, project, updateProject } = useProjectContext()
  const saveProjectSettings = useSaveProjectSettings()

  const userWatermarkEnabled = Boolean(project?.userWatermarkEnabled)

  const setCompiler = useCallback(
    async (newCompiler: ProjectSettings['compiler']) => {
      await saveProjectSettings('compiler', newCompiler).catch(
        debugConsole.error
      )
    },
    [saveProjectSettings]
  )

  const setImageName = useCallback(
    async (newImageName: ProjectSettings['imageName']) => {
      await saveProjectSettings('imageName', newImageName).catch(
        debugConsole.error
      )
    },
    [saveProjectSettings]
  )

  const setUserWatermarkEnabled = useCallback(
    async (enabled: boolean) => {
      if (!project || userWatermarkEnabled === enabled) {
        return
      }

      try {
        await saveProjectAdminSettings(projectId, {
          userWatermarkEnabled: enabled,
        })
        updateProject({ userWatermarkEnabled: enabled })
      } catch (err) {
        debugConsole.error(err)
      }
    },
    [project, projectId, updateProject, userWatermarkEnabled]
  )

  const { setRootDocId, rootDocId } = useRootDocId()
  const setSpellCheckLanguage = useSetSpellCheckLanguage()

  return {
    compiler: project?.compiler,
    setCompiler,
    imageName: project?.imageName,
    setImageName,
    rootDocId,
    userWatermarkEnabled,
    setUserWatermarkEnabled,
    setRootDocId,
    spellCheckLanguage: project?.spellCheckLanguage,
    setSpellCheckLanguage,
  }
}
