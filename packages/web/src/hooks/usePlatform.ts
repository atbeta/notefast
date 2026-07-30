import { useState, useEffect } from 'react'

export function usePlatform() {
  const [isMac, setIsMac] = useState(false)
  useEffect(() => {
    setIsMac(/Mac|iPhone|iPad/i.test(navigator.platform))
  }, [])
  return { isMac }
}
