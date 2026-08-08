import { useTranslation } from 'react-i18next'
import { SettingsSection } from '../../components/settings/ui'
import TermDictPanel from '../../components/TermDictPanel'

export default function SettingsTermDict() {
  const { t } = useTranslation()
  return (
    <SettingsSection id="termdict" title={t('settings.tabs.termdict')}>
      <TermDictPanel />
    </SettingsSection>
  )
}