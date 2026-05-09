import { ElementType } from 'react'
import importOverleafModules from '../../../macros/import-overleaf-module.macro'
import { useTranslation } from 'react-i18next'
import RailPanelHeader from '@/features/ide-react/components/rail/rail-panel-header'
import getMeta from '@/utils/meta'
import GitHubSyncPanel from './github-sync-panel'

const integrationPanelComponents = importOverleafModules(
  'integrationPanelComponents'
) as { import: { default: ElementType }; path: string }[]

export default function IntegrationsPanel() {
  const { t } = useTranslation()
  const githubSyncEnabled = getMeta('ol-githubSyncEnabled')

  return (
    <div className="integrations-panel">
      <RailPanelHeader title={t('integrations')} />
      {githubSyncEnabled && <GitHubSyncPanel />}
      {integrationPanelComponents.map(
        ({ import: { default: Component }, path }) => (
          <Component key={path} />
        )
      )}
    </div>
  )
}
