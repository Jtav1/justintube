import { useContext } from 'react'
import { SiteConfigContext } from './site-config-context.js'

export function useSiteConfig() {
  const context = useContext(SiteConfigContext)
  if (!context) {
    throw new Error('useSiteConfig must be used within a SiteConfigProvider')
  }
  return context
}
