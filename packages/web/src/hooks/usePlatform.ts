import { useState } from 'react'
import { isMacPlatform } from '../lib/shortcutDisplay'

export function usePlatform() {
  const [isMac] = useState(() => isMacPlatform())
  return { isMac }
}
