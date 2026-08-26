import { useTranslation } from 'react-i18next'
import { SettingsSection } from '../../components/settings/ui'
import LocalDataPanel from '../../components/LocalDataPanel'
import StorageLocationsPanel from '../../components/StorageLocationsPanel'
import BackupPanel from '../../components/BackupPanel'
import SyncProtocolPanel from '../../components/SyncProtocolPanel'
import SyncPanel from '../../components/SyncPanel'

export default function SettingsBackup() {
  const { t } = useTranslation()
  return (
    <SettingsSection id="backup" title={t('settings.tabs.backup')}>
      <LocalDataPanel />
      <StorageLocationsPanel />
      <SyncProtocolPanel />
      <BackupPanel />
      <SyncPanel />
    </SettingsSection>
  )
}