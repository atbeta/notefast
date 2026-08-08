import { useTranslation } from 'react-i18next'
import { SettingsSection } from '../../components/settings/ui'
import AuthEventsPanel from '../../components/AuthEventsPanel'

export default function SettingsSecurity() {
  const { t } = useTranslation()
  return (
    <SettingsSection id="security" title={t('settings.tabs.security')}>
      <AuthEventsPanel />
    </SettingsSection>
  )
}