import { useTranslation } from 'react-i18next'
import { SettingsSection } from '../../components/settings/ui'
import StorageLocationsPanel from '../../components/StorageLocationsPanel'
import BackupPanel from '../../components/BackupPanel'
import SyncProtocolPanel from '../../components/SyncProtocolPanel'
import SyncPanel from '../../components/SyncPanel'

export default function SettingsBackup() {
  const { t } = useTranslation()
  return (
    <SettingsSection id="backup" title={t('settings.tabs.backup')}>
      <StorageLocationsPanel />
      <BackupPanel />
      <SyncProtocolPanel />
      <SyncPanel />
    </SettingsSection>
  )
}