import { useTranslation } from 'react-i18next'
import { SettingsSection } from '../../components/settings/ui'
import McpPanel from '../../components/McpPanel'
import ApiTokensPanel from '../../components/ApiTokensPanel'

export default function SettingsTokens() {
  const { t } = useTranslation()
  return (
    <SettingsSection id="tokens" title={t('settings.tabs.tokens')}>
      <McpPanel />
      <ApiTokensPanel />
    </SettingsSection>
  )
}