import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import ToggleSetting from '../toggle-setting'
import { useProjectSettingsContext } from '@/features/editor-left-menu/context/project-settings-context'
import { usePermissionsContext } from '@/features/ide-react/context/permissions-context'
import { useUserContext } from '@/shared/context/user-context'

export default function UserWatermarkSetting() {
  const { userWatermarkEnabled, setUserWatermarkEnabled } =
    useProjectSettingsContext()
  const { admin } = usePermissionsContext()
  const user = useUserContext()
  const { t } = useTranslation()
  const canManageWatermark = admin || Boolean(user.isAdmin)

  const changeUserWatermark = useCallback(
    (enabled: boolean) => {
      setUserWatermarkEnabled(enabled)
    },
    [setUserWatermarkEnabled]
  )

  if (!canManageWatermark) {
    return null
  }

  return (
    <ToggleSetting
      id="userWatermarkEnabled"
      label={t('lumia_user_watermark')}
      description={t('lumia_user_watermark_description')}
      checked={Boolean(userWatermarkEnabled)}
      onChange={changeUserWatermark}
      disabled={!canManageWatermark}
    />
  )
}
