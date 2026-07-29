import { useEffect, useState } from 'react'

const STORAGE_KEY = 'wildfiredashboard-sidebar-collapsed'

export function useSidebarCollapsed() {
  const [collapsed, setCollapsed] = useState<boolean>(() => localStorage.getItem(STORAGE_KEY) === 'true')

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, String(collapsed))
  }, [collapsed])

  const toggle = () => setCollapsed((c) => !c)

  return { collapsed, toggle }
}
