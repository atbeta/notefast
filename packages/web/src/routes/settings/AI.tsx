import { useTranslation } from 'react-i18next'
import { SettingsSection } from '../../components/settings/ui'
import AISettingsPanel from '../../components/ai-settings/AISettingsPanel'

export default function SettingsAI() {
  const { t } = useTranslation()
  return (
    <SettingsSection id="ai" title={t('settings.tabs.ai')}>
      <AISettingsPanel />
    </SettingsSection>
  )
}