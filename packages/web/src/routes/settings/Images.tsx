import { useTranslation } from 'react-i18next'
import { SettingsSection } from '../../components/settings/ui'
import ImageUploadPanel from '../../components/ImageUploadPanel'

export default function SettingsImages() {
  const { t } = useTranslation()
  return (
    <SettingsSection id="images" title={t('settings.tabs.images')}>
      <ImageUploadPanel />
    </SettingsSection>
  )
}